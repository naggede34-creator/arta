/**
 * Telegram Userbot — Auto Post & Forward
 * Node.js + GramJS (MTProto)
 *
 * Fitur:
 *  - Auto post pesan teks ke banyak grup (rotasi)
 *  - Auto forward pesan channel ke banyak grup + reply otomatis
 *  - Jam operasional (berhenti 00:00–03:00 WIB)
 *  - Perintah lengkap via Telegram
 */

require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { Api } = require('telegram');
const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────
// KONFIGURASI
// ─────────────────────────────────────────────────────────
const API_ID    = parseInt(process.env.API_ID  || '0', 10);
const API_HASH  = process.env.API_HASH          || '';
const SESSION_FILE = path.join(__dirname, 'session.txt');
const CONFIG_FILE  = path.join(__dirname, 'bot_config.json');

const REPLY_CMDS = [
    '/sharemsg', '/sharemsg2', '/sharemsg3',
    '/broadcast', '/broadcast2', '/broadcast3'
];

const REPLY_INTERVAL_MS = 60  * 1000;   // 60 detik
const MIN_CYCLE_MS      = 20  * 60 * 1000;
const MAX_CYCLE_MS      = 25  * 60 * 1000;

// ─────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function getNowWIB() {
    const now = new Date();
    return new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60000);
}

function isNightTime() {
    const h = getNowWIB().getHours();
    return h >= 0 && h < 3;
}

function wibTimeStr() {
    return getNowWIB().toTimeString().slice(0, 8) + ' WIB';
}

// ─────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────
let cfg = {};

function loadConfig() {
    const def = {
        main_messages: [],
        forward_messages: [],
        current_msg_index: 0,
        target_groups: [],
        is_auto_active: false
    };
    if (!fs.existsSync(CONFIG_FILE)) {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(def, null, 4));
        return def;
    }
    try {
        const d = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (!Array.isArray(d.main_messages))    d.main_messages    = [];
        if (!Array.isArray(d.forward_messages)) d.forward_messages = [];
        if (!Array.isArray(d.target_groups))    d.target_groups    = [];
        if (typeof d.current_msg_index !== 'number') d.current_msg_index = 0;
        return d;
    } catch (e) {
        console.error('Gagal baca config:', e.message);
        return def;
    }
}

function saveConfig() {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 4), 'utf8');
}

function buildPool() {
    return [
        ...cfg.main_messages.map(c    => ({ type: 'text',    content: c })),
        ...cfg.forward_messages.map(c => ({ type: 'forward', content: c }))
    ];
}

// ─────────────────────────────────────────────────────────
// SEND / EDIT MSG
// ─────────────────────────────────────────────────────────
async function editMsg(client, msg, text) {
    try {
        await client.editMessage(msg.chatId, {
            message: msg.id,
            text,
            parseMode: 'md'
        });
    } catch (e) {
        console.error('editMessage gagal:', e.message);
    }
}

