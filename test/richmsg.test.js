const assert = require('assert');
const http = require('http');
const { renderDoc, sendRich, splitText, plainText, parseHtml } = require('../richmsg');

const show = (d) => d.parts.map(p => p.type === 'text' ? p.text : `[${p.type}]`).join('\n---\n');

// 1 heading + inline
let d = renderDoc([{ h1: 'Judul' }, { h2: 'Sub' }, { p: ['Harga: ', { b: 'Rp 25.000' }, ' (diskon)'] }, { p: ['Baris 1', 'Baris 2'] }]);
assert.strictEqual(d.parts.length, 1);
assert(d.parts[0].text.includes('Harga: Rp 25.000 (diskon)'));
assert(d.parts[0].text.includes('Baris 1\nBaris 2'));
const bold = d.parts[0].entities.find(e => e.type === 'bold' && d.parts[0].text.substr(e.offset, e.length) === 'Rp 25.000');
assert(bold, 'bold entity offset');

// 2 sub/sup, inline run
d = renderDoc([{ p: ['H', { sub: '2' }, 'O x', { sup: '2' }] }, { b: 'Bold' }, { i: 'Italic' }]);
assert(d.parts[0].text.startsWith('H₂O x²'));
assert(d.parts[0].text.includes('Bold  ·  Italic'));

// 3 lists / checkbox / table
d = renderDoc([{ ul: ['A', 'B'] }, { ol: ['1', '2'] }, { checkbox: [{ checked: true, text: 'ok' }, { checked: false, text: 'no' }] },
    { table: { headers: ['Paket', 'Harga'], rows: [['Basic', 'Rp 25.000'], ['Pro', 'Rp 60.000']] } }]);
const t = d.parts[0].text;
assert(t.includes('• A\n• B')); assert(t.includes('1. 1\n2. 2')); assert(t.includes('☑ ok\n☐ no'));
assert(t.includes('┌') && t.includes('Rp 60.000'));
assert(d.parts[0].entities.some(e => e.type === 'pre'));

// 4 quote/details/link/emoji/spoiler
d = renderDoc([{ blockquote: { text: 'Kutipan' } }, { aside: { text: 'Cat', cite: 'Admin' } },
    { details: { summary: 'Klik', content: 'x\ny', open: false } },
    { a: { text: 'Web', url: 'https://example.com' } }, { p: [{ spoiler: 'rahasia' }, { emoji: { id: '5368324170671202286', char: '👍' } }] }]);
const es = d.parts[0].entities;
assert(es.some(e => e.type === 'quote' && e.collapsed === true));
assert(es.some(e => e.type === 'url' && e.url === 'https://example.com'));
assert(es.some(e => e.type === 'spoiler') && es.some(e => e.type === 'emoji'));

// 5 raw html
const items = parseHtml('<p>HTML <b>mentah</b> &amp; <i>render</i>.</p><p><code>code</code>, <mark>mark</mark></p>');
assert.deepStrictEqual(items[0], { p: ['HTML ', { b: ['mentah'] }, ' & ', { i: ['render'] }, '.'] });
d = renderDoc([{ raw: '<p>HTML <b>mentah</b></p>' }]);
assert(d.parts[0].text === 'HTML mentah');

// 6 media parts + buttons + map + reference
d = renderDoc([{ p: 'atas' }, { img: { src: 'https://x/y.jpg', caption: 'Cap' } }, { map: { lat: 1, long: 2 } },
    { collage: { items: ['https://a/1.jpg', 'https://a/2.jpg'] } }, { reference: { name: 'b', text: 'Bab' } },
    { buttons: [[{ text: 'Buka', url: 'https://e.com' }, { text: 'Copy', copy_text: '123' }]] }]);
assert.deepStrictEqual(d.parts.map(p => p.type), ['text', 'media', 'geo', 'album', 'text']);
assert(d.parts[4].text.includes('▸ Buka') && d.parts[4].text.includes('Copy: 123'));
const dk = renderDoc([{ buttons: [[{ text: 'Buka', url: 'https://e.com' }]] }], { buttons: 'keyboard' });
assert.strictEqual(dk.buttons.length, 1); assert.strictEqual(dk.parts.length, 0);

// 7 unknown warnings
d = renderDoc([{ foo: 1 }]); assert(d.warnings.length === 1);

// 8 split
const big = Array.from({ length: 400 }, (_, i) => `Paragraf nomor ${i} ` + 'x'.repeat(30)).join('\n\n');
const chunks = splitText(big, [{ type: 'bold', offset: 4000 - 10, length: 50 }]);
assert(chunks.length >= 2 && chunks.every(c => c.text.length <= 4000));
const covered = chunks.reduce((n, c) => n + c.entities.reduce((m, e) => m + e.length, 0), 0);
const origSlice = big.substr(3990, 50).replace(/\n/g, '');
assert(covered >= 49 && covered <= 50, 'entity length preserved: ' + covered);
chunks.forEach(c => c.entities.forEach(e => assert(e.offset >= 0 && e.offset + e.length <= c.text.length)));

// 9 sendRich pipeline with mock client + local http server
(async () => {
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('89504e470d0a1a0a', 'hex')); });
    await new Promise(r => srv.listen(0, r));
    const port = srv.address().port;
    const calls = [];
    const client = {
        editMessage: async (c, o) => { calls.push(['edit', c, o]); return { id: o.message }; },
        sendMessage: async (p, o) => { calls.push(['msg', p, o]); return { id: 99 }; },
        sendFile: async (p, o) => { calls.push(['file', p, o]); return { id: 98 }; },
        deleteMessages: async (...a) => { calls.push(['del', ...a]); },
        invoke: async (r) => { calls.push(['invoke', r.className]); return {}; },
        getInputEntity: async () => ({})
    };
    const r = await sendRich(client, 123, [{ h2: 'Hai' }, { img: { src: `http://127.0.0.1:${port}/pic`, caption: 'C' } }, { map: { lat: 1, long: 2 } },
        { p: 'bawah' }], { edit: { chatId: 123, id: 7 } });
    assert.deepStrictEqual(calls.map(c => c[0]), ['edit', 'file', 'invoke', 'msg']);
    assert.strictEqual(r.errors.length, 0, r.errors.join());
    assert(calls[1][2].file.name.endsWith('.png'), calls[1][2].file.name);
    assert(Array.isArray(calls[0][2].formattingEntities) && calls[0][2].formattingEntities.length > 0);

    // gagal fetch → pesan fallback, tidak crash
    calls.length = 0;
    const r2 = await sendRich(client, 1, [{ img: 'http://127.0.0.1:1/x.jpg' }]);
    assert(r2.errors.length === 1 && calls[0][0] === 'msg');

    // keyboard mode (bot)
    calls.length = 0;
    await sendRich(client, 1, [{ p: 'x' }, { buttons: [[{ text: 'A', url: 'https://a.com' }, { text: 'C', copy_text: 'z' }], [{ text: 'D', callback: 'menu' }]] }], { keyboard: true });
    assert(calls[0][2].buttons.rows.length === 2 && calls[0][2].buttons.rows[0].buttons[1].className === 'KeyboardButtonCopy');
    srv.close();
    console.log('richmsg OK');
})().catch(e => { console.error(e); process.exit(1); });
