import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    isJidBroadcast,
    Browsers
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import chalk from 'chalk';
import NodeCache from 'node-cache';
import readline from 'readline';
import { handleMessage } from './handler.js';
import { BOT_CONFIG } from './lib/config.js';

const msgRetryCounterCache = new NodeCache();
const msgCache = new NodeCache({ stdTTL: 120 });
const logger = pino({ level: BOT_CONFIG.logLevel }).child({ class: 'baileys' });

// Versión de WA cacheada para evitar versiones inconsistentes entre reconexiones
let waVersion = null;

// Método elegido persiste en memoria para no volver a preguntar en reconexiones
let metodoElegido = null;
let numeroGuardado = '';

let reconectando = false;
let intentosReconexion = 0;

function pregunta(prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(prompt, ans => { rl.close(); resolve(ans.trim()); }));
}

function limpiarNumero(n) {
    return n.replace(/[^0-9]/g, '');
}

function delayReconexion() {
    // Backoff exponencial: 3s, 5s, 10s, 15s, 20s (máximo)
    const delays = [3000, 5000, 10000, 15000, 20000];
    return delays[Math.min(intentosReconexion, delays.length - 1)];
}

function reconectar() {
    if (reconectando) return;
    reconectando = true;
    intentosReconexion++;
    const delay = delayReconexion();
    console.log(chalk.yellow(`  ↻ Reconectando en ${delay / 1000}s... (intento #${intentosReconexion})`));
    setTimeout(() => {
        reconectando = false;
        startBot();
    }, delay);
}