// ─────────────────────────────────────────────────────────
// AUTO POST LOOP
// ─────────────────────────────────────────────────────────
async function autoPostLoop(client) {
    await sleep(5000);

    while (true) {
        try {
            if (isNightTime()) {
                console.log(`🌙 [${wibTimeStr()}] Jam tidur (00:00–03:00). Istirahat 1 menit...`);
                await sleep(60000);
                continue;
            }

            if (cfg.is_auto_active) {
                const groups = cfg.target_groups;
                const pool   = buildPool();

                if (!pool.length) {
                    console.log('⚠️ Auto aktif tapi belum ada pesan. Gunakan /addpesan atau /addpesanfw.');
                } else if (!groups.length) {
                    console.log('⚠️ Auto aktif tapi belum ada grup. Gunakan /addgb di dalam grup.');
                } else {
                    const idx  = cfg.current_msg_index % pool.length;
                    const item = pool[idx];
                    const lbl  = item.type === 'text'
                        ? `Teks #${idx + 1}`
                        : `Forward: ${item.content.label || ''}`;

                    console.log(`🚀 [${wibTimeStr()}] Siklus #${idx + 1}/${pool.length} (${lbl}) → ${groups.length} grup`);

                    for (const chatId of [...groups]) {
                        if (!cfg.is_auto_active || isNightTime()) {
                            console.log('⏹️ Auto dihentikan atau masuk jam tidur.');
                            break;
                        }

                        try {
                            let sentMsgId = null;

                            // ── Kirim pesan teks ──────────────────────
                            if (item.type === 'text') {
                                const sent = await client.sendMessage(chatId, { message: item.content });
                                sentMsgId = sent.id;
                                console.log(`✅ Teks #${idx + 1} terkirim ke ${chatId}`);

                            // ── Forward pesan ─────────────────────────
                            } else {
                                const fw = item.content;
                                try {
                                    const updates = await client.invoke(
                                        new Api.messages.ForwardMessages({
                                            fromPeer: await client.getInputEntity(fw.saved_chat_id),
                                            id: [fw.saved_message_id],
                                            toPeer: await client.getInputEntity(chatId),
                                            randomId: [BigInt(Date.now())]
                                        })
                                    );

                                    // Ambil ID pesan yang di-forward
                                    if (updates?.updates) {
                                        for (const u of updates.updates) {
                                            if (u.className === 'UpdateMessageID') { sentMsgId = u.id; break; }
                                            if (u.message?.id) { sentMsgId = u.message.id; break; }
                                        }
                                    }
                                    if (!sentMsgId && updates?.newMessages) {
                                        sentMsgId = updates.newMessages[0]?.id;
                                    }

                                    console.log(`✅ Forward '${fw.label}' terkirim ke ${chatId} (msg=${sentMsgId})`);
                                } catch (fwErr) {
                                    console.error(`❌ Gagal forward ke ${chatId}:`, fwErr.message);
                                }
                            }

                            // ── Reply otomatis ────────────────────────
                            if (sentMsgId) {
                                for (const replyCmd of REPLY_CMDS) {
                                    if (!cfg.is_auto_active || isNightTime()) break;

                                    console.log(`⏳ Tunggu ${REPLY_INTERVAL_MS / 1000}s sebelum reply '${replyCmd}'...`);
                                    await sleep(REPLY_INTERVAL_MS);

                                    try {
                                        await client.sendMessage(chatId, {
                                            message: replyCmd,
                                            replyTo: sentMsgId
                                        });
                                        console.log(`💬 Reply '${replyCmd}' → ${chatId}`);
                                    } catch (replyErr) {
                                        if (replyErr.seconds) {
                                            console.log(`⚠️ FloodWait ${replyErr.seconds}s...`);
                                            await sleep(replyErr.seconds * 1000 + 2000);
                                            await client.sendMessage(chatId, { message: replyCmd, replyTo: sentMsgId });
                                        } else {
                                            console.error(`❌ Gagal reply '${replyCmd}': ${replyErr.message}`);
                                        }
                                    }
                                }
                            }

                        } catch (e) {
                            if (e.seconds) {
                                console.log(`⚠️ FloodWait ${e.seconds}s di ${chatId}`);
                                await sleep(e.seconds * 1000 + 5000);
                            } else {
                                console.error(`❌ Error di ${chatId}:`, e.message);
                            }
                        }
                    }

                    // Rotasi ke item berikutnya
                    cfg.current_msg_index = (idx + 1) % pool.length;
                    saveConfig();
                    console.log(`🔄 Siklus selesai. Berikutnya: #${cfg.current_msg_index + 1}`);
                }
            }

            const wait = MIN_CYCLE_MS + Math.random() * (MAX_CYCLE_MS - MIN_CYCLE_MS);
            console.log(`💤 Jeda ${(wait / 60000).toFixed(1)} menit untuk siklus berikutnya...`);
            await sleep(wait);

        } catch (e) {
            console.error('Error loop:', e.message);
            await sleep(60000);
        }
    }
}

