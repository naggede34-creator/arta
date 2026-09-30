/**
 * Rich Message — JSON → pesan Telegram (teks + entities, media, tombol)
 *
 * Mendukung: h1-h6, p, b/i/u/s/mark/spoiler/code/sub/sup/br, hr/divider/footer,
 * a, blockquote, aside, ul/ol/checkbox, table, pre, math, details,
 * img/image/photo/video/audio/figure/collage/slideshow, emoji premium,
 * buttons, raw HTML, map, reference.
 */
'use strict';

const { Api } = require('telegram');
const { CustomFile } = require('telegram/client/uploads');
const { generateRandomLong } = require('telegram/Helpers');
const bigInt = require('big-integer');

const MAX_TEXT = 4000;
const MAX_CAPTION = 1024;
const MAX_MEDIA_BYTES = 40 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30000;
const LINE = '━━━━━━━━━━━━━━━━━━';

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const BLOCKS = new Set([
    ...HEADINGS, 'p', 'text', 'hr', 'divider', 'footer', 'a', 'blockquote', 'aside',
    'ul', 'ol', 'checkbox', 'table', 'pre', 'math', 'details',
    'img', 'image', 'photo', 'video', 'audio', 'figure', 'collage', 'slideshow',
    'buttons', 'raw', 'map', 'reference'
]);
const INLINE = new Set([
    'b', 'bold', 'strong', 'i', 'italic', 'em', 'u', 'underline', 'ins',
    's', 'strike', 'del', 'mark', 'spoiler', 'code', 'sub', 'sup', 'br',
    'emoji', 'tg-emoji'
]);
const INLINE_ALIAS = {
    bold: 'b', strong: 'b', italic: 'i', em: 'i', underline: 'u', ins: 'u',
    strike: 's', del: 's', 'tg-emoji': 'emoji'
};

// ─────────────────────────────────────────────────────────
// TEKS HELPERS
// ─────────────────────────────────────────────────────────
const SUP = {
    0: '⁰', 1: '¹', 2: '²', 3: '³', 4: '⁴', 5: '⁵', 6: '⁶', 7: '⁷', 8: '⁸', 9: '⁹',
    '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', x: 'ˣ'
};
const SUB = {
    0: '₀', 1: '₁', 2: '₂', 3: '₃', 4: '₄', 5: '₅', 6: '₆', 7: '₇', 8: '₈', 9: '₉',
    '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ',
    h: 'ₕ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', p: 'ₚ', s: 'ₛ', t: 'ₜ'
};

function toScript(text, kind) {
    const map = kind === 'sup' ? SUP : SUB;
    let out = '';
    for (const ch of text) {
        if (map[ch] === undefined) return (kind === 'sup' ? '^(' : '_(') + text + ')';
        out += map[ch];
    }
    return out;
}

function charWidth(str) {
    let w = 0;
    for (const ch of str) {
        const c = ch.codePointAt(0);
        if (c >= 0x1F300 && c <= 0x1FAFF) w += 2;
        else if (c >= 0x1100 && (c <= 0x115F || (c >= 0x2E80 && c <= 0xA4CF) ||
            (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xFF00 && c <= 0xFF60))) w += 2;
        else w += 1;
    }
    return w;
}

function decodeEntities(s) {
    return s
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
        .replace(/&amp;/g, '&');
}

// ─────────────────────────────────────────────────────────
// BUILDER (teks + entity descriptor)
// ─────────────────────────────────────────────────────────
class Builder {
    constructor() { this.text = ''; this.ents = []; this.gap = ''; }

    startBlock() {
        if (this.text) this.text += this.gap;
        this.gap = '\n\n';
    }

    raw(s) { this.text += s; }

    span(type, props, fn) {
        const offset = this.text.length;
        fn();
        const length = this.text.length - offset;
        if (length > 0) this.ents.push({ type, offset, length, ...props });
    }

    finish() {
        const text = this.text.replace(/\s+$/, '');
        const ents = [];
        for (const e of this.ents) {
            if (e.offset >= text.length) continue;
            ents.push({ ...e, length: Math.min(e.length, text.length - e.offset) });
        }
        return { text, entities: ents };
    }
}