export async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState('./session');

    // Obtener versión de WA solo una vez; reutilizarla en reconexiones
    if (!waVersion) {
        const { version, isLatest } = await fetchLatestBaileysVersion();
        waVersion = version;
        console.log(chalk.cyan(`\n  WA v${version.join('.')} ${isLatest ? chalk.green('✓') : chalk.yellow('⚠ actualiza baileys')}`));
    } else {
        console.log(chalk.cyan(`\n  WA v${waVersion.join('.')} (cacheada)`));
    }

    const necesitaVincular = !state.creds.registered;

    // Pide método solo si no hay sesión y es la primera vez
    if (necesitaVincular && metodoElegido === null) {
        const resp = await pregunta(
            chalk.yellowBright('\n  ¿Cómo quieres conectarte?\n') +
            chalk.white('  [1] ') + chalk.green('Código QR') + chalk.gray(' (escanear con cámara)\n') +
            chalk.white('  [2] ') + chalk.cyan('Código de 8 dígitos') + chalk.gray(' (sin cámara)\n') +
            chalk.gray('\n  Elige [1/2]: ')
        );

        metodoElegido = resp === '2' ? 'codigo' : 'qr';

        if (metodoElegido === 'codigo') {
            numeroGuardado = await pregunta(
                chalk.yellowBright('\n  Número con código de país (sin + ni espacios)\n') +
                chalk.gray('  Ej: 521XXXXXXXXXX (México), 591XXXXXXXX (Bolivia)\n') +
                chalk.gray('\n  Número: ')
            );
            numeroGuardado = limpiarNumero(numeroGuardado);
            if (!numeroGuardado) {
                console.log(chalk.red('  Número inválido. Reinicia e intenta de nuevo.'));
                process.exit(1);
            }
        }
        console.log('');
    } else if (!necesitaVincular) {
        console.log(chalk.cyan('  Sesión encontrada, reconectando automáticamente...\n'));
    }

    const usarCodigo = metodoElegido === 'codigo';

    const sock = makeWASocket({
        version: waVersion,
        logger,
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger)
        },
        browser: usarCodigo ? Browsers.ubuntu('Chrome') : Browsers.macOS('Chrome'),
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        keepAliveIntervalMs: 30_000,
        connectTimeoutMs: 60_000,
        retryRequestDelayMs: 500,
        maxMsgRetryCount: 5,
        syncFullHistory: false,
        shouldIgnoreJid: jid => isJidBroadcast(jid),
        getMessage: async (key) => {
            const cached = msgCache.get(key.id);
            return cached || { conversation: '' };
        }
    });

    if (usarCodigo && necesitaVincular) {
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(numeroGuardado);
                const fmt = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log(chalk.yellowBright('\n  ╔════════════════════════════════════╗'));
                console.log(chalk.yellowBright('  ║    TU CÓDIGO DE 8 DÍGITOS ES:      ║'));
                console.log(chalk.yellowBright('  ║                                    ║'));
                console.log(chalk.yellowBright('  ║        ') + chalk.whiteBright.bold(fmt) + chalk.yellowBright('        ║'));
                console.log(chalk.yellowBright('  ║                                    ║'));
                console.log(chalk.yellowBright('  ╚════════════════════════════════════╝'));
                console.log(chalk.gray('\n  WhatsApp → Dispositivos vinculados → Vincular con número de teléfono'));
                console.log(chalk.gray('  Ingresa el código de arriba.\n'));
            } catch (err) {
                console.log(chalk.red('\n  ✗ Error al obtener el código: ' + err.message));
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
        if (qr && !usarCodigo) {
            console.log(chalk.yellowBright('\n  ╔══════════════════════════════════╗'));
            console.log(chalk.yellowBright('  ║     ESCANEA EL QR CON TU WA     ║'));
            console.log(chalk.yellowBright('  ╚══════════════════════════════════╝\n'));
            qrcode.generate(qr, { small: true });
            console.log(chalk.gray('\n  WhatsApp → Dispositivos vinculados → Vincular dispositivo\n'));
        }

        if (connection === 'close') {
            const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
            console.log(chalk.red(`\n  ✗ Conexión cerrada. Código: ${statusCode}`));

            switch (statusCode) {
                case DisconnectReason.badSession:
                    console.log(chalk.yellow('  Error de sesión temporal — reconectando sin borrar sesión...'));
                    reconectar();
                    break;

                case DisconnectReason.loggedOut:
                    console.log(chalk.yellow('  Desconectado por WhatsApp — reconectando...'));
                    reconectar();
                    break;

                case DisconnectReason.connectionReplaced:
                    console.log(chalk.red('  Sesión reemplazada por otra instancia. Deteniéndose.'));
                    process.exit(1);
                    break;

                case DisconnectReason.restartRequired:
                    console.log(chalk.yellow('  Reinicio requerido por WhatsApp — refrescando versión...'));
                    waVersion = null; // forzar re-fetch de versión WA
                    reconectar();
                    break;

                case DisconnectReason.timedOut:
                    console.log(chalk.yellow('  Tiempo agotado — reconectando...'));
                    reconectar();
                    break;

                case DisconnectReason.connectionLost:
                    console.log(chalk.yellow('  Conexión perdida — reconectando...'));
                    reconectar();
                    break;

                default:
                    console.log(chalk.yellow(`  Desconexión inesperada (${statusCode}) — reconectando...`));
                    reconectar();
            }
        }

        if (connection === 'open') {
            reconectando = false;
            intentosReconexion = 0; // resetear contador de intentos al conectar exitosamente
            const user = sock.user;
            console.log(chalk.greenBright('\n  ╔══════════════════════════════════╗'));
            console.log(chalk.greenBright('  ║       ✓ CONECTADO CON ÉXITO      ║'));
            console.log(chalk.greenBright('  ╚══════════════════════════════════╝'));
            console.log(chalk.green(`\n  Número : ${chalk.white(user?.id?.split(':')[0] ?? 'desconocido')}`));
            console.log(chalk.green(`  Nombre : ${chalk.white(user?.name ?? 'desconocido')}`));
            console.log(chalk.green(`  Prefijo : ${chalk.white(BOT_CONFIG.prefix)}`));
            console.log(chalk.green(`  Bot listo. Escuchando mensajes...\n`));
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        for (const msg of messages) {
            if (!msg.message) continue;
            if (msg.key?.id) msgCache.set(msg.key.id, msg.message);
            if (msg.key.fromMe && !BOT_CONFIG.selfReply) continue;
            await handleMessage(sock, msg);
        }
    });

    return sock;
}
