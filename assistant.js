/**
 * Assistant Bot — panel dengan tombol inline (hanya akun BOT yang boleh kirim tombol)
 * Opsional: aktif jika BOT_TOKEN diisi di .env (buat lewat @BotFather).
 */
'use strict';

const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const { CallbackQuery } = require('telegram/events/CallbackQuery');
const { sendRich } = require('./richmsg');
const ui = require('./ui');

const INPUT_TIMEOUT_MS = 5 * 60 * 1000;
const B = (text, callback) => ({ text, callback });
const NAV = [[B('🏠 Menu', 'menu')]];

async function startAssistant({ apiId, apiHash, token, ownerId, manager, getMainBot, log = console.log, makeBot }) {
    const bot = makeBot ? makeBot() : new TelegramClient(new StringSession(''), apiId, apiHash, { connectionRetries: 5 });
    await bot.start({ botAuthToken: token });
    const me = await bot.getMe();
    const owner = String(ownerId);
    let flow = null;
    const denied = new Set();

    const show = (chatId, id, rich, rows) =>
        sendRich(bot, chatId, [...rich, ...(rows ? [{ buttons: rows }] : [])], { keyboard: true, edit: id ? { chatId, id } : undefined })
            .catch(e => { log('[assistant] gagal kirim:', e.message); return { sent: [] }; });

    // ── layar ───────────────────────────────────────────
    const menuRich = () => {
        const main = getMainBot && getMainBot();
        const s = main ? main.statusData() : null;
        return [
            { h1: '🤖 PANEL USERBOT' },
            { p: ['Kelola akun utama dan clone bot lewat tombol di bawah.'] },
            ...(s ? [ui.kv([
                ['Auto Post', s.auto ? 'AKTIF' : 'NON-AKTIF'], ['Mode Admin', s.admin ? 'ONLINE' : 'OFFLINE'],
                ['Clone aktif', `${s.clonesRunning}/${s.clonesTotal}`], ['Grup target', String(s.groups)]
            ])] : []),
            ui.foot()
        ];
    };
    const menuRows = () => [
        [B('📲 Clone Bot', 'clone'), B('📋 Daftar Clone', 'list')],
        [B('📊 Status', 'status'), B('📖 Bantuan', 'help')]
    ];

    const listScreen = () => {
        const list = manager.list();
        const running = manager.runningIds();
        const rows = [];
        list.forEach((r, i) => {
            const on = running.has(r.id);
            rows.push([
                on ? B(`⏹ Stop #${i + 1}`, `stop:${r.id}`) : B(`▶️ Start #${i + 1}`, `start:${r.id}`),
                B(`🗑 Hapus #${i + 1}`, `del:${r.id}`)
            ]);
        });
        rows.push([B('📲 Tambah Clone', 'clone'), B('🏠 Menu', 'menu')]);
        return { rich: ui.cloneList(list, running), rows };
    };

    // ── alur clone (adapter bot) ────────────────────────
    async function runClone(chatId, panelId) {
        if (manager.busy()) {
            return show(chatId, panelId, ui.warn('Proses clone sedang berjalan', { p: 'Selesaikan atau batalkan dulu.' }), [[B('❌ Batalkan', 'cancel')], ...NAV]);
        }
        let warnBlock = [];
        const io = {
            ask(step, meta) {
                return new Promise((resolve) => {
                    const timer = setTimeout(() => { flow = null; resolve(Promise.reject(new Error('TIMEOUT'))); }, INPUT_TIMEOUT_MS);
                    flow = { chatId: String(chatId), resolve: v => { clearTimeout(timer); flow = null; resolve(v); }, stop: () => clearTimeout(timer) };
                    show(chatId, panelId, [...warnBlock, ...ui.clonePrompt(step, meta)], [[B('❌ Batalkan', 'cancel')]]);
                    warnBlock = [];
                });
            },
            notify: async (ev, d) => { if (ev === 'retry') warnBlock = ui.cloneRetry(d.code); }
        };
        try {
            const rec = await manager.login(io);
            await show(chatId, panelId, ui.cloneDone(rec), [[B('📋 Daftar Clone', 'list'), B('🏠 Menu', 'menu')]]);
        } catch (e) {
            await show(chatId, panelId, ui.cloneFail(e.code || e.message), [[B('🔁 Coba Lagi', 'clone'), B('🏠 Menu', 'menu')]]);
        } finally {
            if (flow) { flow.stop(); flow = null; }
        }
        return undefined;
    }

    // ── pesan masuk ─────────────────────────────────────
    async function onMessage(event) {
        try {
            const msg = event.message;
            if (!msg.isPrivate || msg.out) return;
            const chatId = msg.chatId;
            const sender = String(msg.senderId);
            if (sender !== owner) {
                if (!denied.has(sender)) {
                    denied.add(sender);
                    await sendRich(bot, chatId, [{ h3: '🔒 Bot privat' }, { p: 'Bot ini hanya bisa dipakai oleh pemiliknya.' }]);
                }
                return;
            }
            const text = (msg.message || '').trim();

            if (flow && flow.chatId === String(chatId) && text && !text.startsWith('/')) {
                const f = flow;
                bot.deleteMessages(chatId, [msg.id], { revoke: true }).catch(() => {});
                f.resolve(text);
                return;
            }
            const cmd = text.split(/\s+/)[0].toLowerCase().split('@')[0];
            const arg = text.split(/\s+/)[1] || '';
            if (cmd === '/cancel') {
                await sendRich(bot, chatId, manager.cancel() ? ui.ok('Dibatalkan') : ui.info('Tidak ada proses yang berjalan'));
                return;
            }
            if (cmd === '/clonebot' || (cmd === '/start' && arg === 'clone')) {
                const res = await show(chatId, null, ui.info('Menyiapkan clone…'));
                await runClone(chatId, res.sent[0] && res.sent[0].id);
                return;
            }
            if (cmd === '/start' || cmd === '/menu') { await show(chatId, null, menuRich(), menuRows()); return; }
            if (cmd === '/help') { await show(chatId, null, ui.helpScreen({ isMain: true }), NAV); return; }
            if (cmd === '/status') { const m = getMainBot && getMainBot(); await show(chatId, null, m ? ui.statusScreen(m.statusData()) : ui.info('Belum siap'), NAV); return; }
            if (cmd === '/listclone') { const l = listScreen(); await show(chatId, null, l.rich, l.rows); }
        } catch (e) {
            log('[assistant] error pesan:', e.message);
        }
    }

    // ── tombol ──────────────────────────────────────────
    async function onCallback(event) {
        try {
            if (String(event.senderId) !== owner) {
                await event.answer({ message: '🔒 Bot ini privat', alert: true });
                return;
            }
            const data = Buffer.from(event.data || '').toString();
            const chatId = event.chatId;
            const id = event.messageId;
            const [action, arg] = data.split(':');
            const done = (message) => event.answer(message ? { message } : {}).catch(() => {});

            switch (action) {
                case 'menu': await done(); await show(chatId, id, menuRich(), menuRows()); break;
                case 'help': await done(); await show(chatId, id, ui.helpScreen({ isMain: true }), NAV); break;
                case 'status': {
                    await done();
                    const m = getMainBot && getMainBot();
                    await show(chatId, id, m ? ui.statusScreen(m.statusData()) : ui.info('Belum siap'), NAV);
                    break;
                }
                case 'list': { await done(); const l = listScreen(); await show(chatId, id, l.rich, l.rows); break; }
                case 'clone': await done(); await runClone(chatId, id); break;
                case 'cancel': await done(manager.cancel() ? 'Dibatalkan' : 'Tidak ada proses'); break;
                case 'stop': case 'start': {
                    await done(action === 'stop' ? 'Menghentikan…' : 'Menjalankan…');
                    try { await manager[action](arg); } catch (e) { await event.answer({ message: ui.cloneErrorText(e.code || e.message), alert: true }).catch(() => {}); }
                    const l = listScreen(); await show(chatId, id, l.rich, l.rows);
                    break;
                }
                case 'del': {
                    await done();
                    const rec = manager.list().find(r => r.id === arg);
                    await show(chatId, id, ui.warn('Hapus clone?', { p: [{ b: rec ? rec.name : arg }, ' akan di-logout dan datanya dihapus.'] }),
                        [[B('✅ Ya, hapus', `delok:${arg}`), B('↩️ Batal', 'list')]]);
                    break;
                }
                case 'delok': {
                    await done('Menghapus…');
                    try { await manager.remove(arg); } catch (e) { await event.answer({ message: ui.cloneErrorText(e.code || e.message), alert: true }).catch(() => {}); }
                    const l = listScreen(); await show(chatId, id, l.rich, l.rows);
                    break;
                }
                default: await done();
            }
        } catch (e) {
            log('[assistant] error tombol:', e.message);
        }
    }

    bot.addEventHandler(onMessage, new NewMessage({ incoming: true }));
    bot.addEventHandler(onCallback, new CallbackQuery({}));
    log(`🤖 Assistant bot aktif: @${me.username}`);

    return {
        username: me.username,
        client: bot,
        async stop() { try { await bot.disconnect(); } catch (_) { /* abaikan */ } },
        _onMessage: onMessage,
        _onCallback: onCallback
    };
}

module.exports = { startAssistant };