// ─────────────────────────────────────────────────────────
// INLINE NORMALIZER  (JSON value → node list)
// ─────────────────────────────────────────────────────────
function inl(v) {
    if (v === null || v === undefined || v === false) return [];
    if (typeof v === 'string') return [v];
    if (typeof v === 'number' || typeof v === 'boolean') return [String(v)];
    if (Array.isArray(v)) {
        const hasObj = v.some(x => x && typeof x === 'object');
        if (!hasObj) return [v.map(String).join('\n')];
        return v.flatMap(inl);
    }
    if (typeof v === 'object') {
        const out = [];
        for (const key of Object.keys(v)) {
            const k = INLINE_ALIAS[key] || key;
            const val = v[key];
            switch (k) {
                case 'b': case 'i': case 'u': case 's': case 'mark': case 'spoiler':
                case 'sub': case 'sup':
                    out.push({ k, kids: inl(val) }); break;
                case 'code':
                    out.push({ k, kids: [plain(inl(val))] }); break;
                case 'br':
                    out.push('\n'); break;
                case 'a': {
                    const o = typeof val === 'string' ? { url: val, text: val } : (val || {});
                    out.push({ k: 'a', url: String(o.url || ''), kids: inl(o.text !== undefined ? o.text : o.url) });
                    break;
                }
                case 'emoji':
                    out.push({ k: 'emoji', id: String((val && val.id) || ''), char: (val && val.char) || '🙂' });
                    break;
                default: break;
            }
        }
        return out;
    }
    return [];
}

function plain(nodes) {
    let s = '';
    for (const n of nodes) {
        if (typeof n === 'string') s += n;
        else if (n.k === 'sub' || n.k === 'sup') s += toScript(plain(n.kids), n.k);
        else if (n.k === 'emoji') s += n.char;
        else if (n.kids) s += plain(n.kids);
    }
    return s;
}

// ─────────────────────────────────────────────────────────
// HTML MINI PARSER  (raw → item JSON)
// ─────────────────────────────────────────────────────────
function parseTree(html) {
    const root = { tag: '#root', kids: [], attrs: {} };
    const stack = [root];
    const VOID = new Set(['br', 'hr', 'img']);
    const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>|([^<]+)|</g;
    let m;
    while ((m = re.exec(html))) {
        if (m[5] !== undefined) { stack[stack.length - 1].kids.push(m[5]); continue; }
        if (m[0] === '<') { stack[stack.length - 1].kids.push('<'); continue; }
        const closing = m[1] === '/';
        const tag = m[2].toLowerCase();
        if (closing) {
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].tag === tag) { stack.length = i; break; }
            }
            continue;
        }
        const attrs = {};
        m[3].replace(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g, (_, k, a, b) => { attrs[k.toLowerCase()] = decodeEntities(a !== undefined ? a : b); return ''; });
        const node = { tag, kids: [], attrs };
        stack[stack.length - 1].kids.push(node);
        if (!VOID.has(tag) && !m[4]) stack.push(node);
    }
    return root;
}

function textOfTree(n) {
    if (typeof n === 'string') return decodeEntities(n);
    return n.kids.map(textOfTree).join('');
}

function treeInline(nodes) {
    const out = [];
    for (const n of nodes) {
        if (typeof n === 'string') {
            const t = decodeEntities(n).replace(/\s+/g, ' ');
            if (t) out.push(t);
            continue;
        }
        const kids = () => treeInline(n.kids);
        switch (n.tag) {
            case 'b': case 'strong': out.push({ b: kids() }); break;
            case 'i': case 'em': out.push({ i: kids() }); break;
            case 'u': case 'ins': out.push({ u: kids() }); break;
            case 's': case 'strike': case 'del': out.push({ s: kids() }); break;
            case 'mark': out.push({ mark: kids() }); break;
            case 'sub': out.push({ sub: kids() }); break;
            case 'sup': out.push({ sup: kids() }); break;
            case 'code': out.push({ code: textOfTree(n) }); break;
            case 'br': out.push({ br: true }); break;
            case 'tg-spoiler': out.push({ spoiler: kids() }); break;
            case 'span':
                if ((n.attrs.class || '').includes('tg-spoiler')) out.push({ spoiler: kids() });
                else out.push(...kids());
                break;
            case 'tg-emoji':
                out.push({ emoji: { id: n.attrs['emoji-id'] || '', char: textOfTree(n) || '🙂' } });
                break;
            case 'a':
                out.push({ a: { text: kids(), url: n.attrs.href || '' } });
                break;
            default: out.push(...kids());
        }
    }
    return out;
}

