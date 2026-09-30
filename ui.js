/**
 * UI — semua tampilan bot dalam format Rich Message JSON (lihat richmsg.js)
 */
'use strict';

const BRAND = process.env.BOT_BRAND || 'ARTA USERBOT';

const foot = () => ({ footer: BRAND });
const ok = (title, ...body) => [{ h3: `✅ ${title}` }, ...body];
const err = (title, ...body) => [{ h3: `❌ ${title}` }, ...body];
const warn = (title, ...body) => [{ h3: `⚠️ ${title}` }, ...body];
const info = (title, ...body) => [{ h3: `ℹ️ ${title}` }, ...body];
const empty = (title, ...body) => [{ h3: `📭 ${title}` }, ...body];
const kv = (rows) => ({ table: { headers: ['Item', 'Nilai'], rows } });
const c = (cmd, desc) => [{ code: cmd }, desc ? ` — ${desc}` : ''];
const preview = (s, n = 80) => (s.length > n ? s.slice(0, n) + '…' : s);

function maskPhone(p) {
    const s = String(p || '');
    if (s.length <= 6) return s;
    return s.slice(0, 3) + '•'.repeat(Math.max(3, s.length - 7)) + s.slice(-4);
}

// ─────────────────────────────────────────────────────────
// BANTUAN
// ─────────────────────────────────────────────────────────
function helpScreen({ isMain }) {
    const sec = (summary, lines) => ({
        details: { summary, content: lines.flatMap((l, i) => [...(i ? ['\n'] : []), '• ', { code: l[0] }, ` — ${l[1]}`]), open: false }
    });
    const out = [
        { h1: '📖 PANDUAN USERBOT' },
        { p: ['Ketuk bagian di bawah untuk membuka daftar perintah.'] },
        sec('📝 Pesan Teks', [
            ['/addpesan <teks>', 'tambah pesan'], ['/setpesan <teks>', 'reset & set pesan ke-1'],
            ['/listpesan', 'lihat semua'], ['/delpesan <no>', 'hapus pesan']
        ]),
        sec('📨 Pesan Forward', [
            ['/addpesanfw [label]', 'simpan forward (reply ke pesan forward)'],
            ['/listpesanfw', 'lihat semua'], ['/delpesanfw <no>', 'hapus']
        ]),
        sec('👥 Grup Target', [
            ['/addgb', 'tambah grup ini'], ['/delgb', 'hapus grup ini'], ['/listgb', 'lihat semua grup']
        ]),
        sec('👤 Mode Admin', [
            ['/admin off', 'offline: auto-reply + anti-spam'], ['/admin on', 'online lagi']
        ]),
        sec('📋 Note', [
            ['/addnote <nama>', 'simpan note (reply teks/foto)'], ['/listnote', 'lihat semua'],
            ['/delnote <nama>', 'hapus'], ['/<nama>', 'kirim note, mis. /qris']
        ]),
        sec('🎨 Rich Message', [
            ['/rich <json>', 'render JSON (atau reply ke pesan JSON)'], ['/richdemo', 'contoh semua elemen']
        ])
    ];
    if (isMain) {
        out.push(sec('🤖 Clone Bot', [
            ['/clonebot', 'jadikan nomor lain sebagai bot (nomor → kode → A2F)'],
            ['/listclone', 'daftar clone'], ['/stopclone <no>', 'hentikan clone'],
            ['/startclone <no>', 'jalankan lagi'], ['/delclone <no>', 'hapus clone'],
            ['/cancel', 'batalkan proses clone']
        ]));
    }
    out.push(sec('⚙️ Kontrol', [
        ['/auto on|off', 'auto post'], ['/status', 'status lengkap'], ['/help', 'panduan ini']
    ]));
    out.push(foot());
    return out;
}

// ─────────────────────────────────────────────────────────
// STATUS
// ─────────────────────────────────────────────────────────
function statusScreen(s) {
    return [
        { h1: '⚙️ STATUS USERBOT' },
        { p: [{ b: s.label }, s.isMain ? ' (akun utama)' : ' (clone)'] },
        kv([
            ['Auto Post', s.auto ? 'AKTIF' : 'NON-AKTIF'],
            ['Mode Admin', s.admin ? 'ONLINE' : 'OFFLINE'],
            ['Waktu', s.time],
            ['Jam', s.night ? 'Jam Tidur' : 'Jam Kerja'],
            ['Operasional', '03:00 – 00:00 WIB']
        ]),
        { h3: '📦 Konten' },
        kv([
            ['Pesan Teks', `${s.texts}`], ['Pesan Forward', `${s.forwards}`], ['Pool Total', `${s.pool}`],
            ['Berikutnya', s.next], ['Grup Target', `${s.groups}`], ['Note', `${s.notes}`]
        ]),
        { blockquote: { text: ['Jeda reply 60 detik · siklus 20–25 menit\n', 'Urutan reply: /sharemsg, /sharemsg2, /sharemsg3, /broadcast, /broadcast2, /broadcast3'] } },
        ...(s.isMain ? [{ p: ['Clone aktif: ', { b: `${s.clonesRunning}/${s.clonesTotal}` }] }] : []),
        foot()
    ];
}

