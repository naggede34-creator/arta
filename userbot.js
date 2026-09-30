/**
 * Userbot — satu instance per akun (akun utama + setiap clone)
 * Semua state (config, spam counter, loop) terisolasi per instance.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Api } = require('telegram');
const { NewMessage } = require('telegram/events');
const { sendRich } = require('./richmsg');
const ui = require('./ui');

const REPLY_CMDS = ['/sharemsg', '/sharemsg2', '/sharemsg3', '/broadcast', '/broadcast2', '/broadcast3'];
const REPLY_INTERVAL_MS = 60 * 1000;
const MIN_CYCLE_MS = 20 * 60 * 1000;
const MAX_CYCLE_MS = 25 * 60 * 1000;
const INPUT_TIMEOUT_MS = 5 * 60 * 1000;
const SPAM_LIMIT = 5;
const TELEGRAM_SERVICE_ID = 777000;
const BOT_SCREEN_PREFIX = /^(━|📲|📩|🔐|✅|❌|⚠️|ℹ️|📭|📖|⚙️|🤖|🔴|🎨)/;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getNowWIB() {
    const now = new Date();
    return new Date(now.getTime() + (7 * 60 + now.getTimezoneOffset()) * 60000);
}
const isNightTime = () => getNowWIB().getHours() < 3;
const wibTimeStr = () => getNowWIB().toTimeString().slice(0, 8) + ' WIB';
const noteKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9_]/g, '_');
const argOf = text => text.replace(/^\/\S+\s*/, '').trim();