function treeBlocks(nodes) {
    const items = [];
    let run = [];
    const flush = () => {
        const inline = treeInline(run);
        if (inline.some(x => typeof x !== 'string' || x.trim())) items.push({ p: inline });
        run = [];
    };
    for (const n of nodes) {
        if (typeof n === 'string') { run.push(n); continue; }
        const t = n.tag;
        if (HEADINGS.has(t)) { flush(); items.push({ [t]: treeInline(n.kids) }); }
        else if (t === 'p' || t === 'div' || t === 'section') { flush(); items.push({ p: treeInline(n.kids) }); }
        else if (t === 'ul' || t === 'ol') {
            flush();
            items.push({ [t]: n.kids.filter(k => typeof k !== 'string' && k.tag === 'li').map(li => treeInline(li.kids)) });
        }
        else if (t === 'blockquote') { flush(); items.push({ blockquote: { text: treeInline(n.kids) } }); }
        else if (t === 'pre') {
            flush();
            const codeNode = n.kids.find(k => typeof k !== 'string' && k.tag === 'code');
            const lang = codeNode && /language-([\w+-]+)/.exec(codeNode.attrs.class || '');
            items.push({ pre: { lang: lang ? lang[1] : '', text: textOfTree(n).replace(/\n+$/, '') } });
        }
        else if (t === 'hr') { flush(); items.push({ hr: true }); }
        else if (t === 'img') { flush(); items.push({ img: { src: n.attrs.src || '', caption: n.attrs.alt || '' } }); }
        else run.push(n);
    }
    flush();
    return items;
}

function parseHtml(html) {
    return treeBlocks(parseTree(String(html)).kids);
}

// ─────────────────────────────────────────────────────────
// DOC RENDERER
// ─────────────────────────────────────────────────────────
class Doc {
    constructor(opts = {}) {
        this.keyboard = opts.buttons === 'keyboard';
        this.parts = [];
        this.buttons = [];
        this.warnings = [];
        this.cur = new Builder();
    }

    flush() {
        const { text, entities } = this.cur.finish();
        if (text.trim()) this.parts.push({ type: 'text', text, entities });
        this.cur = new Builder();
    }

    items(list) {
        let run = [];
        const flushRun = () => { if (run.length) { this.inlineRun(run); run = []; } };
        for (const it of list) {
            if (typeof it === 'string' || typeof it === 'number') { flushRun(); this.para(String(it)); continue; }
            if (!it || typeof it !== 'object' || Array.isArray(it)) continue;
            const bkey = Object.keys(it).find(k => BLOCKS.has(k));
            if (bkey) { flushRun(); this.block(bkey, it); continue; }
            if (Object.keys(it).some(k => INLINE.has(k))) { run.push(it); continue; }
            this.warnings.push(`elemen tidak dikenal: ${Object.keys(it).join(',')}`);
        }
        flushRun();
    }

