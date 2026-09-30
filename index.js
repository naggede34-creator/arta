/**
 * Telegram Userbot — Auto Post, Forward, Note, Admin Mode, Rich Message, Clone Bot
 * Node.js + GramJS (MTProto)
 *
 * File:
 *   index.js      entry point (file ini)
 *   userbot.js    semua perintah & auto post (satu instance per akun)
 *   clone.js      manajer clone (login nomor → kode → A2F, banyak akun)
 *   assistant.js  bot panel dengan tombol (opsional, butuh BOT_TOKEN)
 *   richmsg.js    renderer Rich Message JSON
 *   ui.js         tampilan bot
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { createUserbot } = require('./userbot');
const { CloneManager } = require('./clone');
const { startAssistant } = require('./assistant');

const API_ID = parseInt(process.env.API_ID || '0', 10);
const API_HASH = process.env.API_HASH || '';
const BOT_TOKEN = (process.env.BOT_TOKEN || '').trim();
const SESSION_FILE = path.join(__dirname, 'session.txt');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');

async function main() {
    console.log('\n╔══════════════════════════════════╗');
    console.log('║   🤖 TELEGRAM USERBOT (Node.js)  ║');
    console.log('╚══════════════════════════════════╝\n');

    if (!API_ID || !API_HASH) {
        console.error('❌ API_ID / API_HASH tidak diset di .env!');
        console.error('Buat file .env dari .env.example lalu isi nilainya.');
        process.exit(1);
    }

    const sessionStr = process.env.SESSION_STRING ||
        (fs.existsSync(SESSION_FILE) ? fs.readFileSync(SESSION_FILE, 'utf8').trim() : '');
    if (!sessionStr) {
        console.error('❌ Session tidak ditemukan!');
        console.error('Jalankan: npm run login  (hanya perlu sekali)');
        process.exit(1);
    }

    const client = new TelegramClient(new StringSession(sessionStr), API_ID, API_HASH, { connectionRetries: 5 });
    await client.connect();
    if (!await client.isUserAuthorized()) {
        console.error('❌ Session tidak valid / expired!');
        console.error('Jalankan: npm run login untuk login ulang.');
        process.exit(1);
    }
    fs.writeFileSync(SESSION_FILE, client.session.save(), 'utf8');

    const me = await client.getMe();
    console.log(`✅ Login sebagai: ${me.firstName} (@${me.username || 'no_username'})`);

    fs.mkdirSync(DATA_DIR, { recursive: true });
    const manager = new CloneManager({
        apiId: API_ID,
        apiHash: API_HASH,
        dataDir: DATA_DIR,
        mainId: me.id,
        createUserbot: (o) => createUserbot({ ...o, ctx: {} })
    });

    const mainBot = createUserbot({
        client, dir: __dirname, label: me.firstName || 'Main', isMain: true, ctx: { manager }
    });
    await mainBot.start();

    let assistant = null;
    if (BOT_TOKEN) {
        try {
            assistant = await startAssistant({
                apiId: API_ID, apiHash: API_HASH, token: BOT_TOKEN,
                ownerId: me.id, manager, getMainBot: () => mainBot
            });
            console.log(`🔘 Panel tombol: t.me/${assistant.username}  (kirim /start)`);
        } catch (e) {
            console.error('⚠️ Assistant bot gagal start:', e.message);
        }
    } else {
        console.log('ℹ️ BOT_TOKEN kosong → panel tombol nonaktif (opsional, buat via @BotFather).');
    }

    manager.startAll().catch(e => console.error('Gagal start clone:', e.message));

    const shutdown = async (sig) => {
        console.log(`\n${sig} diterima, menutup…`);
        try { await manager.stopAll(); } catch (_) { /* abaikan */ }
        try { await mainBot.stop(); } catch (_) { /* abaikan */ }
        try { if (assistant) await assistant.stop(); } catch (_) { /* abaikan */ }
        try { await client.disconnect(); } catch (_) { /* abaikan */ }
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    await new Promise(() => {});
}

process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e && e.message ? e.message : e));

main().catch(e => {
    console.error('Fatal error:', e.message);
    process.exit(1);
});
