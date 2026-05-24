import { spawn } from 'child_process';
import {
    readFileSync,
    unlinkSync,
    existsSync,
    readdirSync,
    mkdirSync,
    accessSync,
    constants
} from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR  = resolve(__dirname, '../..');

const COOKIES = process.env.YT_COOKIES  || resolve(ROOT_DIR, 'cookies/youtube_cookies.txt');
const TMP_DIR  = process.env.YT_TMP_DIR || resolve(ROOT_DIR, 'tmp');

const MAX_SIZE_MB  = 50;
const TIMEOUT_MS   = 120_000; // 2 min máximo

function canRun(file) {
    try { return !!file && existsSync(file) && (accessSync(file, constants.X_OK), true); }
    catch { return false; }
}

function pickBin(envName, names) {
    const envValue = process.env[envName];
    if (canRun(envValue)) return envValue;
    for (const name of names) {
        const check = spawnSync('which', [name], { encoding: 'utf8' });
        const found = check.stdout?.trim().split('\n')[0];
        if (found && canRun(found)) return found;
    }
    return names[0];
}

// spawnSync solo para buscar binarios una vez al arrancar
import { spawnSync } from 'child_process';
const YTDLP  = pickBin('YT_DLP_PATH',  ['yt-dlp']);
const DENO   = pickBin('DENO_PATH',    ['deno']);
const FFMPEG = pickBin('FFMPEG_PATH',  ['ffmpeg']);

// ── Spawn async con timeout ────────────────────────────────────────────────────
function spawnAsync(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const proc  = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout  = '';
        let stderr  = '';

        proc.stdout.on('data', d => { stdout += d; });
        proc.stderr.on('data', d => { stderr += d; });

        const timer = setTimeout(() => {
            proc.kill('SIGKILL');
            reject(new Error(`Tiempo límite (${TIMEOUT_MS / 1000}s) agotado al descargar`));
        }, TIMEOUT_MS);

        proc.on('close', code => {
            clearTimeout(timer);
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error((stderr || stdout || `yt-dlp código ${code}`).slice(0, 800)));
        });

        proc.on('error', err => { clearTimeout(timer); reject(err); });
    });
}

export async function downloadYTVideo(videoUrl) {
    if (!existsSync(COOKIES)) {
        throw new Error(`Archivo de cookies no encontrado: ${COOKIES}`);
    }

    mkdirSync(TMP_DIR, { recursive: true });

    const stamp          = `ytbot_vid_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const outputTemplate = join(TMP_DIR, `${stamp}.mp4`);

    process.stdout.write(`  [play2] Descargando video con yt-dlp...\n`);

    await spawnAsync(YTDLP, [
        // Preferir H.264 directo; si no existe, bajar lo mejor y re-codificar
        '-f', 'bestvideo[vcodec~="^avc"][height<=720]+bestaudio/bestvideo[height<=720]+bestaudio/best[height<=720]/best',
        '--merge-output-format', 'mp4',
        '--match-filter', 'duration <= 600',   // máx 10 min
        // Re-codificar siempre a H.264 + AAC para garantizar compatibilidad WhatsApp
        '--recode-video', 'mp4',
        '--postprocessor-args', 'ffmpeg:-c:v libx264 -c:a aac -pix_fmt yuv420p -movflags +faststart -preset fast -crf 28',
        '-o', outputTemplate,
        '--no-playlist',
        '--no-check-certificates',
        '--cookies', COOKIES,
        '--js-runtimes', `deno:${DENO}`,
        '--remote-components', 'ejs:github',
        '--ffmpeg-location', FFMPEG,
        videoUrl
    ], {
        env: {
            ...process.env,
            PATH: [
                '/usr/local/bin', '/usr/bin', '/bin',
                `${process.env.HOME || ''}/.deno/bin`,
                process.env.PATH || ''
            ].filter(Boolean).join(':')
        }
    });

    const finalPath = outputTemplate;

    if (!existsSync(finalPath)) {
        throw new Error('yt-dlp terminó pero no generó el archivo de video');
    }

    const buf = readFileSync(finalPath);
    try { unlinkSync(finalPath); } catch {}

    if (buf.length < 5000) throw new Error('Archivo demasiado pequeño, puede estar corrupto');

    const sizeMB = buf.length / 1024 / 1024;
    process.stdout.write(`  [play2] ✓ ${sizeMB.toFixed(1)} MB\n`);

    if (sizeMB > MAX_SIZE_MB) {
        throw new Error(`El video pesa ${sizeMB.toFixed(1)} MB — demasiado grande para enviar por WhatsApp (máx ${MAX_SIZE_MB} MB)`);
    }

    return buf;
}

export async function downloadYTAudio(videoUrl) {
    if (!existsSync(COOKIES)) {
        throw new Error(`Archivo de cookies no encontrado: ${COOKIES}`);
    }

    mkdirSync(TMP_DIR, { recursive: true });

    const stamp          = `ytbot_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const outputTemplate = join(TMP_DIR, `${stamp}.%(ext)s`);

    process.stdout.write(`  [play] Descargando async con yt-dlp...\n`);

    const { stdout, stderr } = await spawnAsync(YTDLP, [
        '-f', 'bestaudio/best',
        '-x',
        '--audio-format', 'mp3',
        '--audio-quality', '5',      // calidad un poco menor = archivos más pequeños
        '--match-filter', `duration <= 900`, // máx 15 min
        '-o', outputTemplate,
        '--no-playlist',
        '--no-check-certificates',
        '--cookies', COOKIES,
        '--js-runtimes', `deno:${DENO}`,
        '--remote-components', 'ejs:github',
        '--ffmpeg-location', FFMPEG,
        videoUrl
    ], {
        env: {
            ...process.env,
            PATH: [
                '/usr/local/bin', '/usr/bin', '/bin',
                `${process.env.HOME || ''}/.deno/bin`,
                process.env.PATH || ''
            ].filter(Boolean).join(':')
        }
    });

    if (stdout.trim()) process.stdout.write(stdout.trim() + '\n');

    const found = readdirSync(TMP_DIR)
        .filter(f => f.startsWith(stamp) && /\.(mp3|m4a|opus|webm|ogg)$/i.test(f))
        .sort((a, b) => b.localeCompare(a))[0];

    const finalPath = found ? join(TMP_DIR, found) : join(TMP_DIR, `${stamp}.mp3`);

    if (!existsSync(finalPath)) {
        throw new Error('yt-dlp terminó pero no generó el archivo de audio');
    }

    const buf = readFileSync(finalPath);
    try { unlinkSync(finalPath); } catch {}

    if (buf.length < 5000) throw new Error('Archivo demasiado pequeño, puede estar corrupto');

    const sizeMB = buf.length / 1024 / 1024;
    process.stdout.write(`  [play] ✓ ${sizeMB.toFixed(1)} MB\n`);

    if (sizeMB > MAX_SIZE_MB) {
        throw new Error(`El audio pesa ${sizeMB.toFixed(1)} MB — demasiado grande para enviar por WhatsApp (máx ${MAX_SIZE_MB} MB)`);
    }

    return buf;
}
