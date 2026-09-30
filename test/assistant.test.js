const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { startAssistant } = require('../assistant');
const { CloneManager } = require('../clone');
const VALID = '1' + Buffer.concat([Buffer.from([2, 149, 154, 167, 50, 1, 187]), Buffer.alloc(256, 7)]).toString('base64');

(async () => {
    const calls = []; let nid = 100;
    const bot = {
        start: async () => {}, getMe: async () => ({ username: 'arta_bot' }),
        sendMessage: async (p, o) => { calls.push(['send', p, o]); return { id: ++nid }; },
        editMessage: async (c, o) => { calls.push(['edit', c, o]); return { id: o.message }; },
        deleteMessages: async (...a) => { calls.push(['del', ...a]); },
        addEventHandler: () => {}, disconnect: async () => {}
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'as-'));
    const started = [];
    const mgr = new CloneManager({
        apiId: 1, apiHash: 'h', dataDir: dir, mainId: 1, log: () => {},
        createUserbot: ({ label }) => ({ start: async () => started.push(label), stop: async () => {} }),
        makeClient: () => ({ session: { save: () => VALID }, connect: async () => {}, disconnect: async () => {}, invoke: async () => ({}),
            async start(p) { await p.phoneNumber(); await p.phoneCode(false); return { id: 888, firstName: 'Dewi' }; } })
    });
    const a = await startAssistant({ apiId: 1, apiHash: 'h', token: 't', ownerId: 10, manager: mgr, makeBot: () => bot, log: () => {},
        getMainBot: () => ({ statusData: () => ({ label: 'M', isMain: true, auto: true, admin: true, time: 't', night: false, texts: 1, forwards: 0, pool: 1, next: 'x', groups: 2, notes: 0, clonesRunning: 0, clonesTotal: 0 }) }) });
    const msg = (text, sender = 10) => ({ message: { isPrivate: true, out: false, chatId: 10, senderId: sender, id: ++nid, message: text } });
    const last = () => { const l = calls[calls.length - 1]; return l[2]; };
    const cb = (data, sender = 10) => { const answers = []; return { senderId: sender, chatId: 10, messageId: 55, data: Buffer.from(data), answers, answer: async (o) => answers.push(o) }; };

    // bukan pemilik
    await a._onMessage(msg('/start', 99)); assert(last().message.includes('Bot privat')); const n = calls.length;
    await a._onMessage(msg('/start', 99)); assert.strictEqual(calls.length, n, 'hanya sekali');
    const c = cb('menu', 99); await a._onCallback(c); assert(c.answers[0].alert);

    // menu dengan tombol
    await a._onMessage(msg('/start'));
    const rows = last().buttons.rows; assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0].buttons[0].className, 'KeyboardButtonCallback');
    assert(last().message.includes('PANEL USERBOT'));

    // alur clone via tombol
    calls.length = 0;
    const flow = a._onCallback(cb('clone'));
    await new Promise(r => setTimeout(r, 20));
    assert(calls.find(x => x[0] === 'edit').at(-1).text.includes('+628123456789'));
    // Catatan: flow selesai hanya setelah input; kirim nomor & kode
    await a._onMessage(msg('0812 111 222 333')); await new Promise(r => setTimeout(r, 20));
    assert(calls.some(x => x[0] === 'del'), 'pesan nomor dihapus');
    await a._onMessage(msg('1-2-3-4-5')); await flow;
    await new Promise(r => setTimeout(r, 20));
    assert(calls.filter(x => x[0] === 'edit').at(-1)[2].text.includes('CLONE BERHASIL'));
    assert.deepStrictEqual(started, ['Dewi']);

    // daftar + stop + hapus dengan konfirmasi
    await a._onCallback(cb('list'));
    let ed = calls.filter(x => x[0] === 'edit').at(-1)[2];
    assert(ed.text.includes('Dewi') && ed.buttons.rows[0].buttons[0].text.includes('Stop'));
    await a._onCallback(cb('stop:888')); assert(!mgr.runningIds().has('888'));
    await a._onCallback(cb('del:888')); ed = calls.filter(x => x[0] === 'edit').at(-1)[2];
    assert(ed.text.includes('Hapus clone?') && ed.buttons.rows[0].buttons[0].text.includes('Ya'));
    await a._onCallback(cb('delok:888')); assert.strictEqual(mgr.list().length, 0);

    // batal saat flow
    calls.length = 0;
    const f2 = a._onCallback(cb('clone')); await new Promise(r => setTimeout(r, 20));
    await a._onCallback(cb('cancel')); await f2;
    assert(calls.filter(x => x[0] === 'edit').at(-1)[2].text.includes('dibatalkan'));
    console.log('assistant OK');
})().catch(e => { console.error(e); process.exit(1); });
