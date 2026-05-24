import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR  = join(__dirname, '../../data');
const DATA_FILE = join(DATA_DIR, 'sticker_triggers.json');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

function load() {
    if (!existsSync(DATA_FILE)) return {};
    try { return JSON.parse(readFileSync(DATA_FILE, 'utf8')); }
    catch { return {}; }
}

function save(db) {
    writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
}

export function getAll()        { return load(); }
export function get(hash)       { return load()[hash] || null; }
export function count()         { return Object.keys(load()).length; }

export function set(hash, data) {
    const db = load();
    db[hash] = data;
    save(db);
}

export function remove(hash) {
    const db = load();
    if (!(hash in db)) return false;
    delete db[hash];
    save(db);
    return true;
}

export function getStickerHash(stickerMessage) {
    const raw = stickerMessage?.fileSha256;
    if (!raw) return null;
    return Buffer.from(raw).toString('base64');
}