// ─────────────────────────────────────────────────────────
// COMMAND HANDLERS
// ─────────────────────────────────────────────────────────
async function handleCommand(client, msg) {
    const text = msg.message || '';
    if (!text.startsWith('/')) return;

    const parts   = text.trim().split(/\s+/);
    const rawCmd  = parts[0].slice(1).split('@')[0].toLowerCase();
    const argText = parts.slice(1).join(' ').trim();
    const args    = parts.slice(1);

    switch (rawCmd) {

        // ─── PESAN TEKS ──────────────────────────────────────────
        case 'addpesan': {
            if (!argText) {
                return editMsg(client, msg,
                    "╔══ ⚠️ FORMAT SALAH ══╗\n\n" +
                    "📌 Cara pakai:\n`/addpesan <teks pesan>`\n\n" +
                    "📝 Contoh:\n`/addpesan Promo nokos murah order sekarang!`\n\n" +
                    "╚══════════════════╝"
                );
            }
            cfg.main_messages.push(argText);
            saveConfig();
            const total = cfg.main_messages.length;
            const prev  = argText.length > 100 ? argText.slice(0, 100) + '...' : argText;
            return editMsg(client, msg,
                `╔══ ✅ PESAN #${total} DITAMBAHKAN ══╗\n\n` +
                `📝 **Isi:**\n${prev}\n\n` +
                `📊 Total pesan teks: \`${total}\`\n\n` +
                "╚════════════════════════╝"
            );
        }

        case 'setpesan': {
            if (!argText) {
                return editMsg(client, msg,
                    "╔══ ⚠️ FORMAT SALAH ══╗\n\n📌 Cara pakai: `/setpesan <teks>`\n\n╚══════════════════╝"
                );
            }
            cfg.main_messages       = [argText];
            cfg.current_msg_index   = 0;
            saveConfig();
            return editMsg(client, msg,
                "╔══ ✅ PESAN UTAMA DI-SET ══╗\n\n" +
                `📝 **Pesan #1:**\n${argText}\n\n` +
                "💡 Gunakan `/addpesan` untuk tambah variasi\n\n" +
                "╚══════════════════════╝"
            );
        }

        case 'listpesan': {
            const msgs = cfg.main_messages;
            if (!msgs.length) {
                return editMsg(client, msg,
                    "╔══ 📭 KOSONG ══╗\n\nBelum ada pesan teks.\nGunakan `/addpesan <teks>` untuk tambah.\n\n╚══════════════╝"
                );
            }
            const pool    = buildPool();
            const currIdx = cfg.current_msg_index % Math.max(1, pool.length);
            let res = "╔══ 📋 DAFTAR PESAN TEKS ══╗\n\n";
            msgs.forEach((m, i) => {
                const tag  = i === currIdx ? " 👈 *(Berikutnya)*" : "";
                const prev = m.length > 70 ? m.slice(0, 70) + '...' : m;
                res += `**${i + 1}.** ${prev}${tag}\n\n`;
            });
            res += `📊 Total: \`${msgs.length}\` pesan teks\n╚══════════════════════╝`;
            return editMsg(client, msg, res);
        }

        case 'delpesan': {
            const n = parseInt(args[0], 10);
            if (!args[0] || isNaN(n) || n < 1 || n > cfg.main_messages.length) {
                return editMsg(client, msg,
                    "╔══ ⚠️ FORMAT SALAH ══╗\n\n📌 Cara pakai: `/delpesan <nomor>`\n📋 Cek: `/listpesan`\n\n╚══════════════════╝"
                );
            }
            const removed = cfg.main_messages.splice(n - 1, 1)[0];
            if (cfg.current_msg_index >= cfg.main_messages.length) cfg.current_msg_index = 0;
            saveConfig();
            const prev = removed.length > 80 ? removed.slice(0, 80) + '...' : removed;
            return editMsg(client, msg,
                `╔══ 🗑️ PESAN #${n} DIHAPUS ══╗\n\n📝 **Dihapus:**\n${prev}\n\n📊 Sisa: \`${cfg.main_messages.length}\` pesan\n\n╚════════════════════╝`
            );
        }

        // ─── PESAN FORWARD ───────────────────────────────────────
        case 'addpesanfw': {
            const reply = await msg.getReplyMessage();
            if (!reply) {
                return editMsg(client, msg,
                    "╔══ ℹ️ CARA PAKAI /addpesanfw ══╗\n\n" +
                    "**Langkah-langkah:**\n" +
                    "1️⃣ Forward pesan dari channel/bot ke sini\n" +
                    "2️⃣ **Reply** ke pesan forward tersebut\n" +
                    "3️⃣ Ketik `/addpesanfw [label opsional]`\n\n" +
                    "📌 Contoh:\n`/addpesanfw Promo Channel Utama`\n\n" +
                    "╚══════════════════════════╝"
                );
            }
            if (!reply.fwdFrom) {
                return editMsg(client, msg,
                    "╔══ ❌ BUKAN PESAN FORWARD ══╗\n\n" +
                    "Pesan yang di-reply bukan **forward**!\n\n" +
                    "📌 Forward dulu pesan dari channel,\nlalu reply dengan `/addpesanfw`.\n\n" +
                    "╚══════════════════════════╝"
                );
            }

            const fwList  = cfg.forward_messages;
            const label   = argText || `Pesan Forward #${fwList.length + 1}`;

            // Ambil info asal forward
            let fromChatId   = Number(msg.chatId);
            let fromChatName = 'Unknown';
            if (reply.fwdFrom?.fromId) {
                const fid = reply.fwdFrom.fromId;
                fromChatId   = Number(fid.channelId || fid.userId || msg.chatId);
                fromChatName = reply.fwdFrom.fromName || String(fromChatId);
            }

            fwList.push({
                label,
                saved_chat_id:    Number(msg.chatId),
                saved_message_id: reply.id,
                from_chat_id:     fromChatId,
                from_chat_name:   fromChatName
            });
            saveConfig();

            return editMsg(client, msg,
                `╔══ ✅ PESAN FORWARD #${fwList.length} DISIMPAN ══╗\n\n` +
                `🏷️ **Label:** \`${label}\`\n` +
                `📡 **Dari:** \`${fromChatName}\`\n` +
                `💾 **Tersimpan:** msg \`${reply.id}\` chat \`${msg.chatId}\`\n\n` +
                `📊 Total pesan forward: \`${fwList.length}\`\n\n` +
                "╚══════════════════════════════╝"
            );
        }

        case 'listpesanfw': {
            const fwList = cfg.forward_messages;
            if (!fwList.length) {
                return editMsg(client, msg,
                    "╔══ 📭 KOSONG ══╗\n\nBelum ada pesan forward.\n\n" +
                    "📌 Cara tambah:\n1. Forward pesan ke sini\n2. Reply dengan `/addpesanfw [label]`\n\n╚══════════════╝"
                );
            }
            const pool      = buildPool();
            const mainCount = cfg.main_messages.length;
            const currIdx   = cfg.current_msg_index % Math.max(1, pool.length);
            let res = "╔══ 📋 DAFTAR PESAN FORWARD ══╗\n\n";
            fwList.forEach((fw, i) => {
                const isNext = (mainCount + i) === currIdx;
                const tag    = isNext ? " 👈 *(Berikutnya)*" : "";
                res += `**${i + 1}.** 🏷️ \`${fw.label || 'Forward #' + (i + 1)}\`${tag}\n`;
                res += `    📡 Dari: \`${fw.from_chat_name || 'Unknown'}\`\n\n`;
            });
            res += `📊 Total: \`${fwList.length}\` pesan forward\n╚══════════════════════════╝`;
            return editMsg(client, msg, res);
        }

        case 'delpesanfw': {
            const n       = parseInt(args[0], 10);
            const fwList  = cfg.forward_messages;
            if (!args[0] || isNaN(n) || n < 1 || n > fwList.length) {
                return editMsg(client, msg,
                    "╔══ ⚠️ FORMAT SALAH ══╗\n\n📌 Cara pakai: `/delpesanfw <nomor>`\n📋 Cek: `/listpesanfw`\n\n╚══════════════════╝"
                );
            }
            const removed = fwList.splice(n - 1, 1)[0];
            const total   = cfg.main_messages.length + fwList.length;
            if (cfg.current_msg_index >= Math.max(1, total)) cfg.current_msg_index = 0;
            saveConfig();
            return editMsg(client, msg,
                "╔══ 🗑️ PESAN FORWARD DIHAPUS ══╗\n\n" +
                `🏷️ **Dihapus:** \`${removed.label || 'Forward #' + n}\`\n\n` +
                `📊 Sisa: \`${fwList.length}\` pesan forward\n\n` +
                "╚══════════════════════════╝"
            );
        }

        // ─── GRUP ────────────────────────────────────────────────
        case 'addgb': {
            const chatId = Number(msg.chatId);
            if (chatId > 0) {
                return editMsg(client, msg,
                    "╔══ ❌ BUKAN GRUP ══╗\n\nPerintah `/addgb` hanya bisa\ndigunakan di dalam **Grup**.\n\n╚══════════════════╝"
                );
            }
            const groups = cfg.target_groups;
            if (groups.includes(chatId)) {
                return editMsg(client, msg,
                    `╔══ ℹ️ SUDAH TERDAFTAR ══╗\n\n\`${chatId}\`\n\nGrup ini sudah ada di daftar.\n\n╚══════════════════════╝`
                );
            }
            groups.push(chatId);
            saveConfig();
            let title = '';
            try { const e = await client.getEntity(chatId); title = e.title || ''; } catch (_) {}
            return editMsg(client, msg,
                "╔══ ✅ GRUP DITAMBAHKAN ══╗\n\n" +
                (title ? `📌 **Nama:** ${title}\n` : '') +
                `🆔 **ID:** \`${chatId}\`\n\n` +
                `📊 Total grup: \`${groups.length}\`\n\n╚══════════════════════╝`
            );
        }

        case 'delgb': {
            const chatId = Number(msg.chatId);
            const groups = cfg.target_groups;
            const idx2   = groups.indexOf(chatId);
            if (idx2 !== -1) {
                groups.splice(idx2, 1);
                saveConfig();
                return editMsg(client, msg,
                    `╔══ 🗑️ GRUP DIHAPUS ══╗\n\n\`${chatId}\` berhasil dihapus.\n\n📊 Sisa: \`${groups.length}\` grup\n\n╚══════════════════╝`
                );
            }
            return editMsg(client, msg,
                `╔══ ℹ️ TIDAK TERDAFTAR ══╗\n\n\`${chatId}\` tidak ada di daftar.\n\n╚══════════════════════╝`
            );
        }

        case 'listgb': {
            const groups = cfg.target_groups;
            if (!groups.length) {
                return editMsg(client, msg,
                    "╔══ 📭 KOSONG ══╗\n\nBelum ada grup target.\nGunakan `/addgb` di dalam grup.\n\n╚══════════════╝"
                );
            }
            let res = "╔══ 📋 DAFTAR GRUP TARGET ══╗\n\n";
            for (let i = 0; i < groups.length; i++) {
                let title = '';
                try { const e = await client.getEntity(groups[i]); title = e.title || ''; } catch (_) {}
                res += `**${i + 1}.** ${title ? title + '\n' : ''}\`${groups[i]}\`\n\n`;
            }
            res += `📊 Total: \`${groups.length}\` grup\n╚══════════════════════╝`;
            return editMsg(client, msg, res);
        }

        // ─── KONTROL ─────────────────────────────────────────────
        case 'auto': {
            const mode = (args[0] || '').toLowerCase();
            if (!mode) {
                const st = cfg.is_auto_active ? "🟢 **AKTIF**" : "🔴 **NON-AKTIF**";
                return editMsg(client, msg,
                    "╔══ 🤖 AUTO POST ══╗\n\n" + `Status: ${st}\n\n` +
                    "`/auto on`  → aktifkan\n`/auto off` → matikan\n\n╚══════════════════╝"
                );
            }
            if (mode === 'on') {
                cfg.is_auto_active = true;
                saveConfig();
                return editMsg(client, msg,
                    "╔══ 🟢 AUTO POST AKTIF ══╗\n\n✅ Posting & reply otomatis\nberhasil **DIAKTIFKAN**!\n\n⏰ Operasional: 03:00–00:00 WIB\n\n╚══════════════════════╝"
                );
            }
            if (mode === 'off') {
                cfg.is_auto_active = false;
                saveConfig();
                return editMsg(client, msg,
                    "╔══ 🔴 AUTO POST MATI ══╗\n\n✅ Posting otomatis berhasil\n**DIMATIKAN**.\n\n╚══════════════════════╝"
                );
            }
            return editMsg(client, msg, "╔══ ⚠️ PERINTAH SALAH ══╗\n\nGunakan `/auto on` atau `/auto off`\n\n╚══════════════════════╝");
        }

        case 'status': {
            const pool     = buildPool();
            const isActive = cfg.is_auto_active ? "🟢 AKTIF" : "🔴 NON-AKTIF";
            const modeStr  = isNightTime() ? "🌙 Jam Tidur" : "☀️ Jam Kerja";

            let nextInfo = "—";
            if (pool.length > 0) {
                const idx3 = cfg.current_msg_index % pool.length;
                const item = pool[idx3];
                nextInfo = item.type === 'text'
                    ? `📝 Teks #${idx3 + 1}`
                    : `📨 Forward: ${item.content.label || 'FW'}`;
            }

            return editMsg(client, msg,
                "╔══ ⚙️ STATUS USERBOT ══╗\n" +
                "━━━━━━━━━━━━━━━━━━━━\n" +
                `🤖 Auto Post    : **${isActive}**\n` +
                `🕐 Waktu WIB    : ${wibTimeStr()}\n` +
                `🌤️ Mode         : ${modeStr}\n` +
                `⏰ Operasional  : 03:00 – 00:00 WIB\n` +
                "━━━━━━━━━━━━━━━━━━━━\n" +
                `📝 Pesan Teks   : \`${cfg.main_messages.length}\` pesan\n` +
                `📨 Pesan Forward: \`${cfg.forward_messages.length}\` pesan\n` +
                `🔄 Pool Total   : \`${pool.length}\` item\n` +
                `🎯 Berikutnya   : ${nextInfo}\n` +
                `👥 Grup Target  : \`${cfg.target_groups.length}\` grup\n` +
                "━━━━━━━━━━━━━━━━━━━━\n" +
                `⏱️ Jeda Reply   : **60 detik**\n` +
                `⏱️ Jeda Siklus  : **20–25 menit**\n` +
                "━━━━━━━━━━━━━━━━━━━━\n" +
                "💬 **Urutan Reply:**\n" +
                "  1. `/sharemsg`\n  2. `/sharemsg2`\n  3. `/sharemsg3`\n" +
                "  4. `/broadcast`\n  5. `/broadcast2`\n  6. `/broadcast3`\n" +
                "╚══════════════════════╝"
            );
        }

        case 'help': {
            return editMsg(client, msg,
                "╔══ 📖 PANDUAN PERINTAH USERBOT ══╗\n\n" +
                "**📝 PESAN TEKS:**\n" +
                "• `/addpesan <teks>` — Tambah pesan teks baru\n" +
                "• `/setpesan <teks>` — Reset & set pesan ke-1\n" +
                "• `/listpesan` — Lihat semua pesan teks\n" +
                "• `/delpesan <no>` — Hapus pesan teks\n\n" +
                "**📨 PESAN FORWARD:**\n" +
                "• `/addpesanfw [label]` — Simpan forward *(reply ke pesan forward)*\n" +
                "• `/listpesanfw` — Lihat semua pesan forward\n" +
                "• `/delpesanfw <no>` — Hapus pesan forward\n\n" +
                "**👥 GRUP TARGET:**\n" +
                "• `/addgb` — Tambah grup saat ini\n" +
                "• `/delgb` — Hapus grup saat ini\n" +
                "• `/listgb` — Lihat semua grup target\n\n" +
                "**⚙️ KONTROL BOT:**\n" +
                "• `/auto on` — Aktifkan auto post\n" +
                "• `/auto off` — Matikan auto post\n" +
                "• `/status` — Cek status lengkap\n" +
                "• `/help` — Tampilkan panduan ini\n\n" +
                "╚══════════════════════════════╝"
            );
        }
    }
}

