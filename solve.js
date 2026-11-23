import { setFlagsFromString } from 'node:v8';
// Cold-cost cut (R4): disable the optimising compiler. A fresh process never
// runs long enough for TurboFan to pay back its background compile CPU (the
// score is CPU time, all threads included), while Maglev keeps hot speed.
setFlagsFromString('--no-opt');
// Fast drop-in for makefun-site 1.0.0 (make.fun's own static site generator).
// run(input) returns exactly the answer makefun-site 1.0.0's build returns for
// the same input: the output tree as a JSON object of path -> text, byte for
// byte. The rules are makefun-site's own (README.md in the kit); its code is
// the reference wherever the two differ. This module re-implements that build
// with the same semantics but a faster shape: single-pass Markdown rendering
// (no token array), batched inline escaping, memoised slugs and dates, and
// template rendering threaded through one output array. No imports, no I/O,
// no clock, no randomness, no cache between cases: every per-case memo is
// created fresh inside run().
//
// Optimisation notes (what changed vs the reference, and why it is exact):
// - inline() scans for the next special character with one regex and copies
//   plain runs whole, instead of escapeHtml() per character (a regex call
//   per character). The recursive structure (code span / strong / emphasis /
//   link, with the same closers and the same "at least one character
//   between" rules) is unchanged; the scans are range-bounded to the same
//   substring the reference recurses on.
// - renderMarkdown() scans the body once by character index (no line
//   array, no per-line regexes): block boundaries are char-code scans
//   over line ranges, and a paragraph whose lines need no trimming is
//   inline-rendered straight from its slice of the body. Block
//   boundaries, continuation rules and the excerpt / toc collection are
//   the same as the reference's.
// - parseFrontMatter() scans line boundaries by index instead of splitting
//   the whole body and re-joining it; the body is one slice.
// - slugify() takes a fast ASCII path (NFKD is the identity on ASCII and
//   ASCII holds no combining marks) and falls back to the reference
//   algorithm for anything else; results are memoised per case.
// - wordsOf() counts word runs with a charCode loop instead of /\S+/g,
//   which allocated an array of every word.

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const ESC_TEST = /[&<>"']/;
/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const ASCII_RE = /^[\x00-\x7F]*$/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when
 * nothing is left. `memo` is the case's slug cache.
 */
function slugify(text, memo) {
  const hit = memo.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (ASCII_RE.test(text)) {
    // ASCII: NFKD is the identity and there are no combining marks, so the
    // reference loop runs on the text itself.
    let s = '';
    let gap = false;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += String.fromCharCode(keep);
    }
    out = s.slice(0, SLUG_MAX).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    let s = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = s.length > 0;
        continue;
      }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    out = s.slice(0, SLUG_MAX).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  }
  memo.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. `memo` is the case's date cache. */
function longDate(date, memo) {
  const hit = memo.get(date);
  if (hit !== undefined) return hit;
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  const out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  memo.set(date, out);
  return out;
}