    writeInline(b, nodes) {
        for (const n of nodes) {
            if (typeof n === 'string') { b.raw(n); continue; }
            switch (n.k) {
                case 'b': b.span('bold', {}, () => this.writeInline(b, n.kids)); break;
                case 'i': b.span('italic', {}, () => this.writeInline(b, n.kids)); break;
                case 'u': b.span('underline', {}, () => this.writeInline(b, n.kids)); break;
                case 's': b.span('strike', {}, () => this.writeInline(b, n.kids)); break;
                case 'spoiler': b.span('spoiler', {}, () => this.writeInline(b, n.kids)); break;
                case 'code': b.span('code', {}, () => this.writeInline(b, n.kids)); break;
                case 'mark':
                    b.span('bold', {}, () => b.span('underline', {}, () => this.writeInline(b, n.kids)));
                    break;
                case 'sub': case 'sup':
                    b.raw(toScript(plain(n.kids), n.k)); break;
                case 'a':
                    if (/^(https?:|tg:|mailto:)/i.test(n.url)) {
                        b.span('url', { url: n.url }, () => this.writeInline(b, n.kids));
                    } else if (n.url.startsWith('#')) {
                        b.span('underline', {}, () => this.writeInline(b, n.kids));
                    } else {
                        this.writeInline(b, n.kids);
                    }
                    break;
                case 'emoji':
                    if (/^\d+$/.test(n.id)) b.span('emoji', { docId: n.id }, () => b.raw(n.char));
                    else b.raw(n.char);
                    break;
                default: break;
            }
        }
    }

    inlineRun(run) {
        const b = this.cur;
        b.startBlock();
        run.forEach((it, i) => {
            const nodes = inl(it);
            if (i > 0 && !(nodes.length === 1 && nodes[0] === '\n')) b.raw('  ·  ');
            this.writeInline(b, nodes);
        });
    }

    para(val) {
        const b = this.cur;
        b.startBlock();
        this.writeInline(b, inl(val));
    }

    heading(level, val) {
        const b = this.cur;
        b.startBlock();
        const kids = inl(val);
        const write = () => this.writeInline(b, kids);
        if (level === 1) {
            b.raw(LINE + '\n');
            b.span('bold', {}, write);
            b.raw('\n' + LINE);
        } else if (level === 2) {
            b.raw('✦ '); b.span('bold', {}, write);
        } else if (level === 3) {
            b.raw('▸ '); b.span('bold', {}, write);
        } else if (level === 4) {
            b.span('bold', {}, write);
        } else if (level === 5) {
            b.span('bold', {}, () => b.span('italic', {}, write));
        } else {
            b.span('italic', {}, write);
        }
        b.gap = '\n';
    }