function createUserbot({ client, dir, label, isMain, ctx = {} }) {
    const configFile = path.join(dir, 'bot_config.json');
    const notesDir = path.join(dir, 'notes_media');
    const tag = isMain ? 'MAIN' : label;
    const log = (...a) => console.log(`[${tag}]`, ...a);
    const spamCount = new Map();
    const outB = new NewMessage({ outgoing: true });
    const inB = new NewMessage({ incoming: true });
    let cfg = loadConfig();
    let stopped = false;
    let inlineFlow = null;

    // ─────────────────────────────────────────────────────
    // CONFIG
    // ─────────────────────────────────────────────────────
    function loadConfig() {
        fs.mkdirSync(dir, { recursive: true });
        const def = {
            main_messages: [], forward_messages: [], current_msg_index: 0,
            target_groups: [], is_auto_active: false, admin_mode: true, notes: {}
        };
        if (!fs.existsSync(configFile)) {
            fs.writeFileSync(configFile, JSON.stringify(def, null, 4));
            return def;
        }
        try {
            const d = JSON.parse(fs.readFileSync(configFile, 'utf8'));
            if (!Array.isArray(d.main_messages)) d.main_messages = [];
            if (!Array.isArray(d.forward_messages)) d.forward_messages = [];
            if (!Array.isArray(d.target_groups)) d.target_groups = [];
            if (typeof d.current_msg_index !== 'number') d.current_msg_index = 0;
            if (typeof d.admin_mode !== 'boolean') d.admin_mode = true;
            if (!d.notes || typeof d.notes !== 'object') d.notes = {};
            return d;
        } catch (e) {
            log('Gagal baca config:', e.message);
            return def;
        }
    }
    const saveConfig = () => fs.writeFileSync(configFile, JSON.stringify(cfg, null, 4), 'utf8');
    const buildPool = () => [
        ...cfg.main_messages.map(c => ({ type: 'text', content: c })),
        ...cfg.forward_messages.map(c => ({ type: 'forward', content: c }))
    ];

    // ─────────────────────────────────────────────────────
    // OUTPUT
    // ─────────────────────────────────────────────────────
    const say = (msg, rich) =>
        sendRich(client, msg.chatId, rich, { edit: { chatId: msg.chatId, id: msg.id } })
            .catch(e => log('Gagal kirim rich:', e.message));

    const usage = (...lines) => ui.warn('Format salah', ...lines);

    async function sendNote(msg, name) {
        const note = (cfg.notes || {})[name];
        if (!note) return say(msg, ui.err('Note tidak ada', { p: ['Note ', { code: name }, ' tidak ditemukan. Cek ', { code: '/listnote' }, '.'] }));

        const mediaPath = note.has_media && note.media_path
            ? (path.isAbsolute(note.media_path) ? note.media_path : path.join(dir, note.media_path)) : null;

        if (!mediaPath && note.text) {
            const t = note.text.trim();
            if (/^[[{]/.test(t)) {
                try {
                    return await sendRich(client, msg.chatId, JSON.parse(t), { edit: { chatId: msg.chatId, id: msg.id } });
                } catch (_) { /* bukan JSON rich → kirim sebagai teks biasa */ }
            }
        }

        try { await client.deleteMessages(msg.chatId, [msg.id], { revoke: true }); } catch (_) { /* abaikan */ }
        if (mediaPath && fs.existsSync(mediaPath)) {
            return client.sendFile(msg.chatId, { file: mediaPath, caption: note.text || '', parseMode: 'md' });
        }
        if (note.text) return client.sendMessage(msg.chatId, { message: note.text, parseMode: 'md' });
        return undefined;
    }

    // ─────────────────────────────────────────────────────
    // AUTO POST LOOP
    // ─────────────────────────────────────────────────────
    async function nap(ms) {
        const end = Date.now() + ms;
        while (!stopped && Date.now() < end) await sleep(Math.min(5000, end - Date.now()));
    }

    async function autoPostLoop() {
        await nap(5000);
        while (!stopped) {
            try {
                if (isNightTime()) {
                    log(`🌙 [${wibTimeStr()}] Jam tidur (00:00–03:00)`);
                    await nap(60000);
                    continue;
                }
                if (cfg.is_auto_active) {
                    const groups = cfg.target_groups;
                    const pool = buildPool();
                    if (!pool.length) log('⚠️ Auto aktif tapi belum ada pesan.');
                    else if (!groups.length) log('⚠️ Auto aktif tapi belum ada grup.');
                    else await runCycle(groups, pool);
                }
                const wait = MIN_CYCLE_MS + Math.random() * (MAX_CYCLE_MS - MIN_CYCLE_MS);
                log(`💤 Jeda ${(wait / 60000).toFixed(1)} menit`);
                await nap(wait);
            } catch (e) {
                log('Error loop:', e.message);
                await nap(60000);
            }
        }
    }

    async function runCycle(groups, pool) {
        const idx = cfg.current_msg_index % pool.length;
        const item = pool[idx];
        log(`🚀 [${wibTimeStr()}] Siklus #${idx + 1}/${pool.length} → ${groups.length} grup`);
        const active = () => cfg.is_auto_active && !isNightTime() && !stopped;

        for (const chatId of [...groups]) {
            if (!active()) break;
            try {
                let sentMsgId = null;
                if (item.type === 'text') {
                    sentMsgId = (await client.sendMessage(chatId, { message: item.content })).id;
                } else {
                    sentMsgId = await forwardSaved(item.content, chatId);
                }
                if (!sentMsgId) continue;
                for (const replyCmd of REPLY_CMDS) {
                    if (!active()) break;
                    await nap(REPLY_INTERVAL_MS);
                    if (!active()) break;
                    try {
                        await client.sendMessage(chatId, { message: replyCmd, replyTo: sentMsgId });
                    } catch (re) {
                        if (re.seconds) {
                            await nap(re.seconds * 1000 + 2000);
                            await client.sendMessage(chatId, { message: replyCmd, replyTo: sentMsgId });
                        } else log(`❌ Gagal reply '${replyCmd}': ${re.message}`);
                    }
                }
            } catch (e) {
                if (e.seconds) await nap(e.seconds * 1000 + 5000);
                else log(`❌ Error di ${chatId}: ${e.message}`);
            }
        }
        cfg.current_msg_index = (idx + 1) % pool.length;
        saveConfig();
    }

    async function forwardSaved(fw, chatId) {
        try {
            const updates = await client.invoke(new Api.messages.ForwardMessages({
                fromPeer: await client.getInputEntity(fw.saved_chat_id),
                id: [fw.saved_message_id],
                toPeer: await client.getInputEntity(chatId),
                randomId: [BigInt(Date.now()) * 1000n + BigInt(Math.floor(Math.random() * 1000))]
            }));
            let id = null;
            for (const u of (updates && updates.updates) || []) {
                if (u.className === 'UpdateMessageID') { id = u.id; break; }
                if (u.message && u.message.id) { id = u.message.id; break; }
            }
            if (!id && updates && updates.newMessages) id = updates.newMessages[0] && updates.newMessages[0].id;
            return id;
        } catch (e) {
            log(`❌ Gagal forward ke ${chatId}: ${e.message}`);
            return null;
        }
    }

    // ─────────────────────────────────────────────────────
    // CLONE (hanya akun utama)
    // ─────────────────────────────────────────────────────
    async function cloneCommand(msg) {
        const mgr = ctx.manager;
        if (!mgr) return say(msg, ui.err('Clone tidak tersedia'));
        if (mgr.busy()) return say(msg, ui.warn('Proses clone sedang berjalan', { p: ['Selesaikan atau batalkan dengan ', { code: '/cancel' }, '.'] }));
        if (Number(msg.chatId) <= 0) {
            return say(msg, ui.warn('Gunakan di chat pribadi', { p: 'Jalankan /clonebot di Saved Messages atau chat pribadi, bukan di grup.' }));
        }
        let warnBlock = [];
        const io = {
            ask(step, meta) {
                return new Promise((resolve) => {
                    const timer = setTimeout(() => { inlineFlow = null; resolve(Promise.reject(new Error('TIMEOUT'))); }, INPUT_TIMEOUT_MS);
                    inlineFlow = {
                        chatId: String(msg.chatId),
                        resolve: v => { clearTimeout(timer); inlineFlow = null; resolve(v); },
                        stop: () => clearTimeout(timer)
                    };
                    say(msg, [...warnBlock, ...ui.clonePrompt(step, meta)]);
                    warnBlock = [];
                });
            },
            notify: async (ev, d) => { if (ev === 'retry') warnBlock = ui.cloneRetry(d.code); }
        };
        try {
            const rec = await mgr.login(io);
            await say(msg, ui.cloneDone(rec));
        } catch (e) {
            await say(msg, ui.cloneFail(e.code || e.message));
        } finally {
            if (inlineFlow) { inlineFlow.stop(); inlineFlow = null; }
        }
        return undefined;
    }

    async function cloneAdmin(msg, cmd, args) {
        const mgr = ctx.manager;
        if (!mgr) return undefined;
        if (cmd === 'listclone') return say(msg, ui.cloneList(mgr.list(), mgr.runningIds()));
        if (cmd === 'cancel') {
            return say(msg, mgr.cancel() ? ui.ok('Dibatalkan') : ui.info('Tidak ada proses clone yang berjalan'));
        }
        const rec = mgr.byIndex(args[0]);
        if (!rec) return say(msg, usage({ p: ['Pakai ', { code: `/${cmd} <no>` }, ' — lihat nomor di ', { code: '/listclone' }, '.'] }));
        try {
            if (cmd === 'stopclone') { await mgr.stop(rec.id); return say(msg, ui.ok('Clone dihentikan', { p: rec.name })); }
            if (cmd === 'startclone') { await mgr.start(rec.id); return say(msg, ui.ok('Clone dijalankan', { p: rec.name })); }
            await mgr.remove(rec.id);
            return say(msg, ui.ok('Clone dihapus', { p: [rec.name, ' — sesi Telegram-nya juga di-logout.'] }));
        } catch (e) {
            return say(msg, ui.err('Gagal', { p: ui.cloneErrorText(e.code || e.message) }));
        }
    }

    // ─────────────────────────────────────────────────────
    // RICH
    // ─────────────────────────────────────────────────────
    async function richCommand(msg, argText) {
        let raw = argText;
        if (!raw) {
            const r = await msg.getReplyMessage();
            raw = r && r.message ? r.message.trim() : '';
        }
        if (!raw) {
            return say(msg, usage({ p: ['Pakai ', { code: '/rich <json>' }, ' atau reply ke pesan berisi JSON.'] },
                { pre: { lang: 'json', text: '[{"h2":"Halo"},{"p":["Harga: ",{"b":"Rp 25.000"}]}]' } }));
        }
        let data;
        try {
            data = JSON.parse(raw.replace(/[“”]/g, '"'));
        } catch (e) {
            return say(msg, ui.err('JSON tidak valid', { p: e.message }));
        }
        const res = await sendRich(client, msg.chatId, data, { edit: { chatId: msg.chatId, id: msg.id } });
        if (res.warnings.length || res.errors.length) {
            await sendRich(client, msg.chatId, ui.warn('Catatan render', { ul: [...res.warnings, ...res.errors] }));
        }
        return undefined;
    }

    async function richDemo(msg) {
        const screens = ui.richDemo();
        await sendRich(client, msg.chatId, screens[0], { edit: { chatId: msg.chatId, id: msg.id } });
        for (const s of screens.slice(1)) await sendRich(client, msg.chatId, s);
    }

    // ─────────────────────────────────────────────────────
    // COMMANDS (pesan keluar dari akun sendiri)
    // ─────────────────────────────────────────────────────
    async function handleCommand(msg) {
        const text = msg.message || '';
        if (!text.startsWith('/')) return undefined;
        const rawCmd = text.trim().split(/\s+/)[0].slice(1).split('@')[0].toLowerCase();
        const argText = argOf(text);
        const args = argText ? argText.split(/\s+/) : [];

        switch (rawCmd) {
            // ── PESAN TEKS ──
            case 'addpesan': {
                if (!argText) return say(msg, usage({ p: [{ code: '/addpesan <teks>' }] }));
                cfg.main_messages.push(argText);
                saveConfig();
                return say(msg, ui.ok(`Pesan #${cfg.main_messages.length} ditambahkan`,
                    { blockquote: { text: ui.preview(argText, 200) } }, { p: ['Total pesan teks: ', { b: String(cfg.main_messages.length) }] }));
            }
            case 'setpesan': {
                if (!argText) return say(msg, usage({ p: [{ code: '/setpesan <teks>' }] }));
                cfg.main_messages = [argText];
                cfg.current_msg_index = 0;
                saveConfig();
                return say(msg, ui.ok('Pesan utama di-set', { blockquote: { text: ui.preview(argText, 200) } }));
            }
            case 'listpesan': {
                const msgs = cfg.main_messages;
                if (!msgs.length) return say(msg, ui.empty('Belum ada pesan teks', { p: [{ code: '/addpesan <teks>' }] }));
                const pool = buildPool();
                const cur = cfg.current_msg_index % Math.max(1, pool.length);
                return say(msg, [{ h2: '📋 DAFTAR PESAN TEKS' },
                    { ol: msgs.map((m, i) => [ui.preview(m, 70), i === cur ? '  👈 berikutnya' : '']) },
                    { p: ['Total: ', { b: String(msgs.length) }] }]);
            }
            case 'delpesan': {
                const n = parseInt(args[0], 10);
                if (!n || n < 1 || n > cfg.main_messages.length) return say(msg, usage({ p: [{ code: '/delpesan <no>' }, ' — cek ', { code: '/listpesan' }] }));
                const removed = cfg.main_messages.splice(n - 1, 1)[0];
                if (cfg.current_msg_index >= buildPool().length) cfg.current_msg_index = 0;
                saveConfig();
                return say(msg, ui.ok(`Pesan #${n} dihapus`, { blockquote: { text: ui.preview(removed, 120) } }, { p: ['Sisa: ', { b: String(cfg.main_messages.length) }] }));
            }

            // ── FORWARD ──
            case 'addpesanfw': {
                const reply = await msg.getReplyMessage();
                if (!reply) {
                    return say(msg, [{ h2: 'ℹ️ CARA PAKAI /addpesanfw' },
                        { ol: ['Forward pesan dari channel/bot ke chat ini', 'Reply ke pesan forward itu', ['Ketik ', { code: '/addpesanfw [label]' }]] },
                        { p: ['Contoh: ', { code: '/addpesanfw Promo Utama' }] }]);
                }
                if (!reply.fwdFrom) return say(msg, ui.err('Bukan pesan forward', { p: 'Forward dulu pesan dari channel, lalu reply dengan /addpesanfw.' }));
                const fwList = cfg.forward_messages;
                const lbl = argText || `Pesan Forward #${fwList.length + 1}`;
                let fromId = Number(msg.chatId);
                let fromName = 'Unknown';
                if (reply.fwdFrom.fromId) {
                    const f = reply.fwdFrom.fromId;
                    fromId = Number(f.channelId || f.userId || msg.chatId);
                    fromName = reply.fwdFrom.fromName || String(fromId);
                }
                fwList.push({ label: lbl, saved_chat_id: Number(msg.chatId), saved_message_id: reply.id, from_chat_id: fromId, from_chat_name: fromName });
                saveConfig();
                return say(msg, ui.ok(`Pesan forward #${fwList.length} disimpan`,
                    ui.kv([['Label', lbl], ['Dari', fromName], ['Tersimpan', `msg ${reply.id}`]]),
                    { p: ['Total forward: ', { b: String(fwList.length) }] }));
            }
            case 'listpesanfw': {
                const fw = cfg.forward_messages;
                if (!fw.length) return say(msg, ui.empty('Belum ada pesan forward', { p: [{ code: '/addpesanfw [label]' }, ' (reply ke pesan forward)'] }));
                const pool = buildPool();
                const cur = cfg.current_msg_index % Math.max(1, pool.length);
                return say(msg, [{ h2: '📋 DAFTAR PESAN FORWARD' },
                    { ol: fw.map((f, i) => [{ b: f.label || `Forward #${i + 1}` }, ` — dari ${f.from_chat_name || 'Unknown'}`, cfg.main_messages.length + i === cur ? '  👈 berikutnya' : '']) },
                    { p: ['Total: ', { b: String(fw.length) }] }]);
            }
            case 'delpesanfw': {
                const n = parseInt(args[0], 10);
                const fw = cfg.forward_messages;
                if (!n || n < 1 || n > fw.length) return say(msg, usage({ p: [{ code: '/delpesanfw <no>' }, ' — cek ', { code: '/listpesanfw' }] }));
                const removed = fw.splice(n - 1, 1)[0];
                if (cfg.current_msg_index >= Math.max(1, buildPool().length)) cfg.current_msg_index = 0;
                saveConfig();
                return say(msg, ui.ok('Pesan forward dihapus', { p: [{ b: removed.label || `Forward #${n}` }, ` — sisa ${fw.length}`] }));
            }

            // ── GRUP ──
            case 'addgb': {
                const chatId = Number(msg.chatId);
                if (chatId > 0) return say(msg, ui.err('Bukan grup', { p: 'Perintah ini hanya bisa dipakai di dalam grup.' }));
                if (cfg.target_groups.includes(chatId)) return say(msg, ui.info('Sudah terdaftar', { p: String(chatId) }));
                cfg.target_groups.push(chatId);
                saveConfig();
                let title = '';
                try { title = (await client.getEntity(chatId)).title || ''; } catch (_) { /* abaikan */ }
                return say(msg, ui.ok('Grup ditambahkan', ui.kv([['Nama', title || '-'], ['ID', String(chatId)], ['Total grup', String(cfg.target_groups.length)]])));
            }
            case 'delgb': {
                const chatId = Number(msg.chatId);
                const i = cfg.target_groups.indexOf(chatId);
                if (i === -1) return say(msg, ui.info('Grup ini tidak ada di daftar', { p: String(chatId) }));
                cfg.target_groups.splice(i, 1);
                saveConfig();
                return say(msg, ui.ok('Grup dihapus', { p: ['Sisa: ', { b: String(cfg.target_groups.length) }] }));
            }
            case 'listgb': {
                if (!cfg.target_groups.length) return say(msg, ui.empty('Belum ada grup target', { p: [{ code: '/addgb' }, ' di dalam grup'] }));
                const rows = [];
                for (const [i, g] of cfg.target_groups.entries()) {
                    let title = '';
                    try { title = (await client.getEntity(g)).title || ''; } catch (_) { /* abaikan */ }
                    rows.push([String(i + 1), ui.preview(title || '-', 24), String(g)]);
                }
                return say(msg, [{ h2: '📋 DAFTAR GRUP TARGET' }, { table: { headers: ['No', 'Nama', 'ID'], rows } }]);
            }

            // ── ADMIN ──
            case 'admin': {
                const mode = (args[0] || '').toLowerCase();
                if (mode === 'on') {
                    cfg.admin_mode = true;
                    spamCount.clear();
                    saveConfig();
                    return say(msg, ui.ok('ADMIN ONLINE', { p: 'Auto-reply offline dimatikan dan counter spam direset.' }));
                }
                if (mode === 'off') {
                    cfg.admin_mode = false;
                    saveConfig();
                    return say(msg, ui.ok('ADMIN OFFLINE',
                        { p: 'Siapa pun yang DM akan dapat balasan otomatis.' },
                        { blockquote: { text: `Spam lebih dari ${SPAM_LIMIT} pesan = diblokir otomatis.` } }));
                }
                return say(msg, [{ h2: '👤 MODE ADMIN' }, { p: ['Status: ', { b: cfg.admin_mode ? '🟢 ONLINE' : '🔴 OFFLINE' }] },
                    { ul: [[{ code: '/admin on' }, ' — online'], [{ code: '/admin off' }, ' — offline (auto-reply + anti-spam)']] }]);
            }

            // ── NOTE ──
            case 'addnote': {
                if (!argText) {
                    return say(msg, usage({ p: [{ code: '/addnote <nama>' }, ' sambil reply pesan/foto'] },
                        { ul: [[{ code: '/addnote qris' }, ' ← reply foto QRIS'], [{ code: '/addnote promo' }, ' ← reply teks (boleh JSON rich)']] }));
                }
                const reply = await msg.getReplyMessage();
                if (!reply) return say(msg, ui.err('Harus reply', { p: 'Reply ke pesan/foto yang ingin disimpan.' }));
                const name = noteKey(argText.split(/\s+/)[0]);
                const data = { text: reply.message || null, has_media: false, media_path: null };
                if (reply.photo || reply.document || reply.sticker) {
                    fs.mkdirSync(notesDir, { recursive: true });
                    let ext = 'jpg';
                    if (reply.document && reply.document.mimeType) ext = reply.document.mimeType.split('/')[1] || 'bin';
                    const rel = path.join('notes_media', `${name}.${ext}`);
                    await say(msg, info('Mengunduh media…'));
                    try {
                        const buf = await client.downloadMedia(reply, {});
                        if (buf && buf.length) { fs.writeFileSync(path.join(dir, rel), buf); data.has_media = true; data.media_path = rel; }
                    } catch (e) { log('Gagal download media:', e.message); }
                }
                if (!data.text && !data.has_media) return say(msg, ui.err('Pesan kosong', { p: 'Yang di-reply tidak punya teks atau media.' }));
                cfg.notes[name] = data;
                saveConfig();
                return say(msg, ui.ok(`Note '${name}' disimpan`,
                    ui.kv([['Teks', data.text ? ui.preview(data.text, 40) : '-'], ['Media', data.has_media ? 'tersimpan' : '-']]),
                    { p: ['Kirim dengan ', { code: `/${name}` }] }));
            }
            case 'listnote': {
                const keys = Object.keys(cfg.notes);
                if (!keys.length) return say(msg, ui.empty('Belum ada note', { p: [{ code: '/addnote <nama>' }, ' (reply pesan/foto)'] }));
                return say(msg, [{ h2: '📋 DAFTAR NOTE' },
                    { ul: keys.map(k => { const n = cfg.notes[k]; return [{ code: `/${k}` }, ` ${n.has_media ? (n.text ? '📸📝' : '🖼️') : '📝'}`, n.text ? ` ${ui.preview(n.text, 40)}` : '']; }) },
                    { p: ['Total: ', { b: String(keys.length) }] }]);
            }
            case 'delnote': {
                if (!argText) return say(msg, usage({ p: [{ code: '/delnote <nama>' }] }));
                const name = noteKey(args[0]);
                const n = cfg.notes[name];
                if (!n) return say(msg, ui.err('Tidak ditemukan', { p: ['Note ', { code: name }, ' tidak ada.'] }));
                if (n.has_media && n.media_path) {
                    const p = path.isAbsolute(n.media_path) ? n.media_path : path.join(dir, n.media_path);
                    try { fs.unlinkSync(p); } catch (_) { /* abaikan */ }
                }
                delete cfg.notes[name];
                saveConfig();
                return say(msg, ui.ok('Note dihapus', { p: [{ code: name }] }));
            }
            case 'note': {
                if (!argText) return say(msg, usage({ p: [{ code: '/note <nama>' }, ' atau langsung ', { code: '/<nama>' }] }));
                return sendNote(msg, noteKey(args[0]));
            }

            // ── RICH ──
            case 'rich': return richCommand(msg, argText);
            case 'richdemo': return richDemo(msg);

            // ── CLONE ──
            case 'clonebot': return isMain ? cloneCommand(msg) : undefined;
            case 'listclone': case 'stopclone': case 'startclone': case 'delclone': case 'cancel':
                return isMain ? cloneAdmin(msg, rawCmd, args) : undefined;

            // ── KONTROL ──
            case 'auto': {
                const mode = (args[0] || '').toLowerCase();
                if (mode === 'on' || mode === 'off') {
                    cfg.is_auto_active = mode === 'on';
                    saveConfig();
                    return say(msg, ui.ok(`AUTO POST ${mode === 'on' ? 'AKTIF' : 'MATI'}`,
                        { p: mode === 'on' ? 'Posting & reply otomatis aktif. Operasional 03:00–00:00 WIB.' : 'Posting otomatis dimatikan.' }));
                }
                return say(msg, [{ h2: '🤖 AUTO POST' }, { p: ['Status: ', { b: cfg.is_auto_active ? '🟢 AKTIF' : '🔴 NON-AKTIF' }] },
                    { ul: [[{ code: '/auto on' }, ' — aktifkan'], [{ code: '/auto off' }, ' — matikan']] }]);
            }
            case 'status': return say(msg, ui.statusScreen(statusData()));
            case 'help': return say(msg, ui.helpScreen({ isMain }));

            default:
                if (cfg.notes[rawCmd]) return sendNote(msg, rawCmd);
                return undefined;
        }
    }

    function info(t) { return ui.info(t); }

    function statusData() {
        const pool = buildPool();
        let next = '-';
        if (pool.length) {
            const i = cfg.current_msg_index % pool.length;
            next = pool[i].type === 'text' ? `Teks #${i + 1}` : `Forward: ${pool[i].content.label || 'FW'}`;
        }
        const mgr = ctx.manager;
        return {
            label, isMain, auto: cfg.is_auto_active, admin: cfg.admin_mode, time: wibTimeStr(), night: isNightTime(),
            texts: cfg.main_messages.length, forwards: cfg.forward_messages.length, pool: pool.length, next,
            groups: cfg.target_groups.length, notes: Object.keys(cfg.notes).length,
            clonesRunning: mgr ? mgr.runningIds().size : 0, clonesTotal: mgr ? mgr.list().length : 0
        };
    }

    // ─────────────────────────────────────────────────────
    // EVENT: OUTGOING
    // ─────────────────────────────────────────────────────
    async function onOutgoing(event) {
        try {
            const msg = event.message;
            const text = msg.message || '';
            if (inlineFlow && String(msg.chatId) === inlineFlow.chatId && text && !BOT_SCREEN_PREFIX.test(text)) {
                const flow = inlineFlow;
                client.deleteMessages(msg.chatId, [msg.id], { revoke: true }).catch(() => {});
                if (text.trim().toLowerCase() === '/cancel') { if (ctx.manager) ctx.manager.cancel(); return; }
                flow.resolve(text);
                return;
            }
            await handleCommand(msg);
        } catch (e) {
            log('Command handler error:', e.message);
        }
    }

    // ─────────────────────────────────────────────────────
    // EVENT: INCOMING (auto-reply admin offline + anti-spam)
    // ─────────────────────────────────────────────────────
    async function onIncoming(event) {
        try {
            if (cfg.admin_mode) return;
            const msg = event.message;
            if (!msg.isPrivate || msg.out) return;
            const chatId = Number(msg.chatId);
            if (chatId <= 0 || chatId === TELEGRAM_SERVICE_ID) return;
            let sender = null;
            try { sender = await msg.getSender(); } catch (_) { /* abaikan */ }
            if (!sender || sender.bot || sender.self || Number(sender.id) === TELEGRAM_SERVICE_ID) return;

            const key = String(chatId);
            const count = (spamCount.get(key) || 0) + 1;
            spamCount.set(key, count);

            if (count > SPAM_LIMIT) {
                try {
                    await sendRich(client, chatId, ui.spamBlocked());
                    await client.invoke(new Api.contacts.Block({ id: await client.getInputEntity(chatId) }));
                    log(`🚫 User ${key} diblokir (${count} pesan)`);
                } catch (e) { log('Gagal blokir user:', e.message); }
                return;
            }
            if (count === SPAM_LIMIT) { await sendRich(client, chatId, ui.spamWarning()); return; }
            if (count === 1 || count === 3) await sendRich(client, chatId, ui.offlineScreen());
        } catch (e) {
            log('Incoming handler error:', e.message);
        }
    }

    // ─────────────────────────────────────────────────────
    // LIFECYCLE
    // ─────────────────────────────────────────────────────
    return {
        label,
        get cfg() { return cfg; },
        statusData,
        async start() {
            stopped = false;
            fs.mkdirSync(notesDir, { recursive: true });
            client.addEventHandler(onOutgoing, outB);
            client.addEventHandler(onIncoming, inB);
            autoPostLoop().catch(e => log('Loop berhenti:', e.message));
            log(`✅ Aktif — admin ${cfg.admin_mode ? 'online' : 'offline'}`);
        },
        async stop() {
            stopped = true;
            try { client.removeEventHandler(onOutgoing, outB); } catch (_) { /* abaikan */ }
            try { client.removeEventHandler(onIncoming, inB); } catch (_) { /* abaikan */ }
        },
        // untuk test
        _handleCommand: handleCommand,
        _onIncoming: onIncoming,
        _onOutgoing: onOutgoing
    };
}

module.exports = { createUserbot };