// ─────────────────────────────────────────────────────────
// OFFLINE (auto-reply admin)
// ─────────────────────────────────────────────────────────
const OFFLINE = [
    { icon: '😴', lead: 'Admin lagi istirahat', text: 'Lagi ngisi ulang energi dulu 🔋 — bentar lagi balik kok!' },
    { icon: '💼', lead: 'Admin lagi super sibuk', text: 'Urusan numpuk, dibereskan satu-satu dulu ya 📋 — pesanmu pasti dibalas.' },
    { icon: '🌙', lead: 'Admin lagi tidur', text: 'Lagi mimpi indah 😴💤 — begitu bangun langsung dibalas.' },
    { icon: '🏃', lead: 'Admin lagi ada urusan penting', text: 'Lagi di luar sebentar 📲 — semua pesan tetap masuk, tenang aja.' }
];

function offlineScreen(i) {
    const o = OFFLINE[(i === undefined ? Math.floor(Math.random() * OFFLINE.length) : i) % OFFLINE.length];
    return [
        { h1: '🔴 ADMIN OFFLINE' },
        { p: [{ b: `${o.icon} ${o.lead}` }] },
        { blockquote: { text: o.text } },
        { aside: { text: [{ b: 'Mohon jangan spam!' }, ' Kirim lebih dari ', { b: '5 pesan' }, ' = 🚫 otomatis diblokir.'] } },
        foot()
    ];
}

const spamWarning = () => [
    { h2: '⚠️ PERINGATAN' },
    { p: ['Ini sudah pesan ke-', { b: '5' }, ' dari kamu.'] },
    { blockquote: { text: 'Satu pesan lagi = 🚫 otomatis diblokir. Tunggu admin online ya 🙏' } }
];

const spamBlocked = () => [
    { h2: '🚫 KAMU DIBLOKIR' },
    { p: 'Diblokir otomatis karena mengirim terlalu banyak pesan saat admin offline.' },
    { footer: 'Tindakan otomatis sistem' }
];

// ─────────────────────────────────────────────────────────
// CLONE
// ─────────────────────────────────────────────────────────
function clonePrompt(step, meta = {}) {
    if (step === 'phone') {
        return [
            { h2: '📲 CLONE BOT' },
            { p: 'Kirim nomor Telegram yang ingin dijadikan bot:' },
            { pre: { text: '+628123456789' } },
            { aside: { text: ['Pesan berisi nomor dihapus otomatis. Batalkan dengan ', { code: '/cancel' }, '.'] } }
        ];
    }
    if (step === 'code') {
        return [
            { h2: '📩 MASUKKAN KODE' },
            { p: [meta.viaApp ? 'Kode dikirim ke ' : 'Kode dikirim via SMS/telepon ke ', { b: meta.viaApp ? 'aplikasi Telegram' : 'nomor itu' }, meta.viaApp ? ' di nomor tersebut.' : '.'] },
            { p: 'Kirim kode dengan tanda pemisah agar tidak diblokir Telegram:' },
            { pre: { text: '1-2-3-4-5' } },
            { aside: { text: ['Batalkan dengan ', { code: '/cancel' }, '.'] } }
        ];
    }
    return [
        { h2: '🔐 VERIFIKASI 2 LANGKAH (A2F)' },
        { p: 'Akun ini memakai password A2F. Kirim password-nya:' },
        { aside: { text: 'Password hanya dipakai sekali untuk login, tidak disimpan, dan pesannya dihapus otomatis.' } }
    ];
}

const CLONE_ERRORS = {
    PHONE_NUMBER_INVALID: 'Nomor tidak valid. Kirim ulang dengan format +628xxx.',
    PHONE_CODE_INVALID: 'Kode salah. Kirim ulang kodenya.',
    PHONE_CODE_EMPTY: 'Kode kosong. Kirim ulang kodenya.',
    PHONE_CODE_EXPIRED: 'Kode kedaluwarsa. Jalankan /clonebot lagi untuk minta kode baru.',
    PASSWORD_HASH_INVALID: 'Password A2F salah. Kirim ulang.',
    PHONE_NUMBER_BANNED: 'Nomor ini dibanned Telegram.',
    PHONE_NUMBER_FLOOD: 'Terlalu sering meminta kode untuk nomor ini. Coba lagi nanti.',
    API_ID_INVALID: 'API_ID / API_HASH di .env tidak valid.',
    TIMEOUT: 'Waktu habis (5 menit tanpa balasan). Jalankan /clonebot lagi.',
    CANCELLED: 'Proses clone dibatalkan.',
    SAME_ACCOUNT: 'Nomor itu adalah akun utama, tidak bisa di-clone.'
};