    list(kind, items, depth, b) {
        const bullets = ['•', '◦', '▪'];
        const pad = '    '.repeat(depth);
        let n = 0;
        items.forEach(item => {
            let nestedKey = null;
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                nestedKey = ['ul', 'ol'].find(k => item[k]);
            }
            if (nestedKey) { this.list(nestedKey, item[nestedKey], depth + 1, b); return; }
            if (b.listStarted) b.raw('\n');
            b.listStarted = true;
            n += 1;
            b.raw(pad + (kind === 'ol' ? `${n}. ` : `${bullets[Math.min(depth, 2)]} `));
            this.writeInline(b, inl(item));
        });
    }

    listBlock(kind, items) {
        const b = this.cur;
        b.startBlock();
        b.listStarted = false;
        this.list(kind, Array.isArray(items) ? items : [], 0, b);
        b.listStarted = false;
    }

    table(val) {
        const headers = (val.headers || []).map(h => plain(inl(h)).replace(/\s+/g, ' '));
        const rows = (val.rows || []).map(r => r.map(c => plain(inl(c)).replace(/\s+/g, ' ')));
        const cols = Math.max(headers.length, ...rows.map(r => r.length), 0);
        if (!cols) return;
        const widths = Array.from({ length: cols }, (_, c) =>
            Math.max(charWidth(headers[c] || ''), ...rows.map(r => charWidth(r[c] || '')), 1));
        const pad = (s, w) => s + ' '.repeat(Math.max(0, w - charWidth(s)));
        const sep = (l, m, r) => l + widths.map(w => '─'.repeat(w + 2)).join(m) + r;
        const line = cells => '│' + widths.map((w, c) => ' ' + pad(cells[c] || '', w) + ' ').join('│') + '│';
        const out = [sep('┌', '┬', '┐')];
        if (headers.length) { out.push(line(headers)); out.push(sep('├', '┼', '┤')); }
        rows.forEach(r => out.push(line(r)));
        out.push(sep('└', '┴', '┘'));
        const b = this.cur;
        b.startBlock();
        b.span('pre', { language: '' }, () => b.raw(out.join('\n')));
    }

    captionOf(o) {
        const cb = new Builder();
        if (o.caption !== undefined && o.caption !== '') this.writeInline(cb, inl(o.caption));
        if (o.credit) {
            if (cb.text) cb.raw('\n');
            cb.span('italic', {}, () => this.writeInline(cb, inl(o.credit)));
        }
        return cb.finish();
    }

    media(kind, v) {
        const o = typeof v === 'string' ? { src: v } : (v || {});
        if (!o.src) { this.warnings.push(`${kind}: src kosong`); return; }
        this.flush();
        this.parts.push({ type: 'media', kind, src: String(o.src), caption: this.captionOf(o) });
    }

    album(kind, v) {
        const o = Array.isArray(v) ? { items: v } : (v || {});
        const items = (o.items || []).map(x => (typeof x === 'string' ? x : x && x.src)).filter(Boolean);
        if (!items.length) { this.warnings.push(`${kind}: items kosong`); return; }
        this.flush();
        this.parts.push({ type: 'album', items, caption: this.captionOf(o) });
    }

    buttonsBlock(val) {
        const rows = (Array.isArray(val.buttons) ? val.buttons : [])
            .map(r => (Array.isArray(r) ? r : [r]))
            .map(r => r.filter(x => x && typeof x === 'object' && x.text));
        const clean = rows.filter(r => r.length);
        if (!clean.length) return;
        if (this.keyboard) { this.buttons.push(...clean); return; }
        const b = this.cur;
        b.startBlock();
        clean.forEach((row, ri) => {
            if (ri > 0) b.raw('\n');
            row.forEach((btn, bi) => {
                if (bi > 0) b.raw('   ');
                b.raw('▸ ');
                if (btn.url) b.span('url', { url: String(btn.url) }, () => b.raw(String(btn.text)));
                else if (btn.copy_text !== undefined) {
                    b.raw(`${btn.text}: `);
                    b.span('code', {}, () => b.raw(String(btn.copy_text)));
                } else b.raw(String(btn.text));
            });
        });
    }

    block(key, it) {
        const b = this.cur;
        const val = it[key];
        if (HEADINGS.has(key)) return this.heading(Number(key[1]), val);
        switch (key) {
            case 'p': case 'text': return this.para(val);
            case 'hr': b.startBlock(); b.raw(LINE); return undefined;
            case 'divider': b.startBlock(); b.raw('· · · · · · · · · ·'); return undefined;
            case 'footer':
                b.startBlock(); b.raw('— ');
                b.span('italic', {}, () => this.writeInline(b, inl(val)));
                return undefined;
            case 'a': {
                const o = typeof val === 'string' ? { url: val, text: val } : (val || {});
                b.startBlock(); b.raw('🔗 ');
                this.writeInline(b, inl({ a: { text: o.text !== undefined ? o.text : o.url, url: o.url } }));
                return undefined;
            }
            case 'blockquote': {
                const o = (val && typeof val === 'object' && !Array.isArray(val) && val.text !== undefined) ? val : { text: val };
                b.startBlock();
                b.span('quote', { collapsed: false }, () => {
                    this.writeInline(b, inl(o.text));
                    if (o.cite) { b.raw('\n— '); b.span('italic', {}, () => this.writeInline(b, inl(o.cite))); }
                });
                return undefined;
            }
            case 'aside': {
                const o = (val && typeof val === 'object' && !Array.isArray(val) && val.text !== undefined) ? val : { text: val };
                b.startBlock();
                b.span('quote', { collapsed: false }, () => {
                    b.raw('💡 ');
                    this.writeInline(b, inl(o.text));
                    if (o.cite) { b.raw('\n— '); b.span('italic', {}, () => this.writeInline(b, inl(o.cite))); }
                });
                return undefined;
            }
            case 'ul': case 'ol': return this.listBlock(key, val);
            case 'checkbox': {
                b.startBlock();
                (Array.isArray(val) ? val : []).forEach((c, i) => {
                    if (i > 0) b.raw('\n');
                    const o = (c && typeof c === 'object' && !Array.isArray(c)) ? c : { text: c, checked: false };
                    b.raw(o.checked ? '☑ ' : '☐ ');
                    this.writeInline(b, inl(o.text));
                });
                return undefined;
            }
            case 'table': return this.table(val || {});
            case 'pre': {
                const o = typeof val === 'string' ? { text: val } : (val || {});
                b.startBlock();
                b.span('pre', { language: String(o.lang || o.language || '') },
                    () => b.raw(String(o.text === undefined ? '' : o.text).replace(/\n+$/, '')));
                return undefined;
            }
            case 'math': {
                const t = typeof val === 'object' && val ? val.text : val;
                b.startBlock();
                b.span('code', {}, () => b.raw(String(t === undefined ? '' : t)));
                return undefined;
            }
            case 'details': {
                const o = val || {};
                b.startBlock();
                b.span('quote', { collapsed: !o.open }, () => {
                    b.span('bold', {}, () => this.writeInline(b, inl(o.summary)));
                    b.raw('\n');
                    this.writeInline(b, inl(o.content));
                });
                return undefined;
            }
            case 'img': case 'image': case 'photo': case 'figure': return this.media('photo', val);
            case 'video': return this.media('video', val);
            case 'audio': return this.media('audio', val);
            case 'collage': case 'slideshow': return this.album(key, val);
            case 'buttons': return this.buttonsBlock(it);
            case 'raw': return this.items(parseHtml(val));
            case 'map': {
                const lat = Number(val && val.lat);
                const long = Number(val && (val.long !== undefined ? val.long : val.lng));
                if (Number.isNaN(lat) || Number.isNaN(long)) { this.warnings.push('map: lat/long tidak valid'); return undefined; }
                this.flush();
                this.parts.push({ type: 'geo', lat, long });
                return undefined;
            }
            case 'reference': {
                const o = val || {};
                b.startBlock(); b.raw('🔖 ');
                b.span('bold', {}, () => this.writeInline(b, inl(o.text !== undefined ? o.text : o.name)));
                return undefined;
            }
            default: return undefined;
        }
    }
}

