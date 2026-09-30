/**
 * Clone Manager — menjalankan banyak akun userbot sekaligus
 *
 * Alur login (transport-agnostik) lewat objek `io`:
 *   io.ask(step, meta)    → Promise<string>   step: 'phone' | 'code' | 'password'
 *   io.notify(event, data)→ Promise<void>     event: 'retry' { code }
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Api, TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

const RETRYABLE = new Set(['PHONE_NUMBER_INVALID', 'PHONE_CODE_INVALID', 'PHONE_CODE_EMPTY', 'PASSWORD_HASH_INVALID']);
const MAX_RETRIES = 6;

class CloneError extends Error {
    constructor(code) { super(code); this.code = code; }
}

function errCode(e) {
    if (!e) return 'UNKNOWN';
    if (e.seconds && /FLOOD/.test(e.errorMessage || '')) return `FLOOD_WAIT_${e.seconds}`;
    return String(e.errorMessage || e.message || 'UNKNOWN');
}

function normalizePhone(raw) {
    let s = String(raw || '').replace(/[\s\-().]/g, '');
    if (s.startsWith('+')) s = s.slice(1);
    else if (s.startsWith('0')) s = '62' + s.slice(1);
    if (!/^\d{8,15}$/.test(s)) throw new Error('PHONE_NUMBER_INVALID');
    return '+' + s;
}

function codeDigits(raw) {
    return String(raw || '').replace(/\D/g, '');
}

class CloneManager {
    /**
     * @param {object} o
     * @param {number} o.apiId
     * @param {string} o.apiHash
     * @param {string} o.dataDir           folder data (clones.json, sessions/, <id>/)
     * @param {function} o.createUserbot   ({client, dir, label, isMain:false}) → { start(), stop() }
     * @param {string|number} o.mainId     id akun utama (tidak boleh di-clone)
     * @param {function} [o.makeClient]    (session) → TelegramClient  (untuk test)
     */
    constructor({ apiId, apiHash, dataDir, createUserbot, mainId, makeClient, log }) {
        this.apiId = apiId;
        this.apiHash = apiHash;
        this.dataDir = dataDir;
        this.sessionsDir = path.join(dataDir, 'sessions');
        this.dbFile = path.join(dataDir, 'clones.json');
        this.createUserbot = createUserbot;
        this.mainId = String(mainId);
        this.log = log || console.log;
        this.makeClient = makeClient || (session => new TelegramClient(session, apiId, apiHash, {
            connectionRetries: 5, deviceModel: 'Arta Userbot', appVersion: '2.1'
        }));
        this.records = [];
        this.running = new Map();
        this.active = null;
        fs.mkdirSync(this.sessionsDir, { recursive: true });
        this.load();
    }

    // ── DB ──────────────────────────────────────────────
    load() {
        try {
            const d = JSON.parse(fs.readFileSync(this.dbFile, 'utf8'));
            this.records = Array.isArray(d.clones) ? d.clones : [];
        } catch (_) { this.records = []; }
    }

    save() {
        fs.writeFileSync(this.dbFile, JSON.stringify({ clones: this.records }, null, 2), 'utf8');
    }

    list() { return this.records.map(r => ({ ...r })); }
    runningIds() { return new Set(this.running.keys()); }
    byIndex(n) { return this.records[Number(n) - 1] || null; }
    cloneDir(id) { return path.join(this.dataDir, 'clones', String(id)); }
    sessionFile(id) { return path.join(this.sessionsDir, `${id}.session`); }

    // ── LIFECYCLE ───────────────────────────────────────
    async startAll() {
        for (const r of this.records) {
            if (r.enabled === false || r.expired) continue;
            try {
                await this.start(r.id);
                this.log(`🤖 Clone aktif: ${r.name || r.id}`);
            } catch (e) {
                this.log(`⚠️ Clone ${r.name || r.id} gagal start: ${e.message}`);
            }
            await new Promise(res => setTimeout(res, 1500));
        }
    }

    async start(id) {
        const rec = this.records.find(r => r.id === String(id));
        if (!rec) throw new CloneError('NOT_FOUND');
        if (this.running.has(rec.id)) return rec;
        let sessionStr = '';
        try { sessionStr = fs.readFileSync(this.sessionFile(rec.id), 'utf8').trim(); } catch (_) { /* kosong */ }
        if (!sessionStr) { rec.expired = true; this.save(); throw new CloneError('SESSION_MISSING'); }

        const client = this.makeClient(new StringSession(sessionStr));
        await client.connect();
        let authorized = false;
        try { authorized = await client.isUserAuthorized(); } catch (_) { authorized = false; }
        if (!authorized) {
            rec.expired = true;
            this.save();
            try { await client.disconnect(); } catch (_) { /* abaikan */ }
            throw new CloneError('SESSION_EXPIRED');
        }
        await this.attach(rec, client);
        rec.enabled = true;
        rec.expired = false;
        this.save();
        return rec;
    }

    async attach(rec, client) {
        const bot = this.createUserbot({ client, dir: this.cloneDir(rec.id), label: rec.name || rec.id, isMain: false });
        await bot.start();
        this.running.set(rec.id, { client, bot });
    }

    async stop(id) {
        const rec = this.records.find(r => r.id === String(id));
        if (!rec) throw new CloneError('NOT_FOUND');
        const run = this.running.get(rec.id);
        if (run) {
            this.running.delete(rec.id);
            try { await run.bot.stop(); } catch (_) { /* abaikan */ }
            try { await run.client.disconnect(); } catch (_) { /* abaikan */ }
        }
        rec.enabled = false;
        this.save();
        return rec;
    }

    async remove(id) {
        const rec = this.records.find(r => r.id === String(id));
        if (!rec) throw new CloneError('NOT_FOUND');
        const run = this.running.get(rec.id);
        if (run) {
            try { await run.client.invoke(new Api.auth.LogOut()); } catch (_) { /* abaikan */ }
        }
        await this.stop(rec.id);
        this.records = this.records.filter(r => r !== rec);
        this.save();
        try { fs.rmSync(this.sessionFile(rec.id), { force: true }); } catch (_) { /* abaikan */ }
        try { fs.rmSync(this.cloneDir(rec.id), { recursive: true, force: true }); } catch (_) { /* abaikan */ }
        return rec;
    }

    async stopAll() {
        for (const id of [...this.running.keys()]) {
            try { await this.stop(id); } catch (_) { /* abaikan */ }
        }
    }

    // ── LOGIN ───────────────────────────────────────────
    busy() { return !!this.active; }

    cancel() {
        if (!this.active) return false;
        this.active.cancel();
        return true;
    }

    async login(io) {
        if (this.active) throw new CloneError('BUSY');

        let rejectCancel;
        const cancelP = new Promise((_, rej) => { rejectCancel = rej; });
        cancelP.catch(() => {});
        this.active = { cancel: () => rejectCancel(new Error('CANCELLED')) };

        const state = { fatal: null, retries: 0 };
        const ask = (step, meta) => Promise.race([io.ask(step, meta), cancelP]);
        const client = this.makeClient(new StringSession(''));
        let phone = '';

        try {
            await client.connect();
            const user = await client.start({
                phoneNumber: async () => {
                    phone = normalizePhone(await ask('phone'));
                    return phone;
                },
                // gramjs menelan error dari callback ini → kembalikan '' + tandai fatal
                phoneCode: async (viaApp) => {
                    try { return codeDigits(await ask('code', { viaApp: !!viaApp })); } catch (e) {
                        state.fatal = errCode(e);
                        return '';
                    }
                },
                password: async () => ask('password'),
                onError: async (e) => {
                    if (state.fatal) return true;
                    let code = errCode(e);
                    if (code === 'Code is empty') code = 'PHONE_CODE_EMPTY';
                    if (code === 'Password is empty') code = 'PASSWORD_HASH_INVALID';
                    if (RETRYABLE.has(code) && state.retries < MAX_RETRIES) {
                        state.retries += 1;
                        await io.notify('retry', { code });
                        return false;
                    }
                    state.fatal = code;
                    return true;
                }
            });

            const me = user && user.id !== undefined ? user : await client.getMe();
            if (String(me.id) === this.mainId) throw new CloneError('SAME_ACCOUNT');

            const id = String(me.id);
            const existing = this.records.find(r => r.id === id);
            if (existing && this.running.has(id)) await this.stop(id);

            fs.writeFileSync(this.sessionFile(id), client.session.save(), { encoding: 'utf8', mode: 0o600 });
            const rec = existing || { id };
            Object.assign(rec, {
                phone,
                name: [me.firstName, me.lastName].filter(Boolean).join(' ') || me.username || id,
                username: me.username || '',
                created_at: rec.created_at || new Date().toISOString(),
                enabled: true,
                expired: false
            });
            if (!existing) this.records.push(rec);
            this.save();
            await this.attach(rec, client);
            return { ...rec };
        } catch (e) {
            try { await client.disconnect(); } catch (_) { /* abaikan */ }
            if (e instanceof CloneError) throw e;
            throw new CloneError(state.fatal || errCode(e));
        } finally {
            this.active = null;
        }
    }
}

module.exports = { CloneManager, CloneError, normalizePhone, codeDigits, errCode };
