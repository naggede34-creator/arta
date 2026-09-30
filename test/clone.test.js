const assert = require('assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { CloneManager, normalizePhone } = require('../clone');
const VALID = '1' + Buffer.concat([Buffer.from([2, 149, 154, 167, 50, 1, 187]), Buffer.alloc(256, 7)]).toString('base64');

assert.strictEqual(normalizePhone('0812-3456 7890'), '+6281234567890');
assert.strictEqual(normalizePhone('+62 812 3456 7890'), '+6281234567890');
assert.throws(() => normalizePhone('abc'), /PHONE_NUMBER_INVALID/);

// klien palsu yang meniru signInUser gramjs (termasuk menelan error phoneCode)
function fakeFactory({ goodCode = '12345', password = null, userId = 555 }) {
    return () => ({
        session: { save: () => VALID },
        connect: async () => {}, disconnect: async () => {},
        isUserAuthorized: async () => true, invoke: async () => ({}),
        getMe: async () => ({ id: userId, firstName: 'Budi', username: 'budi' }),
        async start(p) {
            let phone;
            for (;;) { try { phone = await p.phoneNumber(); break; } catch (e) { if (await p.onError(e)) throw new Error('AUTH_USER_CANCEL'); } }
            let phoneCode = '';
            for (;;) {
                try {
                    try { phoneCode = await p.phoneCode(true); } catch (_) {}
                    if (!phoneCode) throw new Error('Code is empty');
                    if (phoneCode !== goodCode) { const e = new Error('x'); e.errorMessage = 'PHONE_CODE_INVALID'; throw e; }
                    if (password) {
                        for (;;) {
                            try {
                                const pw = await p.password('hint');
                                if (!pw) throw new Error('Password is empty');
                                if (pw !== password) { const e = new Error('x'); e.errorMessage = 'PASSWORD_HASH_INVALID'; throw e; }
                                return { id: userId, firstName: 'Budi', username: 'budi' };
                            } catch (e) { if (await p.onError(e)) throw new Error('AUTH_USER_CANCEL'); }
                        }
                    }
                    return { id: userId, firstName: 'Budi', username: 'budi' };
                } catch (e) { if (await p.onError(e)) throw new Error('AUTH_USER_CANCEL'); }
            }
        }
    });
}

const mk = (opts) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clone-'));
    const started = [];
    const m = new CloneManager({
        apiId: 1, apiHash: 'h', dataDir: dir, mainId: 1,
        createUserbot: ({ label }) => ({ start: async () => started.push(label), stop: async () => {} }),
        makeClient: fakeFactory(opts), log: () => {}
    });
    return { m, dir, started };
};
const scripted = (answers, events) => ({
    ask: async (step, meta) => { events.push(['ask', step]); const a = answers[step].shift(); if (a === undefined) throw new Error('no answer'); return a; },
    notify: async (ev, d) => events.push([ev, d.code])
});

(async () => {
    // sukses: kode salah dulu, lalu benar; A2F salah lalu benar
    let { m, dir, started } = mk({ password: 'rahasia' });
    let ev = [];
    const rec = await m.login(scripted({ phone: ['0812 3456 7890'], code: ['9-9-9-9-9', '1-2-3-4-5'], password: ['salah', 'rahasia'] }, ev));
    assert.strictEqual(rec.id, '555'); assert.strictEqual(rec.phone, '+6281234567890');
    assert.deepStrictEqual(ev.filter(e => e[0] === 'retry').map(e => e[1]), ['PHONE_CODE_INVALID', 'PASSWORD_HASH_INVALID']);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'sessions', '555.session'), 'utf8'), VALID);
    assert.deepStrictEqual(started, ['Budi']); assert(m.runningIds().has('555'));
    assert(!JSON.stringify(JSON.parse(fs.readFileSync(path.join(dir, 'clones.json'), 'utf8'))).includes('rahasia'), 'password tidak disimpan');
    assert.strictEqual(m.busy(), false);

    // stop/start/remove
    await m.stop('555'); assert(!m.runningIds().has('555'));
    await m.start('555'); assert(m.runningIds().has('555'));
    await m.remove('555'); assert.strictEqual(m.list().length, 0); assert(!fs.existsSync(path.join(dir, 'sessions', '555.session')));

    // nomor invalid → retry → sukses
    ({ m } = mk({}));
    ev = [];
    await m.login(scripted({ phone: ['xx', '+628111222333'], code: ['12345'] }, ev));
    assert.deepStrictEqual(ev.filter(e => e[0] === 'retry').map(e => e[1]), ['PHONE_NUMBER_INVALID']);

    // pembatalan saat menunggu kode → tidak looping, error CANCELLED
    ({ m } = mk({}));
    let calls = 0;
    const p = m.login({
        ask: (step) => { calls++; if (step === 'phone') return Promise.resolve('+628111222333'); return new Promise(() => {}); },
        notify: async () => {}
    });
    await new Promise(r => setTimeout(r, 30));
    assert(m.busy()); assert(m.cancel());
    await assert.rejects(p, e => e.code === 'CANCELLED');
    assert.strictEqual(m.busy(), false); assert(calls <= 3, 'calls=' + calls);

    // akun utama ditolak
    ({ m } = mk({ userId: 1 }));
    await assert.rejects(m.login(scripted({ phone: ['+628111222333'], code: ['12345'] }, [])), e => e.code === 'SAME_ACCOUNT');
    assert.strictEqual(m.list().length, 0);

    // kode kadaluarsa (fatal) tidak di-retry
    ({ m } = mk({}));
    const f = mk({}).m; f.makeClient = () => ({ connect: async () => {}, disconnect: async () => {}, session: { save: () => '' },
        async start(p) { await p.phoneNumber(); await p.phoneCode(); const e = new Error('x'); e.errorMessage = 'PHONE_CODE_EXPIRED'; if (await p.onError(e)) throw new Error('AUTH_USER_CANCEL'); } });
    await assert.rejects(f.login(scripted({ phone: ['+628111222333'], code: ['12345'] }, [])), e => e.code === 'PHONE_CODE_EXPIRED');
    console.log('clone OK');
})().catch(e => { console.error(e); process.exit(1); });
