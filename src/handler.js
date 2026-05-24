import chalk from 'chalk';
import { BOT_CONFIG } from './lib/config.js';
import { getMessageText, getJid, isGroup, getSenderInfo } from './lib/utils.js';
import { loadCommands } from './commands/index.js';
import { get, getStickerHash } from './lib/stickerDB.js';

const commands = await loadCommands();

// ── Protección anti-replay: ignorar mensajes anteriores al arranque ───────────
const BOT_START_TIME  = Math.floor(Date.now() / 1000); // en segundos como WA timestamps
const processedMsgIds = new Set();

// ── Filtro de logs internos de Baileys / libsignal ────────────────────────────
const NOISE_PATTERNS = [
    'Closing open session',
    'Closing session:',
    'SessionEntry',
    '_chains',
    'registrationId',
    'currentRatchet',
    'indexInfo',
    'Failed to decrypt',
    'Session error:',
    'MessageCounterError',
    'Bad MAC',
    'libsignal',
    'session_cipher',
    'queue_job',
    'prekey bundle',
    'ephemeralKeyPair',
    'lastRemoteEphemeralKey',
    'remoteIdentityKey',
    'baseKeyType',
];

function isNoise(args) {
    const str = args.map(a => String(a ?? '')).join(' ');
    return NOISE_PATTERNS.some(p => str.includes(p));
}

const _log  = console.log.bind(console);
const _warn = console.warn.bind(console);
const _err  = console.error.bind(console);

console.log   = (...a) => { if (!isNoise(a)) _log(...a); };
console.warn  = (...a) => { if (!isNoise(a)) _warn(...a); };
console.error = (...a) => { if (!isNoise(a)) _err(...a); };
// ─────────────────────────────────────────────────────────────────────────────

function timestamp() {
    const now = new Date();
    return chalk.gray(
        `[${String(now.getHours()).padStart(2,'0')}:` +
        `${String(now.getMinutes()).padStart(2,'0')}:` +
        `${String(now.getSeconds()).padStart(2,'0')}]`
    );
}

