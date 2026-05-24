import { jidNormalizedUser } from '@whiskeysockets/baileys';

// ── Resolución de LID → JID real ─────────────────────────────────────────────
const groupMetadataCache = new Map();
const lidCache = new Map();
const METADATA_TTL = 5000;

function getCachedMetadata(groupJid) {
    const cached = groupMetadataCache.get(groupJid);
    if (!cached || Date.now() - cached.timestamp > METADATA_TTL) return null;
    return cached.metadata;
}

function normalizeToJid(phone) {
    if (!phone) return null;
    const base = typeof phone === 'number' ? phone.toString() : phone.replace(/\D/g, '');
    return base ? `${base}@s.whatsapp.net` : null;
}

export async function resolveLidToRealJid(lid, sock, groupJid) {
    const input = lid?.toString().trim();
    if (!input) return input;

    // Ya es un JID real
    if (input.endsWith('@s.whatsapp.net')) return input;

    // Si no es un grupo o no termina en @lid, devolver tal cual
    if (!groupJid?.endsWith('@g.us')) return input;

    // Cache hit
    if (lidCache.has(input)) return lidCache.get(input);

    const lidBase = input.split('@')[0];
    let metadata = getCachedMetadata(groupJid);

    if (!metadata) {
        try {
            metadata = await sock.groupMetadata(groupJid);
            groupMetadataCache.set(groupJid, { metadata, timestamp: Date.now() });
        } catch {
            lidCache.set(input, input);
            return input;
        }
    }

    for (const p of metadata.participants || []) {
        const idBase = (p?.id || p?.jid || '').split('@')[0].trim();
        const phone = normalizeToJid(p?.phoneNumber);
        if (!idBase || !phone) continue;
        if (idBase === lidBase) {
            lidCache.set(input, phone);
            return phone;
        }
    }

    lidCache.set(input, input);
    return input;
}

export function getMessageText(msg) {
    const m = msg.message;
    if (!m) return '';
    return (
        m.conversation ||
        m.extendedTextMessage?.text ||
        m.imageMessage?.caption ||
        m.videoMessage?.caption ||
        m.buttonsResponseMessage?.selectedButtonId ||
        m.listResponseMessage?.singleSelectReply?.selectedRowId ||
        m.templateButtonReplyMessage?.selectedId ||
        ''
    );
}

export function getJid(msg) {
    return msg.key.remoteJid;
}

export function isGroup(jid) {
    return jid?.endsWith('@g.us');
}

// Retorna info del sender: { jid, numero, esLid }
export function getSenderInfo(msg) {
    const raw = msg.key.participant || msg.key.remoteJid || '';

    // LID = identificador anónimo de WhatsApp (privacidad en grupos)
    const esLid = raw.includes('@lid');

    let jidLimpio = raw;
    let numero = '';

    if (esLid) {
        // Los LID no son números de teléfono reales
        numero = null;
        jidLimpio = raw;
    } else {
        try {
            jidLimpio = jidNormalizedUser(raw);
        } catch {
            jidLimpio = raw.split(':')[0] + '@s.whatsapp.net';
        }
        numero = jidLimpio.split('@')[0];
    }

    return { jid: jidLimpio, numero, esLid };
}

// Compatibilidad hacia atrás
export function getSender(msg) {
    return getSenderInfo(msg).jid;
}

export function getSenderNumber(msg) {
    return getSenderInfo(msg).numero;
}

export function getMentions(msg) {
    return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

export function getQuotedMsg(msg) {
    return msg.message?.extendedTextMessage?.contextInfo?.quotedMessage || null;
}

export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export function formatNumber(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function runtime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${d}d ${h}h ${m}m ${s}s`;
}

export function pickRandom(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}