function renderDoc(input, opts = {}) {
    const doc = new Doc(opts);
    doc.items(Array.isArray(input) ? input : [input]);
    doc.flush();
    return doc;
}

function plainText(input) {
    return renderDoc(input).parts.filter(p => p.type === 'text').map(p => p.text).join('\n\n');
}

// ─────────────────────────────────────────────────────────
// ENTITY → Api
// ─────────────────────────────────────────────────────────
function toApiEntities(ents, { noEmoji = false } = {}) {
    return [...ents]
        .filter(e => !(noEmoji && e.type === 'emoji'))
        .sort((a, b) => a.offset - b.offset || b.length - a.length)
        .map(e => {
            const base = { offset: e.offset, length: e.length };
            switch (e.type) {
                case 'bold': return new Api.MessageEntityBold(base);
                case 'italic': return new Api.MessageEntityItalic(base);
                case 'underline': return new Api.MessageEntityUnderline(base);
                case 'strike': return new Api.MessageEntityStrike(base);
                case 'code': return new Api.MessageEntityCode(base);
                case 'spoiler': return new Api.MessageEntitySpoiler(base);
                case 'pre': return new Api.MessageEntityPre({ ...base, language: e.language || '' });
                case 'url': return new Api.MessageEntityTextUrl({ ...base, url: e.url });
                case 'quote': return new Api.MessageEntityBlockquote({ ...base, collapsed: !!e.collapsed });
                case 'emoji': return new Api.MessageEntityCustomEmoji({ ...base, documentId: bigInt(e.docId) });
                default: return null;
            }
        })
        .filter(Boolean);
}

function sliceEntities(ents, start, end) {
    const out = [];
    for (const e of ents) {
        const s = Math.max(e.offset, start);
        const t = Math.min(e.offset + e.length, end);
        if (t > s) out.push({ ...e, offset: s - start, length: t - s });
    }
    return out;
}