export async function handleMessage(sock, msg) {
    // ── Ignorar mensajes viejos y duplicados ──────────────────────────────────
    const msgId        = msg.key?.id;
    const msgTimestamp = Number(msg.messageTimestamp) || 0;

    // Mensaje anterior al arranque del bot → ignorar (replay al reconectar)
    if (msgTimestamp && msgTimestamp < BOT_START_TIME) return;

    // Mensaje ya procesado → ignorar (duplicados)
    if (msgId) {
        if (processedMsgIds.has(msgId)) return;
        processedMsgIds.add(msgId);
        // Limpiar el Set cada 5000 entradas para no acumular memoria
        if (processedMsgIds.size > 5000) processedMsgIds.clear();
    }
    // ─────────────────────────────────────────────────────────────────────────

    const jid        = getJid(msg);
    const isGroupMsg = isGroup(jid);
    const pushName   = msg.pushName || 'Usuario';
    const prefix     = BOT_CONFIG.prefix;

    const { jid: senderJid, numero, esLid } = getSenderInfo(msg);

    // ── Sticker trigger (antes del check de body) ─────────────────────────────
    const stickerMsg = msg.message?.stickerMessage;
    if (stickerMsg) {
        const hash = getStickerHash(stickerMsg);
        if (hash) {
            const trigger = get(hash);
            if (trigger) {
                const triggerText = trigger.text.trim();
                process.stdout.write(`  [sticker-trigger] ejecutando → "${triggerText}"\n`);

                const isCmd = triggerText.startsWith(prefix);
                if (isCmd) {
                    // Ejecutar como comando interno sin mostrar nada
                    const [rawCmd, ...cmdArgs] = triggerText.slice(prefix.length).trim().split(/\s+/);
                    const cmdName = rawCmd?.toLowerCase();
                    const command = commands.get(cmdName);
                    if (command) {
                        try {
                            let grupNombre = '';
                            if (isGroupMsg) {
                                try { const meta = await sock.groupMetadata(jid); grupNombre = meta.subject || ''; } catch { }
                            }
                            await command.run({
                                sock, msg, jid,
                                sender: senderJid,
                                numero, esLid,
                                args: cmdArgs,
                                body: triggerText,
                                prefix, pushName,
                                isGroup: isGroupMsg,
                                grupNombre,
                                quoted: msg,
                                commands
                            });
                        } catch (err) {
                            process.stdout.write(`  [sticker-trigger] error: ${err.message}\n`);
                        }
                    }
                } else {
                    // Si no es comando, enviar el texto tal cual
                    await sock.sendMessage(jid, { text: triggerText }, { quoted: msg });
                }
                return;
            }
        }
    }
    // ─────────────────────────────────────────────────────────────────────────

    const body = getMessageText(msg);
    if (!body) return;

    const isCmd = body.startsWith(prefix);
    const [rawCmd, ...args] = body.slice(isCmd ? prefix.length : 0).trim().split(/\s+/);
    const cmdName = rawCmd?.toLowerCase();

    // ── Logger ────────────────────────────────────────────────────────────────
    let grupNombre = '';
    if (isGroupMsg) {
        try {
            const meta = await sock.groupMetadata(jid);
            grupNombre = meta.subject || '';
        } catch { }
    }

    const tipoTag  = isGroupMsg
        ? chalk.bgMagenta.black(' GRUPO ')
        : chalk.bgCyan.black('  DM   ');

    const numDisplay = esLid || !numero
        ? chalk.gray('(privado)')
        : chalk.gray(`(+${numero})`);

    const nombreTag = chalk.yellow.bold(pushName);

    console.log('');
    console.log(`  ${timestamp()} ${tipoTag} ${nombreTag} ${numDisplay}`);

    if (isGroupMsg && grupNombre) {
        console.log(`  ${chalk.gray('│')} ${chalk.gray('Grupo  :')} ${chalk.white(grupNombre)}`);
    }

    if (isCmd && cmdName) {
        const argsStr = args.length ? chalk.gray(' ' + args.slice(0,5).join(' ')) : '';
        console.log(`  ${chalk.gray('│')} ${chalk.gray('Comando:')} ${chalk.greenBright(prefix + cmdName)}${argsStr}`);
    } else {
        const preview = body.length > 80 ? body.slice(0, 80) + '…' : body;
        console.log(`  ${chalk.gray('│')} ${chalk.gray('Mensaje:')} ${chalk.white(preview)}`);
    }
    // ─────────────────────────────────────────────────────────────────────────

    if (!isCmd || !cmdName) return;

    const command = commands.get(cmdName);

    if (!command) {
        if (BOT_CONFIG.showNotFound) {
            await sock.sendMessage(jid, {
                text: `❌ Comando *${prefix}${cmdName}* no encontrado.\nUsa *${prefix}menu* para ver los comandos.`
            }, { quoted: msg });
        }
        return;
    }

    if (command.groupOnly && !isGroupMsg) {
        await sock.sendMessage(jid, { text: '❌ Este comando solo funciona en grupos.' }, { quoted: msg });
        return;
    }
    if (command.privateOnly && isGroupMsg) {
        await sock.sendMessage(jid, { text: '❌ Este comando solo funciona en privado.' }, { quoted: msg });
        return;
    }

    try {
        await command.run({
            sock, msg, jid,
            sender: senderJid,
            numero, esLid,
            args, body, prefix,
            pushName,
            isGroup: isGroupMsg,
            grupNombre,
            quoted: msg,
            commands
        });
    } catch (err) {
        console.log(`  ${chalk.bgRed.white(' ERROR ')} ${chalk.red(prefix + cmdName)} → ${chalk.gray(err.message)}`);
        await sock.sendMessage(jid, { text: `❌ Error: _${err.message}_` }, { quoted: msg });
    }
}
