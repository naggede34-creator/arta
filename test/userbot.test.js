const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { createUserbot } = require('../userbot');
const { CloneManager } = require('../clone');

const VALID = '1' + Buffer.concat([Buffer.from([2, 149, 154, 167, 50, 1, 187]), Buffer.alloc(256, 7)]).toString('base64');
const mkClient = () => {
    const c = { calls: [], handlers: [] };
    const rec = name => async (...a) => { c.calls.push([name, ...a]); return { id: 500 + c.calls.length }; };
    Object.assign(c, {
        sendMessage: rec('send'), editMessage: rec('edit'), deleteMessages: rec('del'), sendFile: rec('file'),
        invoke: async (r) => { c.calls.push(['invoke', r.className]); return {}; },
        getEntity: async () => ({ title: 'Grup A' }), getInputEntity: async () => ({}),
        addEventHandler: (cb, b) => c.handlers.push([cb, b]), removeEventHandler: () => {},
        downloadMedia: async () => Buffer.from('PNGDATA')
    });
    c.last = (n) => c.calls.filter(x => x[0] === n).pop();
    c.text = () => { const l = c.calls.filter(x => x[0] === 'edit' || x[0] === 'send').pop(); return l ? (l[2].text || l[2].message) : ''; };
    return c;
};
const M = (text, extra = {}) => ({ chatId: 42, id: 7, message: text, getReplyMessage: async () => extra.reply || null, ...extra });