function cloneErrorText(code) {
    if (CLONE_ERRORS[code]) return CLONE_ERRORS[code];
    if (/^FLOOD_WAIT_(\d+)/.test(code || '')) return `Kena limit Telegram, tunggu ${RegExp.$1} detik lalu coba lagi.`;
    return `Gagal: ${code || 'kesalahan tidak diketahui'}`;
}

const cloneRetry = (code) => [{ h3: '⚠️ ' + cloneErrorText(code) }];
const cloneFail = (code) => err('Clone gagal', { p: cloneErrorText(code) });

function cloneDone(rec) {
    return ok('CLONE BERHASIL',
        kv([['Nama', rec.name || '-'], ['Username', rec.username ? '@' + rec.username : '-'], ['Nomor', maskPhone(rec.phone)], ['Status', 'AKTIF']]),
        { p: ['Nomor itu sekarang menjadi bot dengan fitur yang sama. Ketik ', { code: '/help' }, ' di akun tersebut.'] },
        foot());
}

function cloneList(list, runningIds) {
    if (!list.length) {
        return empty('Belum ada clone', { p: ['Jalankan ', { code: '/clonebot' }, ' untuk menambahkan.'] });
    }
    return [
        { h2: '🤖 DAFTAR CLONE' },
        {
            table: {
                headers: ['No', 'Nama', 'Nomor', 'Status'],
                rows: list.map((r, i) => [String(i + 1), preview(r.name || '-', 14), maskPhone(r.phone),
                    r.expired ? 'EXPIRED' : (runningIds.has(r.id) ? 'AKTIF' : 'MATI')])
            }
        },
        { p: [{ code: '/stopclone <no>' }, '  ', { code: '/startclone <no>' }, '  ', { code: '/delclone <no>' }] },
        foot()
    ];
}

// ─────────────────────────────────────────────────────────
// DEMO RICH
// ─────────────────────────────────────────────────────────
function richDemo() {
    return [
        [
            { h1: 'Rich Message' }, { h2: 'Subjudul' }, { h3: 'Heading 3' }, { h4: 'Heading 4' }, { h5: 'Heading 5' }, { h6: 'Heading 6' },
            { p: ['Harga: ', { b: 'Rp 25.000' }, ' (diskon)'] },
            { b: 'Bold' }, { i: 'Italic' }, { u: 'Underline' }, { s: 'Strike' }, { mark: 'Highlight' }, { spoiler: 'Spoiler' },
            { p: ['H', { sub: '2' }, 'O dan x', { sup: '2' }, ' ', { code: 'npm start' }] },
            { hr: true },
            { a: { text: 'Buka Website', url: 'https://example.com' } },
            { blockquote: { text: 'Kutipan penting' } },
            { aside: { text: 'Catatan tambahan', cite: 'Admin' } },
            { footer: BRAND }
        ],
        [
            { ul: ['Poin 1', 'Poin 2'] }, { ol: ['Langkah 1', 'Langkah 2'] },
            { checkbox: [{ checked: true, text: 'Sudah dikerjakan' }, { checked: false, text: 'Belum dikerjakan' }] },
            { table: { headers: ['Paket', 'Harga', 'Benefit'], rows: [['Basic', 'Rp 25.000', 'Fitur dasar'], ['Pro', 'Rp 60.000', 'Semua fitur']] } },
            { pre: { lang: 'javascript', text: 'const x = 1;\nconsole.log(x);' } },
            { math: 'E = mc^2' },
            { details: { summary: '📂 Klik untuk lihat', content: '• Item 1\n• Item 2\n• Item 3', open: false } },
            { buttons: [[{ text: '🚀 Buka URL', url: 'https://example.com' }, { text: '📋 Copy', copy_text: '6289613241755' }]] }
        ]
    ];
}

module.exports = {
    BRAND, foot, ok, err, warn, info, empty, kv, c, preview, maskPhone,
    helpScreen, statusScreen, offlineScreen, spamWarning, spamBlocked,
    clonePrompt, cloneErrorText, cloneRetry, cloneFail, cloneDone, cloneList, richDemo
};