function splitText(text, entities, max = MAX_TEXT) {
    if (text.length <= max) return [{ text, entities }];
    const out = [];
    let start = 0;
    while (start < text.length) {
        while (start < text.length && text[start] === '\n') start += 1;
        if (start >= text.length) break;
        let end = Math.min(start + max, text.length);
        let next = end;
        if (end < text.length) {
            let cut = text.lastIndexOf('\n\n', end);
            if (cut <= start + max * 0.5) cut = text.lastIndexOf('\n', end);
            if (cut > start + max * 0.3) { end = cut; next = cut; }
        }
        let trimmed = end;
        while (trimmed > start && /\s/.test(text[trimmed - 1])) trimmed -= 1;
        if (trimmed > start) {
            out.push({ text: text.slice(start, trimmed), entities: sliceEntities(entities, start, trimmed) });
        }
        start = next;
    }
    return out;
}

// ─────────────────────────────────────────────────────────
// MEDIA FETCH
// ─────────────────────────────────────────────────────────
const MIME_EXT = {
    'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
    'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/mp4': 'm4a', 'audio/aac': 'aac'
};
const DEFAULT_EXT = { photo: 'jpg', video: 'mp4', audio: 'mp3' };

async function fetchMedia(src, kind) {
    let url;
    try { url = new URL(src); } catch (_) { throw new Error('URL media tidak valid'); }
    if (!/^https?:$/.test(url.protocol)) throw new Error('media harus http(s)');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
        const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (ArtaUserbot)' } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const declared = Number(res.headers.get('content-length')) || 0;
        if (declared > MAX_MEDIA_BYTES) throw new Error('file terlalu besar');
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length > MAX_MEDIA_BYTES) throw new Error('file terlalu besar');
        const mime = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
        let name = '';
        try { name = decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || ''); } catch (_) { name = ''; }
        if (!/\.[a-z0-9]{2,5}$/i.test(name)) {
            name = (name || kind).replace(/[^\w.-]/g, '_') + '.' + (MIME_EXT[mime] || DEFAULT_EXT[kind] || 'bin');
        }
        return { buffer, name };
    } finally {
        clearTimeout(timer);
    }
}

async function toFile(src, kind) {
    const { buffer, name } = await fetchMedia(src, kind);
    return new CustomFile(name, buffer.length, '', buffer);
}

// ─────────────────────────────────────────────────────────
// KEYBOARD
// ─────────────────────────────────────────────────────────
function buildMarkup(rows) {
    const out = [];
    for (const row of rows) {
        const buttons = [];
        for (const b of row) {
            const text = String(b.text).slice(0, 64);
            if (b.url) buttons.push(new Api.KeyboardButtonUrl({ text, url: String(b.url) }));
            else if (b.copy_text !== undefined) {
                buttons.push(new Api.KeyboardButtonCopy({ text, copyText: String(b.copy_text).slice(0, 256) }));
            } else if (b.callback !== undefined || b.data !== undefined) {
                buttons.push(new Api.KeyboardButtonCallback({ text, data: Buffer.from(String(b.callback !== undefined ? b.callback : b.data)).slice(0, 64) }));
            }
        }
        if (buttons.length) out.push(new Api.KeyboardButtonRow({ buttons }));
    }
    return out.length ? new Api.ReplyInlineMarkup({ rows: out }) : undefined;
}

// ─────────────────────────────────────────────────────────
// SEND
// ─────────────────────────────────────────────────────────
function isEntityError(e) {
    return /ENTIT|EMOJI|DOCUMENT_INVALID/i.test(String((e && (e.errorMessage || e.message)) || ''));
}

async function withEmojiRetry(ents, run) {
    try {
        return await run(toApiEntities(ents));
    } catch (e) {
        if (ents.some(x => x.type === 'emoji') && isEntityError(e)) {
            return run(toApiEntities(ents, { noEmoji: true }));
        }
        throw e;
    }
}

/**
 * Kirim rich message.
 * opts.keyboard : true → tombol jadi inline keyboard (hanya akun BOT yang boleh)
 * opts.edit     : { chatId, id } → edit pesan itu untuk bagian teks pertama
 * opts.replyTo  : id pesan untuk di-reply
 * Return { sent: Message[], errors: string[], warnings: string[] }
 */