(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ub-'));
    const client = mkClient();
    const bot = createUserbot({ client, dir, label: 'Main', isMain: true, ctx: {} });
    const cmd = (t, e) => bot._handleCommand(M(t, e));

    // teks + multi-baris dipertahankan
    await cmd('/addpesan Halo\nBaris dua   spasi');
    assert.strictEqual(bot.cfg.main_messages[0], 'Halo\nBaris dua   spasi');
    assert(client.text().includes('Pesan #1 ditambahkan'));
    await cmd('/listpesan'); assert(client.text().includes('DAFTAR PESAN TEKS'));
    await cmd('/delpesan 1'); assert.strictEqual(bot.cfg.main_messages.length, 0);
    await cmd('/addpesan'); assert(client.text().includes('Format salah'));

    // forward
    await cmd('/addpesanfw', { reply: { id: 9, fwdFrom: null } }); assert(client.text().includes('Bukan pesan forward'));
    await cmd('/addpesanfw Promo', { reply: { id: 9, fwdFrom: { fromId: { channelId: 123 }, fromName: 'Chan' } } });
    assert.strictEqual(bot.cfg.forward_messages[0].saved_message_id, 9);
    await cmd('/listpesanfw'); assert(client.text().includes('Promo'));

    // grup
    await cmd('/addgb'); assert(client.text().includes('Bukan grup'));
    await bot._handleCommand({ ...M('/addgb'), chatId: -100123 });
    assert.deepStrictEqual(bot.cfg.target_groups, [-100123]);
    await bot._handleCommand({ ...M('/listgb'), chatId: -100123 }); assert(client.text().includes('Grup A'));

    // note teks + media + dinamis + json rich
    await cmd('/addnote info', { reply: { message: 'Teks info' } });
    await cmd('/info'); assert(client.last('send') && client.last('send')[2].message === 'Teks info');
    await cmd('/addnote qris', { reply: { message: 'Bayar ya', photo: {} } });
    const n = bot.cfg.notes.qris; assert(n.has_media && n.media_path === path.join('notes_media', 'qris.jpg'));
    assert(fs.existsSync(path.join(dir, n.media_path)));
    await cmd('/qris'); const f = client.last('file'); assert(f[2].file.endsWith('qris.jpg') && f[2].caption === 'Bayar ya');
    await cmd('/addnote kartu', { reply: { message: '[{"h2":"Promo"},{"p":["Harga ",{"b":"10rb"}]}]' } });
    await cmd('/kartu'); assert(client.text().includes('Harga 10rb'));
    await cmd('/listnote'); assert(client.text().includes('/qris'));
    await cmd('/delnote qris'); assert(!bot.cfg.notes.qris && !fs.existsSync(path.join(dir, n.media_path)));

    // rich
    await cmd('/rich [{"h2":"Halo"},{"p":["A ",{"b":"B"}]}]'); assert(client.text().includes('Halo') && client.text().includes('A B'));
    await cmd('/rich {bukan json'); assert(client.text().includes('JSON tidak valid'));
    await cmd('/rich “[{"p":"kutip pintar"}]”'.replace('“[', '[').replace(']”', ']'));
    await cmd('/richdemo'); assert(client.calls.some(c => c[0] === 'send'));

    // auto / status / help / admin
    await cmd('/auto on'); assert.strictEqual(bot.cfg.is_auto_active, true);
    await cmd('/status'); assert(client.text().includes('STATUS USERBOT'));
    await cmd('/help'); assert(client.text().includes('PANDUAN') || client.last('edit')[2].text.includes('PANDUAN'));
    await cmd('/admin off'); assert.strictEqual(bot.cfg.admin_mode, false);

    // persist
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bot_config.json'))).admin_mode, false);

    // ── INCOMING anti-spam ──
    client.calls.length = 0;
    const inc = (id, sender = {}) => bot._onIncoming({ message: { isPrivate: true, out: false, chatId: id, getSender: async () => ({ id, bot: false, ...sender }) } });
    for (let i = 0; i < 6; i++) await inc(1001);
    const sends = client.calls.filter(c => c[0] === 'send');
    assert.strictEqual(sends.length, 4, 'offline@1, offline@3, warn@5, blocked@6 → ' + sends.length);
    assert(client.calls.some(c => c[0] === 'invoke' && c[1] === 'contacts.Block'), 'blocked');
    client.calls.length = 0;
    for (let i = 0; i < 8; i++) await inc(2002, { bot: true });
    for (let i = 0; i < 8; i++) await inc(777000);
    assert.strictEqual(client.calls.length, 0, 'bot & 777000 diabaikan');
    await bot._handleCommand(M('/admin on')); client.calls.length = 0; await inc(3003); assert.strictEqual(client.calls.length, 0);

    // ── CLONEBOT inline via event keluar ──
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ub2-'));
    const c2 = mkClient(); const started = [];
    const mgr = new CloneManager({
        apiId: 1, apiHash: 'h', dataDir: dir2, mainId: 1, log: () => {},
        createUserbot: ({ label }) => ({ start: async () => started.push(label), stop: async () => {} }),
        makeClient: () => ({
            session: { save: () => VALID }, connect: async () => {}, disconnect: async () => {},
            async start(p) { await p.phoneNumber(); const code = await p.phoneCode(true); assert.strictEqual(code, '12345'); await p.password('h'); return { id: 777, firstName: 'Sari', username: 'sari' }; }
        })
    });
    const main = createUserbot({ client: c2, dir: dir2 + '/main', label: 'Main', isMain: true, ctx: { manager: mgr } });
    await main.start();
    const out = (t, id) => main._onOutgoing({ message: { chatId: 99, id, message: t, getReplyMessage: async () => null } });
    const flow = out('/clonebot', 1);
    const wait = () => new Promise(r => setTimeout(r, 20));
    await wait(); assert(c2.text().includes('+628123456789'), 'prompt nomor');
    await out('0812 000 111 222', 2); await wait();
    assert(c2.calls.some(c => c[0] === 'del' && c[2][0] === 2), 'pesan nomor dihapus');
    assert(c2.text().includes('1-2-3-4-5'), 'prompt kode');
    await out('1-2-3-4-5', 3); await wait();
    assert(c2.text().includes('A2F'), 'prompt 2fa');
    await out('passwordku', 4); await flow;
    assert(c2.text().includes('CLONE BERHASIL') && c2.text().includes('Sari'));
    assert.deepStrictEqual(started, ['Sari']);
    assert(!fs.readFileSync(path.join(dir2, 'clones.json'), 'utf8').includes('passwordku'));
    await out('/listclone', 5); assert(c2.text().includes('Sari'));
    await out('/stopclone 1', 6); assert(c2.text().includes('dihentikan'));
    await out('/delclone 1', 7); assert.strictEqual(mgr.list().length, 0);
    // clone tidak boleh /clonebot
    const clone = createUserbot({ client: mkClient(), dir: dir2 + '/cl', label: 'Sari', isMain: false, ctx: { manager: mgr } });
    await clone._handleCommand(M('/clonebot')); await clone._handleCommand(M('/listclone'));
    await main.stop();
    console.log('userbot OK');
})().catch(e => { console.error(e); process.exit(1); });