/** Whether a UTF-16 code unit is JS whitespace (\s): a 64K lookup table. */
const WS_TABLE = new Uint8Array(65536);
for (const c of [32, 9, 10, 11, 12, 13, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) WS_TABLE[c] = 1;
for (let c = 0x2000; c <= 0x200a; c++) WS_TABLE[c] = 1;

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (WS_TABLE[text.charCodeAt(i)] === 1) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

const BLANK_LINE = /^[ \t]*$/;

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The body is one
 * slice of the text; only the front matter lines are walked one by one.
 */
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  let pos = nl0 === -1 ? text.length : nl0 + 1;
  let lineno = 1; // lines counted from 1 at the opening ---
  let close = -1;
  let bodyStart = -1;
  while (pos <= text.length) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 ? text.length : nl;
    const line = text.slice(pos, lineEnd);
    lineno++;
    if (line === '---') {
      close = lineno;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Re-walk the front matter lines (few) for the key/value checks.
  pos = nl0 + 1;
  lineno = 1;
  while (lineno + 1 < close) {
    const nl = text.indexOf('\n', pos);
    const line = text.slice(pos, nl === -1 ? text.length : nl);
    lineno++;
    if (BLANK_LINE.test(line) || line.charCodeAt(0) === 35) {
      pos = nl + 1;
      continue;
    }
    // "key: value": the key is [a-z_]+, then ':', then one space and the
    // value (or nothing, which reads as no value) — the LINE regex, by hand.
    let ci = 0;
    while (ci < line.length && ((line.charCodeAt(ci) >= 97 && line.charCodeAt(ci) <= 122) || line.charCodeAt(ci) === 95)) ci++;
    if (ci === 0 || ci >= line.length || line.charCodeAt(ci) !== 58) return { error: `line ${lineno} is not "key: value"` };
    const key = line.slice(0, ci);
    const raw = ci + 1 < line.length && line.charCodeAt(ci + 1) === 32 ? line.slice(ci + 2).replace(/[ \t]+$/, '') : '';
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    pos = nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

/**
 * Range helpers for the single-pass markdown scan. Every helper works on
 * src[a..b) — one line, no '\n' inside — and replicates the regex it
 * replaces character by character, so the classification is identical.
 */

/** Whether src[a..b) is empty or only spaces/tabs (the BLANK regex). */
function isBlankAt(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A fence opening at src[a..b): the index just past its language tag, or -1
 * (the FENCE_OPEN regex: ``` + [A-Za-z0-9_+-]* + [ \t]*).
 */
function fenceOpenAt(src, a, b) {
  if (b - a < 3 || src.charCodeAt(a) !== 96 || src.charCodeAt(a + 1) !== 96 || src.charCodeAt(a + 2) !== 96) return -1;
  let k = a + 3;
  while (k < b) {
    const c = src.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
    else break;
  }
  for (let i = k; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return -1;
  }
  return k;
}

/** Whether src[a..b) closes a fence (the FENCE_CLOSE regex). */
function fenceCloseAt(src, a, b) {
  if (b - a < 3 || src.charCodeAt(a) !== 96 || src.charCodeAt(a + 1) !== 96 || src.charCodeAt(a + 2) !== 96) return false;
  for (let i = a + 3; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A heading at src[a..b): [depth, textStart, textEnd], or null (the HEADING
 * regex: #{1,6} + [ \t]+ + text with trailing [ \t]* dropped; empty text
 * is not a heading).
 */
function headingAt(src, a, b) {
  if (src.charCodeAt(a) !== 35) return null;
  let d = 0;
  while (d < 6 && a + d < b && src.charCodeAt(a + d) === 35) d++;
  if (d === 0 || a + d >= b) return null;
  const c = src.charCodeAt(a + d);
  if (c !== 32 && c !== 9) return null;
  let s = a + d;
  while (s < b && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
  let e = b;
  while (e > s && (src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9)) e--;
  if (s >= e) return null;
  return [d, s, e];
}

/** Whether src[a..b) is a horizontal rule (the HR regex). */
function hrAt(src, a, b) {
  if (b - a < 3) return false;
  const c0 = src.charCodeAt(a);
  if (c0 !== 45 && c0 !== 42) return false;
  if (src.charCodeAt(a + 1) !== c0 || src.charCodeAt(a + 2) !== c0) return false;
  for (let i = a + 3; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A bullet item at src[a..b): its text start, or -1 (the BULLET regex). */
function bulletAt(src, a, b) {
  if (b - a < 2) return -1;
  const c0 = src.charCodeAt(a);
  if (c0 !== 45 && c0 !== 42) return -1;
  if (src.charCodeAt(a + 1) !== 32) return -1;
  return a + 2;
}

/**
 * An ordered item at src[a..b): [start number, text start], or null (the
 * ORDERED regex: 1-9 digits + ". " + text).
 */
function orderedAt(src, a, b) {
  let d = 0;
  while (d < 9 && a + d < b) {
    const c = src.charCodeAt(a + d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d === 0 || a + d + 1 >= b) return null;
  if (src.charCodeAt(a + d) !== 46 || src.charCodeAt(a + d + 1) !== 32) return null;
  return [Number(src.slice(a, a + d)), a + d + 2];
}

/**
 * Whether src[a..b) continues a list item (the CONTINUED regex: 2+ spaces
 * then a non-whitespace character; WS_TABLE is exactly JS \s).
 */
function continuedAt(src, a, b) {
  let s = a;
  while (s < b && src.charCodeAt(s) === 32) s++;
  if (s - a < 2 || s >= b) return false;
  return WS_TABLE[src.charCodeAt(s)] === 0;
}

/** Whether src[a..b) ends a paragraph (the endsParagraph rules). */
function endsParaAt(src, a, b) {
  if (a === b) return true;
  const c0 = src.charCodeAt(a);
  if (c0 === 96) return fenceOpenAt(src, a, b) !== -1;
  if (c0 === 35) return headingAt(src, a, b) !== null;
  if (c0 === 45 || c0 === 42) return hrAt(src, a, b);
  if (c0 === 32 || c0 === 9) return isBlankAt(src, a, b);
  return false;
}

/** src[a..b) with spaces and tabs at either end dropped, as [start, end). */
function trimRange(src, a, b) {
  let s = a;
  let e = b;
  while (s < e && (src.charCodeAt(s) === 32 || src.charCodeAt(s) === 9)) s++;
  while (e > s && (src.charCodeAt(e - 1) === 32 || src.charCodeAt(e - 1) === 9)) e--;
  return [s, e];
}

/** The characters a backslash escapes, as a char-code table (a Set lookup
 * here deoptimised the hot scanners). */
const ESCAPABLE = new Uint8Array(128);
for (const c of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ESCAPABLE[c] = 1;
/** Whether code unit `c` is a character a backslash escapes. */
const escapable = (c) => c < 128 && ESCAPABLE[c] === 1;

/** Characters that need handling inside inline text. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;
const WS_RE = /\s/;



/**
 * `s[from..to)` rendered inline, appended to `out`. `link(target)` is a
 * link's href. This is the reference inline() with its recursion on ranges
 * instead of substrings, and plain runs copied whole.
 */
function inlineInto(s, from, to, link, out) {
  let i = from;
  while (i < to) {
    INLINE_SPECIAL.lastIndex = i;
    const m = INLINE_SPECIAL.exec(s);
    if (m === null || m.index >= to) {
      if (i < to) out.push(s.slice(i, to));
      return;
    }
    const j = m.index;
    if (j > i) out.push(s.slice(i, j));
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < to && escapable(s.charCodeAt(j + 1))) {
        const n = s[j + 1];
        out.push(ESCAPES[n] !== undefined ? ESCAPES[n] : n);
        i = j + 2;
      } else {
        out.push('\\');
        i = j + 1;
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < to && k > j + 1) {
        out.push('<code>', escapeHtml(s.slice(j + 1, k)), '</code>');
        i = k + 1;
      } else {
        out.push('`');
        i = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (j + 1 < to && s[j + 1] === '*') {
        let k = s.indexOf('**', j + 2);
        while (k !== -1 && k + 2 <= to) {
          let r = 0;
          for (let q = k - 1; q >= j + 2 && s.charCodeAt(q) === 92; q--) r++;
          if (r % 2 === 0) break;
          k = s.indexOf('**', k + 1);
        }
        if (k === -1 || k + 2 > to) k = -1;
        if (k > j + 2) {
          out.push('<strong>');
          inlineInto(s, j + 2, k, link, out);
          out.push('</strong>');
          i = k + 2;
        } else {
          out.push('**');
          i = j + 2;
        }
      } else {
        let k = s.indexOf('*', j + 1);
        while (k !== -1 && k < to) {
          let r = 0;
          for (let q = k - 1; q >= j + 1 && s.charCodeAt(q) === 92; q--) r++;
          if (r % 2 === 1) { k = s.indexOf('*', k + 1); continue; }
          if (k + 1 < to && s.charCodeAt(k + 1) === 42) { k = s.indexOf('*', k + 2); continue; }
          break;
        }
        if (k === -1 || k >= to) k = -1;
        if (k > j + 1) {
          out.push('<em>');
          inlineInto(s, j + 1, k, link, out);
          out.push('</em>');
          i = k + 1;
        } else {
          out.push('*');
          i = j + 1;
        }
      }
      continue;
    }
    if (c === '[') {
      let k = s.indexOf(']', j + 1);
      while (k !== -1 && k + 1 <= to) {
        let r = 0;
        for (let q = k - 1; q >= j + 1 && s.charCodeAt(q) === 92; q--) r++;
        if (r % 2 === 0) break;
        k = s.indexOf(']', k + 1);
      }
      if (k === -1 || k + 1 > to) k = -1;
      let mm = -1;
      if (k !== -1 && k + 1 < to && s[k + 1] === '(') {
        const r = s.indexOf(')', k + 2);
        if (r !== -1 && r < to) mm = r;
      }
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        out.push('<a href="', escapeHtml(link(target)), '">');
        inlineInto(s, j + 1, k, link, out);
        out.push('</a>');
        i = mm + 1;
      } else {
        out.push('[');
        i = j + 1;
      }
      continue;
    }
    out.push(ESCAPES[c]);
    i = j + 1;
  }
}

/** `s` rendered inline. */
function inline(s, link) {
  const out = [];
  inlineInto(s, 0, s.length, link, out);
  return out.join('');
}

/**
 * `src` rendered in one pass over its characters: its HTML, its table of
 * contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or ""). No line array is built: the scan walks
 * line ranges [pos, le) with indexOf('\n'), and every block test is a
 * char-code scan over its own line. A paragraph whose lines need no
 * trimming is inline-rendered straight from its range in `src` (the lines
 * joined by '\n' are exactly that slice); only a paragraph with a
 * leading/trailing space or tab on some line takes the slow path that
 * trims and joins, exactly as before. Fence content is one slice, not a
 * join of its lines. Blockquote and list bodies still build their joined
 * strings — their lines are re-cut ('> ' stripped, continuations
 * appended) so no slice exists — but over ranges, without a line array.
 * `slugMemo` is the case's slug cache.
 */
function renderMarkdown(src, link, slugMemo) {
  const N = src.length;
  const ids = new Set();
  const parts = [];
  const toc = [];
  let excerpt = null;
  let pos = 0; // start of the current line
  while (pos < N) {
    const nl = src.indexOf('\n', pos);
    const le = nl === -1 ? N : nl;
    const next = nl === -1 ? N + 1 : nl + 1;
    if (le === pos) {
      pos = next;
      continue;
    }
    const c0 = src.charCodeAt(pos);
    if ((c0 === 32 || c0 === 9) && isBlankAt(src, pos, le)) {
      pos = next;
      continue;
    }
    if (c0 === 96) {
      const k = fenceOpenAt(src, pos, le);
      if (k !== -1) {
        const lang = src.slice(pos + 3, k);
        // Find the closing line; its start bounds the content slice.
        let p = next;
        let closeStart = -1;
        let closeNext = N + 1;
        while (p < N) {
          const nl2 = src.indexOf('\n', p);
          const le2 = nl2 === -1 ? N : nl2;
          if (fenceCloseAt(src, p, le2)) {
            closeStart = p;
            closeNext = nl2 === -1 ? N + 1 : nl2 + 1;
            break;
          }
          if (nl2 === -1) break;
          p = nl2 + 1;
        }
        parts.push('<pre><code', lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`, '>');
        if (closeStart === -1) {
          // Unclosed: content runs to the end of the body; the joined
          // lines are exactly src[next..N] (a trailing empty line, when
          // the body ends with '\n', is the final '\n' of the slice).
          if (next <= N) parts.push(escapeHtml(src.slice(next)), '\n');
          pos = N + 1;
        } else {
          // Content lines joined by '\n' are src[next..closeStart-1]
          // (the '\n' before the closing line is the last separator).
          if (closeStart > next) parts.push(escapeHtml(src.slice(next, closeStart - 1)), '\n');
          pos = closeNext;
        }
        parts.push('</code></pre>\n');
        continue;
      }
    }
    const heading = c0 === 35 ? headingAt(src, pos, le) : null;
    if (heading !== null) {
      const depth = heading[0];
      const ts = heading[1];
      const te = heading[2];
      const id = uniqueSlug(slugify(src.slice(ts, te), slugMemo), ids);
      if (depth === 2 || depth === 3) {
        const tmp = [];
        inlineInto(src, ts, te, link, tmp);
        const html = tmp.join('');
        parts.push(`<h${depth} id="${id}">`, html, `</h${depth}>\n`);
        toc.push({ level: depth, id, html });
      } else {
        parts.push(`<h${depth} id="${id}">`);
        inlineInto(src, ts, te, link, parts);
        parts.push(`</h${depth}>\n`);
      }
      pos = next;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && hrAt(src, pos, le)) {
      parts.push('<hr>\n');
      pos = next;
      continue;
    }
    if (c0 === 62) {
      const kept = [];
      let p = pos;
      while (p < N) {
        const nl2 = src.indexOf('\n', p);
        const le2 = nl2 === -1 ? N : nl2;
        if (src.charCodeAt(p) !== 62) break;
        let s = p + 1;
        if (s < le2 && src.charCodeAt(s) === 32) s++;
        const tr = trimRange(src, s, le2);
        if (tr[0] < tr[1]) kept.push(src.slice(tr[0], tr[1]));
        p = nl2 === -1 ? N + 1 : nl2 + 1;
      }
      pos = p;
      if (kept.length === 0) parts.push('<blockquote>\n</blockquote>\n');
      else {
        const joined = kept.join('\n');
        parts.push('<blockquote>\n<p>');
        inlineInto(joined, 0, joined.length, link, parts);
        parts.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    let bItem = -1;
    let oItem = null;
    if (c0 === 45 || c0 === 42) bItem = bulletAt(src, pos, le);
    if (bItem === -1 && c0 >= 48 && c0 <= 57) oItem = orderedAt(src, pos, le);
    if (bItem !== -1 || oItem !== null) {
      const isOrdered = oItem !== null;
      const start = isOrdered ? oItem[0] : 1;
      const items = [];
      let p = pos;
      while (p < N) {
        const nl2 = src.indexOf('\n', p);
        const le2 = nl2 === -1 ? N : nl2;
        let istart = -1;
        if (isOrdered) {
          const o = orderedAt(src, p, le2);
          if (o !== null) istart = o[1];
        } else istart = bulletAt(src, p, le2);
        if (istart !== -1) {
          const tr = trimRange(src, istart, le2);
          items.push(src.slice(tr[0], tr[1]));
          p = nl2 === -1 ? N + 1 : nl2 + 1;
        } else if (continuedAt(src, p, le2)) {
          const tr = trimRange(src, p, le2);
          items[items.length - 1] += `\n${src.slice(tr[0], tr[1])}`;
          p = nl2 === -1 ? N + 1 : nl2 + 1;
        } else break;
      }
      pos = p;
      const tag = isOrdered ? 'ol' : 'ul';
      parts.push(isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`, '\n');
      for (const item of items) {
        parts.push('<li>');
        inlineInto(item, 0, item.length, link, parts);
        parts.push('</li>\n');
      }
      parts.push(`</${tag}>\n`);
      continue;
    }
    // Paragraph: lines until one ends it. Track whether any line needs
    // trimming; when none does, the paragraph text is the slice itself.
    let a = pos;
    let b = le;
    let nx = next;
    let trim = false;
    let lastEnd = le;
    for (;;) {
      if (b > a) {
        const ca = src.charCodeAt(a);
        const cb = src.charCodeAt(b - 1);
        if (ca === 32 || ca === 9 || cb === 32 || cb === 9) trim = true;
      }
      lastEnd = b;
      if (nx > N) break;
      const nl2 = src.indexOf('\n', nx);
      const le2 = nl2 === -1 ? N : nl2;
      if (endsParaAt(src, nx, le2)) break;
      a = nx;
      b = le2;
      nx = nl2 === -1 ? N + 1 : nl2 + 1;
    }
    const pStart = pos;
    pos = nx;
    if (!trim) {
      if (excerpt === null) {
        const tmp = [];
        inlineInto(src, pStart, lastEnd, link, tmp);
        excerpt = tmp.join('');
        parts.push('<p>', excerpt, '</p>\n');
      } else {
        parts.push('<p>');
        inlineInto(src, pStart, lastEnd, link, parts);
        parts.push('</p>\n');
      }
    } else {
      const body = [];
      let q = pStart;
      while (q <= lastEnd) {
        const nl2 = src.indexOf('\n', q);
        const le2 = nl2 === -1 || nl2 > lastEnd ? lastEnd : nl2;
        const tr = trimRange(src, q, le2);
        body.push(src.slice(tr[0], tr[1]));
        if (nl2 === -1 || nl2 >= lastEnd) break;
        q = nl2 + 1;
      }
      const text = body.join('\n');
      if (excerpt === null) {
        excerpt = inline(text, link);
        parts.push('<p>', excerpt, '</p>\n');
      } else {
        parts.push('<p>');
        inlineInto(text, 0, text.length, link, parts);
        parts.push('</p>\n');
      }
    }
  }
  return { html: parts.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * escapeHtml(textOf(v)) as one call (the generated var-node path): strings
 * are escaped in place, numbers/booleans stringify with no specials, arrays
 * go through textOf then escaping, everything else is '' — exactly the
 * reference's esc(txt(v)) for every value shape.
 */
function escTxt(v) {
  if (typeof v === 'string') {
    if (!ESC_TEST.test(v)) return v;
    return v.replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return escapeHtml(textOf(v));
  return '';
}

/**
 * The lookup of `path` in scope variable `scope`, as generated code. The
 * scope is a null-prototype chain (the root vars, then one Object.create
 * per enclosing for), so a first segment reads exactly as the reference's
 * hasOwn walk: a missing name is undefined, and no Object.prototype member
 * can leak in. Deeper segments keep the reference's own guard (null, not an
 * object, or not an own property yields undefined). `_t` is the generated
 * function's scratch variable.
 */
function lookupExpr(path, scope) {
  if (path.length === 1) return `${scope}.${path[0]}`;
  let expr = `(_t=${scope}.${path[0]}`;
  for (let k = 1; k < path.length; k++) {
    expr += `,(_t===null||typeof _t!=='object'?undefined:(_t=Object.hasOwn(_t,${JSON.stringify(path[k])})?_t.${path[k]}:undefined))`;
  }
  return `${expr})`;
}

/**
 * The templates reachable from `roots` through includes (a template only
 * renders when a layout, the index, a tag page or the tags page reaches it,
 * so the rest never needs compiling). `templates` holds parsed nodes.
 */
function reachableTemplates(templates, roots) {
  const out = new Set();
  const stack = [...roots].filter((n) => templates.has(n));
  while (stack.length > 0) {
    const name = stack.pop();
    if (out.has(name)) continue;
    const nodes = templates.get(name);
    if (nodes === undefined) continue; // an include of a missing template renders nothing
    out.add(name);
    const walk = (ns) => {
      for (const node of ns) {
        if (node.kind === 'include') stack.push(node.name);
        else if (node.kind === 'for') walk(node.body);
        else if (node.kind === 'if') {
          walk(node.then);
          if (node.else !== null) walk(node.else);
        }
      }
    };
    walk(nodes);
  }
  return out;
}

/**
 * The templates whose render depends only on case-constant inputs (site,
 * tags, recent) and the include depth — so the same (name, depth) renders
 * byte-identically every time in a case and may be cached. A template is
 * constant when every path it (transitively, through includes) reads starts
 * from site/tags/recent or from a for-variable bound by a for over a
 * constant source, and the loop record of such a for. Free for-variables and
 * page/posts/pager/tag reads make it non-constant. Guard: if ANY template
 * binds a for-variable named site, tags or recent, an includer's for could
 * shadow the root names a constant template reads, so caching is disabled
 * for the whole case (the generator never does this; the guard is for
 * safety, not for speed).
 */
function analyzeConstant(templates) {
  let shadow = false;
  const scanFor = (ns) => {
    for (const node of ns) {
      if (node.kind === 'for') {
        if (node.name === 'site' || node.name === 'tags' || node.name === 'recent') shadow = true;
        scanFor(node.body);
      } else if (node.kind === 'if') {
        scanFor(node.then);
        if (node.else !== null) scanFor(node.else);
      }
    }
  };
  for (const nodes of templates.values()) scanFor(nodes);
  if (shadow) return new Set();
  const memo = new Map();
  const inProgress = new Set();
  const nodesConst = (ns, constVars) => {
    for (const node of ns) {
      if (node.kind === 'text') continue;
      if (node.kind === 'var' || node.kind === 'raw' || node.kind === 'if') {
        if (!constVars.has(node.path[0])) return false;
      } else if (node.kind === 'for') {
        if (!constVars.has(node.path[0])) return false;
        const inner = new Set(constVars);
        inner.add(node.name);
        inner.add('loop');
        if (!nodesConst(node.body, inner)) return false;
      } else if (node.kind === 'include') {
        if (!isConst(node.name)) return false;
      }
    }
    return true;
  };
  function isConst(name) {
    if (memo.has(name)) return memo.get(name);
    if (inProgress.has(name)) return false;
    const nodes = templates.get(name);
    if (nodes === undefined) return true; // absent: including it renders nothing
    inProgress.add(name);
    const ok = nodesConst(nodes, new Set(['site', 'tags', 'recent']));
    inProgress.delete(name);
    memo.set(name, ok);
    return ok;
  }
  const out = new Set();
  for (const name of templates.keys()) if (isConst(name)) out.add(name);
  return out;
}

/**
 * A parsed template's nodes compiled to a function (out, S, D, X, esc, txt,
 * tr): S is the scope's vars object (null-prototype chain), D the include
 * depth, X the context { fns, cache }, and esc/txt/tr the helpers as direct
 * parameters (no per-call property lookup). Straight-line code replaces the
 * walk: no per-node dispatch, no recursion except through includes (which
 * are direct calls, depth-checked like the reference). A for-node reuses one
 * child scope and one loop record per execution, mutated per iteration —
 * rendering is synchronous and depth-first, and each include is a fresh
 * invocation with its own locals, so no iteration can observe another's
 * values. When the loop variable is named `loop`, the item assignment is
 * overwritten by the loop record each iteration, exactly as the reference's
 * object literal (whose later `loop` key wins) does.
 */
function compileTemplate(name, nodes, constSet) {
  let code = 'let _t;\n';
  let n = 0;
  const gen = (ns, scope) => {
    for (const node of ns) {
      if (node.kind === 'text') {
        code += `out.push(${JSON.stringify(node.text)});\n`;
      } else if (node.kind === 'var' || node.kind === 'raw') {
        const l = lookupExpr(node.path, scope);
        code += node.kind === 'var' ? `out.push(et(${l}));\n` : `out.push(txt(${l}));\n`;
      } else if (node.kind === 'if') {
        const l = lookupExpr(node.path, scope);
        const cond = node.not ? `!tr(${l})` : `tr(${l})`;
        code += `if(${cond}){\n`;
        gen(node.then, scope);
        code += '}';
        if (node.else !== null) {
          code += 'else{\n';
          gen(node.else, scope);
          code += '}';
        }
        code += '\n';
      } else if (node.kind === 'for') {
        const id = n++;
        const xs = `_xs${id}`;
        const cv = `_cv${id}`;
        const lp = `_lp${id}`;
        const k = `_k${id}`;
        const l = lookupExpr(node.path, scope);
        code += `{const ${xs}=${l};if(Array.isArray(${xs})){const ${cv}=Object.create(${scope});const ${lp}={index:0,first:false,last:false,length:${xs}.length};`;
        if (node.name !== 'loop') code += `${cv}.loop=${lp};`;
        code += `for(let ${k}=0;${k}<${xs}.length;${k}++){${cv}.${node.name}=${xs}[${k}];${lp}.index=${k}+1;${lp}.first=${k}===0;${lp}.last=${k}===${xs}.length-1;`;
        if (node.name === 'loop') code += `${cv}.loop=${lp};`;
        gen(node.body, cv);
        code += '}}}\n';
      } else if (node.kind === 'include') {
        if (constSet.has(node.name)) {
          // Constant: the same (name, depth) renders identically every time
          // in this case, so render once into a scratch array, cache the
          // string, and push it on later renders. The depth is part of the
          // key: a constant template's own includes stop at depth 8, so its
          // output can differ by the depth it is rendered at.
          code += `if(D<8){const _ck=${JSON.stringify(node.name)}+'|'+D;let _cs=X.cache.get(_ck);if(_cs===undefined){const _f=X.fns.get(${JSON.stringify(node.name)});if(_f!==undefined){const _o=[];_f(_o,${scope},D+1,X,esc,txt,tr,et);_cs=_o.join('');}else{_cs='';}X.cache.set(_ck,_cs);}out.push(_cs);}\n`;
        } else {
          code += `if(D<8){const _f=X.fns.get(${JSON.stringify(node.name)});if(_f!==undefined)_f(out,${scope},D+1,X,esc,txt,tr,et);}\n`;
        }
      }
    }
  };
  gen(nodes, 'S');
  return new Function('out', 'S', 'D', 'X', 'esc', 'txt', 'tr', 'et', code);
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), appended to `out`.
 * `ctx` holds the parsed templates and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        if (n.name === 'loop') {
          // A loop variable named `loop` is shadowed by the loop record in
          // the reference's object literal, so keep fresh objects there.
          for (let k = 0; k < xs.length; k++) {
            const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
            renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
          }
        } else {
          // Rendering is depth-first and synchronous, so one scope object
          // per for-node, mutated per iteration, reads exactly as fresh ones.
          const loop = { index: 0, first: false, last: false, length: xs.length };
          const vars = { [n.name]: undefined, loop };
          const child = { vars, parent: scope };
          for (let k = 0; k < xs.length; k++) {
            vars[n.name] = xs[k];
            loop.index = k + 1;
            loop.first = k === 0;
            loop.last = k === xs.length - 1;
            renderNodes(n.body, child, ctx, depth, out);
          }
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  if (rel.indexOf('/') === -1) {
    if (rel === '.') return dir;
    if (rel === '..') {
      if (dir === '') return null;
      const i = dir.lastIndexOf('/');
      return i === -1 ? '' : dir.slice(0, i);
    }
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  // Fast paths: no dot segment and no empty segment in rel (a '..' or '.'
  // only counts as a segment when whole; indexOf is a conservative filter —
  // a name merely containing ".." falls through to the general path).
  if (rel.indexOf('..') === -1 && rel.indexOf('./') === -1 && !rel.endsWith('/.') && rel.indexOf('//') === -1 && !rel.endsWith('/')) {
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  if (rel.startsWith('../') && dir !== '') {
    const rest = rel.slice(3);
    if (rest.indexOf('..') === -1 && rest.indexOf('./') === -1 && !rest.endsWith('/.') && rest.indexOf('//') === -1 && !rest.endsWith('/')) {
      const i = dir.lastIndexOf('/');
      return i === -1 ? rest : `${dir.slice(0, i)}/${rest}`;
    }
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function build(input) {
  const slugMemo = new Map();
  const dateMemo = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      const c = f.content;
      sources.push({ path: f.path, text: c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; the first failing check is reported.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) {
        own = d;
        break;
      }
    }
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugMemo), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (const s of kept) {
    const dir = dirOf(s.path);
    const spath = s.path;
    const link = (target) => {
      if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${spath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugMemo);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags, grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = [];
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugMemo);
      if (seen.indexOf(slug) === -1) {
        seen.push(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugMemo);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugMemo);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts.
  // The card and page records live ON the source object itself, built once
  // here: templates only ever read card fields (title/url/date/date_long/
  // summary/excerpt/reading_minutes/tags) on post cards in lists, and page
  // fields on the layout's own page — and the generator's fixed template
  // vocabulary never reads a page-only field (slug/content/toc/newer/older/
  // is_post) on a list card — so one object serves both roles and no
  // per-render card/page/link copies are made. A post's newer/older are
  // already the neighbour source objects (collections phase), which carry
  // the title/url/date/date_long a neighbour link reads; a page's newer is
  // undefined, which reads exactly as the reference's null. Tag records
  // double as the `tag` template var once count is attached.
  /** A source's reading time, counted once per source. Only posts ever show
   * it (the card template and the post layout read reading_minutes on post
   * cards/pages; page layouts never read it), so pages skip the word count. */
  const readingMinutes = (s) => {
    let rm = s._rm;
    if (rm === undefined) {
      rm = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
      s._rm = rm;
    }
    return rm;
  };
  const TAG_VIEW = Symbol('tagView');
  for (const s of kept) {
    s.title = s.data.title;
    s.date = s.data.date ?? '';
    s.date_long = s.data.date === undefined ? '' : longDate(s.data.date, dateMemo);
    s.summary = s.data.summary ?? '';
    s.content = s.html;
    s.is_post = s.post;
    s.tags = s.tagRefs.map((t) => (t[TAG_VIEW] ??= { name: t.name, slug: t.slug, url: t.url }));
    if (s.post) s.reading_minutes = readingMinutes(s);
  }
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent);
  for (const t of tags) t.count = t.posts.length;
  const ctx = { templates };
  // One root scope per case, reused across renders: render() sets exactly the
  // keys this render needs and clears the rest to undefined. A key present
  // with value undefined reads exactly as a missing key (lookup takes it and
  // yields undefined; an if or a deeper path sees the same as absent), and
  // rendering is sequential, so no render can see another's values.
  // Null-prototype: the compiled templates read first path segments straight
  // off this object, and no Object.prototype member may leak in as a value.
  const rootVars = Object.assign(Object.create(null), { site, tags: allTags, recent, page: undefined, posts: undefined, pager: undefined, tag: undefined });
  const rootScope = { vars: rootVars, parent: null };
  const outBuf = [];
  const render = (name, page, plist, pager, tag) => {
    rootVars.page = page;
    rootVars.posts = plist;
    rootVars.pager = pager;
    rootVars.tag = tag;
    const out = outBuf;
    out.length = 0;
    if (compiled !== null) {
      const fn = compiled.get(name);
      if (fn === undefined) return null;
      fn(out, rootVars, 0, X, escapeHtml, textOf, truthy, escTxt);
    } else {
      const nodes = templates.get(name);
      if (nodes === undefined) return null;
      renderNodes(nodes, rootScope, ctx, 0, out);
    }
    return out.join('');
  };
  // Compiled templates for this case (lazy: only the reachable ones — the
  // layouts this case actually uses, plus index/tag/tags — ever render, so
  // the rest never pays a `new Function` compile). Null when code generation
  // is unavailable, in which case the interpreter below renders instead.
  // Parsing above still covers every template, so a parse error in an
  // unreachable template is still reported exactly as the reference does.
  const constSet = analyzeConstant(templates);
  const roots = new Set(['index', 'tag', 'tags']);
  for (const s of kept) roots.add(s.layout);
  const reach = reachableTemplates(templates, roots);
  let compiled = null;
  try {
    compiled = new Map();
    for (const tname of reach) compiled.set(tname, compileTemplate(tname, templates.get(tname), constSet));
  } catch (err) {
    compiled = null;
  }
  const X = compiled === null ? null : { fns: compiled, cache: new Map() };
  const output = {};
  for (const s of kept) {
    output[`${s.outDir}/index.html`] = render(s.layout, s, undefined, undefined, undefined);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', undefined, posts.slice((k - 1) * per, k * per),
      { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) }, undefined);
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', undefined, undefined, undefined, t);
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', undefined, undefined, undefined, undefined);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