// ─────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────
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
        console.error('Jalankan: node login.js  (hanya perlu sekali)');
        process.exit(1);
    }

    cfg = loadConfig();

    const client = new TelegramClient(
        new StringSession(sessionStr),
        API_ID,
        API_HASH,
        { connectionRetries: 5 }
    );

    await client.connect();

    if (!await client.isUserAuthorized()) {
        console.error('❌ Session tidak valid / expired!');
        console.error('Jalankan: node login.js untuk login ulang.');
        process.exit(1);
    }

    // Perbarui session
    fs.writeFileSync(SESSION_FILE, client.session.save(), 'utf8');

    const me = await client.getMe();
    console.log(`✅ Login sebagai: ${me.firstName} (@${me.username || 'no_username'})`);

    // Handler perintah (hanya pesan keluar sendiri)
    client.addEventHandler(async (event) => {
        try {
            await handleCommand(client, event.message);
        } catch (e) {
            console.error('Handler error:', e.message);
        }
    }, new NewMessage({ outgoing: true }));

    console.log('✅ Command handler aktif.');
    console.log('🚀 Auto post loop dimulai...\n');

    // Jalankan auto post loop secara paralel
    autoPostLoop(client);

    // Jaga proses tetap berjalan
    await new Promise(() => {});
}

main().catch(e => {
    console.error('Fatal error:', e.message);
    process.exit(1);
});