async function sendRich(client, peer, input, opts = {}) {
    const doc = renderDoc(input, { buttons: opts.keyboard ? 'keyboard' : 'text' });
    const markup = doc.buttons.length ? buildMarkup(doc.buttons) : undefined;
    const result = { sent: [], errors: [], warnings: doc.warnings };

    let parts = [];
    for (const p of doc.parts) {
        if (p.type === 'text') parts.push(...splitText(p.text, p.entities).map(x => ({ type: 'text', ...x })));
        else parts.push(p);
    }
    if (!parts.length) {
        if (!markup) return result;
        parts = [{ type: 'text', text: '⠀', entities: [] }];
    }

    let edit = opts.edit || null;
    if (edit && parts[0].type !== 'text') {
        try { await client.deleteMessages(edit.chatId, [edit.id], { revoke: true }); } catch (_) { /* abaikan */ }
        edit = null;
    }

    const sendText = async (text, entities, buttons, allowEdit) => {
        if (allowEdit && edit) {
            try {
                return await withEmojiRetry(entities, ents => client.editMessage(edit.chatId, {
                    message: edit.id, text, formattingEntities: ents, linkPreview: false, buttons
                }));
            } catch (e) {
                if (/MESSAGE_NOT_MODIFIED/.test(String(e.errorMessage || e.message))) return null;
            }
        }
        return withEmojiRetry(entities, ents => client.sendMessage(peer, {
            message: text, formattingEntities: ents, linkPreview: false, buttons, replyTo: opts.replyTo
        }));
    };

    for (let i = 0; i < parts.length; i += 1) {
        const p = parts[i];
        const last = i === parts.length - 1;
        const buttons = last ? markup : undefined;
        try {
            if (p.type === 'text') {
                const m = await sendText(p.text, p.entities, buttons, i === 0);
                if (m) result.sent.push(m);
            } else if (p.type === 'media') {
                const file = await toFile(p.src, p.kind);
                const fits = p.caption.text.length <= MAX_CAPTION;
                const m = await withEmojiRetry(fits ? p.caption.entities : [], ents => client.sendFile(peer, {
                    file,
                    caption: fits ? p.caption.text : '',
                    formattingEntities: ents,
                    supportsStreaming: p.kind === 'video',
                    buttons: fits ? buttons : undefined,
                    replyTo: opts.replyTo
                }));
                result.sent.push(m);
                if (!fits) {
                    const t = await sendText(p.caption.text, p.caption.entities, buttons, false);
                    if (t) result.sent.push(t);
                }
            } else if (p.type === 'album') {
                for (let c = 0; c < p.items.length; c += 10) {
                    const chunk = p.items.slice(c, c + 10);
                    const files = [];
                    for (const src of chunk) files.push(await toFile(src, 'photo'));
                    const m = await client.sendFile(peer, { file: files.length === 1 ? files[0] : files, replyTo: opts.replyTo });
                    result.sent.push(...(Array.isArray(m) ? m : [m]));
                }
                if (p.caption.text) {
                    const t = await sendText(p.caption.text, p.caption.entities, buttons, false);
                    if (t) result.sent.push(t);
                }
            } else if (p.type === 'geo') {
                const m = await client.invoke(new Api.messages.SendMedia({
                    peer: await client.getInputEntity(peer),
                    media: new Api.InputMediaGeoPoint({ geoPoint: new Api.InputGeoPoint({ lat: p.lat, long: p.long }) }),
                    message: '',
                    randomId: generateRandomLong(),
                    replyMarkup: buttons
                }));
                result.sent.push(m);
            }
        } catch (e) {
            const why = String((e && (e.errorMessage || e.message)) || e);
            result.errors.push(`${p.type}: ${why}`);
            if (p.type !== 'text') {
                try {
                    const m = await client.sendMessage(peer, { message: `⚠️ Gagal memuat ${p.type}: ${why}`, linkPreview: false });
                    result.sent.push(m);
                } catch (_) { /* abaikan */ }
            }
        }
    }
    return result;
}

module.exports = {
    sendRich, renderDoc, plainText, parseHtml, toApiEntities, splitText, sliceEntities,
    buildMarkup, charWidth, inl, plain
};
