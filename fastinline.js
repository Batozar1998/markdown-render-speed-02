// Fast inline tokenizer: a drop-in for marked 18.1.3's Lexer.inlineTokens that
// produces byte-identical token arrays for the inline runs it accepts, and throws
// Bail for any run it cannot prove it handles, so the caller falls back to marked.
// Forked from marked (MIT, see vendor/marked/LICENSE): the rule regexes are marked's
// own (via Lexer.rules), the driver is a hand scanner instead of marked's try-every-
// regex loop, and the text runs are consumed by a char scanner instead of marked's
// lazy lookahead regex. Nothing is cached between runs: every run is tokenized alone.
import { Lexer } from './vendor/marked/marked.esm.js';

export class Bail extends Error {}

// Probe lexer: the rule sets marked itself uses with its defaults (GFM on).
const __probe = new Lexer();
const RULES = __probe.tokenizer.rules;
const INLINE = RULES.inline;
const OTHER = RULES.other;

const PUNCT_RE = /[\p{P}\p{S}]/u;
const EMAIL_CHARS = new Set();
for (const ch of "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.!#$%&'*+/=?^_`{|}~-") EMAIL_CHARS.add(ch);
const isEmailCharCode = (c) =>
  (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ||
  c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 || c === 42 ||
  c === 43 || c === 45 || c === 46 || c === 47 || c === 61 || c === 63 || c === 94 ||
  c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 126;
const isAlnumCode = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isWSCode = (c) => c === 32 || c === 9 || c === 10 || c === 13 || c === 12;
const isPunctCode = (c) => {
  if (c < 128) {
    return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
  }
  return PUNCT_RE.test(String.fromCodePoint(c));
};

// ---- helpers ported from marked (helpers.ts) ----
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function escapeHtmlEntities(html, encode) {
  if (encode) {
    if (OTHER.escapeTest.test(html)) return html.replace(OTHER.escapeReplace, (ch) => ESC_MAP[ch]);
  } else if (OTHER.escapeTestNoEncode.test(html)) {
    return html.replace(OTHER.escapeReplaceNoEncode, (ch) => ESC_MAP[ch]);
  }
  return html;
}

export function decodeNumericCharacterReferences(text) {
  if (!OTHER.numericCharacterReference.test(text)) return text;
  return text.replace(OTHER.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

export function normalizeLabel(label) {
  return label.trim().replace(OTHER.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

export function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) suffLen++;
    else if (currChar !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

export function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = INLINE.code.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = INLINE.tag.exec(tokenSrc) || INLINE.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// ---- the fast inline pass ----
// Tokenizes src into `out` (fresh array). Throws Bail when it cannot prove the
// result identical to marked's; the caller then runs marked's inlineTokens.
export function fastInlineTokens(lexer, src, out) {
  const prevLPP = lexer.state.linkParenPossible;
  lexer.state.linkParenPossible = prevLPP && src.includes(')');
  try {
    fastInlineInner(lexer, src, out);
  } finally {
    lexer.state.linkParenPossible = prevLPP;
  }
}

function fastInlineInner(lexer, src, out) {
  const n = src.length;
  const state = lexer.state;
  let p = 0;
  let prevChar = '';
  let keepPrevChar = false;
  // Emphasis/delimiter context for this pass, built lazily on the first
  // emphasis attempt: the masked source and its closer-scan frame.
  const ctx = { masked: null, framePushed: false, ensureMask: null };
  const ensureMask = () => {
    if (ctx.masked === null) {
      ctx.masked = maskSrc(lexer, src);
      beginCloserScan(lexer, ctx.masked);
      ctx.framePushed = true;
    }
    return ctx.masked;
  };
  ctx.ensureMask = ensureMask;
  try {
    fastInlineLoop(lexer, src, out, ctx, ensureMask);
  } finally {
    if (ctx.framePushed) endCloserScan(lexer);
  }
}

function fastInlineLoop(lexer, src, out, ctx, ensureMask) {
  const n = src.length;
  const state = lexer.state;
  let p = 0;
  let prevChar = '';
  let keepPrevChar = false;
  // text accumulator (marked merges consecutive text tokens)
  let textRaw = '';
  let textText = '';
  let textEscaped = false;
  let textHas = false;
  const flushText = () => {
    if (!textHas) return;
    out.push({ type: 'text', raw: textRaw, text: textText, escaped: textEscaped });
    textRaw = '';
    textText = '';
    textHas = false;
  };
  const appendText = (rawChunk) => {
    const esc = state.inRawBlock;
    if (!textHas) { textHas = true; textEscaped = esc; }
    textRaw += rawChunk;
    textText += esc ? rawChunk : decodeNumericCharacterReferences(rawChunk);
    if (rawChunk.slice(-1) !== '_') prevChar = rawChunk.slice(-1);
    keepPrevChar = true;
  };

  // Find the end of a text run starting at p. Mirrors marked's inline text
  // regex: first group is a backtick run, a tilde run, or one char; the run then
  // continues until a stop (special char, url/email/www start, hard break).
  // The scan is native (one regex for the next hard stop, indexOf for the
  // url/email/br boundaries inside the segment), not a per-character loop.
  const STOP_RE = /[\\<\[`*!~_]/g;
  const scanTextEnd = (start) => {
    let i = start;
    const c0 = src.charCodeAt(i);
    if (c0 === 96) { while (i < n && src.charCodeAt(i) === 96) i++; }
    else if (c0 === 126) { while (i < n && src.charCodeAt(i) === 126) i++; }
    else i++;
    const firstEnd = i;
    STOP_RE.lastIndex = i;
    const m = STOP_RE.exec(src);
    let end = m ? m.index : n;
    // email boundary: earliest start of an email-char run ending in @
    const atIdx = src.indexOf('@', start);
    if (atIdx !== -1 && atIdx < end) {
      let k = atIdx;
      while (k > 0 && isEmailCharCode(src.charCodeAt(k - 1))) k--;
      const b = k >= firstEnd ? k : firstEnd;
      if (b < end) end = b;
    }
    // www. / protocol starts inside [firstEnd, end)
    const segEnd = end;
    let w = src.indexOf('www.', firstEnd);
    while (w !== -1 && w < segEnd) {
      const prev = src[w - 1];
      if (w === 0 || prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '\f' || prev === '*' || prev === '_' || prev === '~' || prev === '(') { end = w; break; }
      w = src.indexOf('www.', w + 4);
    }
    let q = src.indexOf('://', firstEnd);
    while (q !== -1 && q < segEnd) {
      const s4 = src.slice(q - 4, q).toLowerCase();
      const s5 = src.slice(q - 5, q).toLowerCase();
      const s3 = src.slice(q - 3, q).toLowerCase();
      let st = -1;
      if (s4 === 'http') st = q - 4;
      else if (s5 === 'https') st = q - 5;
      else if (s3 === 'ftp') st = q - 3;
      if (st >= firstEnd && st < end) { end = st; break; }
      q = src.indexOf('://', q + 3);
    }
    // mailto:/xmpp: after a non-alphanumeric char ends text after that char.
    // The char must be one the lazy scan can still reach: at or after firstEnd,
    // or the run's single first character.
    for (const proto of ['mailto:', 'xmpp:']) {
      let mi = src.indexOf(proto, firstEnd);
      while (mi !== -1 && mi < end) {
        if (mi - 1 >= firstEnd || (mi - 1 === start && firstEnd === start + 1)) {
          if (mi > 0 && !isAlnumCode(src.charCodeAt(mi - 1))) {
            if (mi < end) end = mi;
            break;
          }
        }
        mi = src.indexOf(proto, mi + 1);
      }
    }
    // hard break: 2+ spaces + newline, char before the spaces not a space,
    // and only when the br regex would match there
    let sp = src.indexOf('  ', firstEnd);
    while (sp !== -1 && sp < end) {
      let rs = sp;
      while (rs > firstEnd && src.charCodeAt(rs - 1) === 32) rs--;
      if (rs > start && src.charCodeAt(rs - 1) !== 32) {
        let j = sp;
        while (j < n && src.charCodeAt(j) === 32) j++;
        if (j < n && src.charCodeAt(j) === 10 && INLINE.br.test(src.slice(rs))) { end = rs; break; }
      } else if (rs === firstEnd) {
        // the run began with spaces: text ends after the first char when the
        // rest is 2+ spaces + newline and br matches there
        if (INLINE.br.test(src.slice(firstEnd))) { end = firstEnd; break; }
      }
      sp = src.indexOf('  ', sp + 2);
    }
    return end;
  };

  while (p < n) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[p];

    // url (gfm): tried before text at every loop position, unless inside a link.
    // Cheap gate: the run must start with a plausible url/email head.
    if (!state.inLink && (ch === 'h' || ch === 'f' || ch === 'w' || ch === 'm' || ch === 'x' || isEmailCharCode(src.charCodeAt(p)))) {
      const urlTok = tryUrl(lexer, src, p);
      if (urlTok) { flushText(); out.push(urlTok.tok); p += urlTok.len; continue; }
    }

    if (ch === '\\') {
      const cap = INLINE.escape.exec(src.slice(p));
      if (cap) { flushText(); out.push({ type: 'escape', raw: cap[0], text: cap[1] }); p += cap[0].length; continue; }
      const brCap = INLINE.br.exec(src.slice(p));
      if (brCap) { flushText(); out.push({ type: 'br', raw: brCap[0] }); p += brCap[0].length; continue; }
    } else if (ch === ' ') {
      const brCap = INLINE.br.exec(src.slice(p));
      if (brCap) { flushText(); out.push({ type: 'br', raw: brCap[0] }); p += brCap[0].length; continue; }
    } else if (ch === '<') {
      const tagCap = INLINE.tag.exec(src.slice(p));
      if (tagCap) {
        flushText();
        if (!state.inLink && OTHER.startATag.test(tagCap[0])) state.inLink = true;
        else if (state.inLink && OTHER.endATag.test(tagCap[0])) state.inLink = false;
        if (!state.inRawBlock && OTHER.startPreScriptTag.test(tagCap[0])) state.inRawBlock = true;
        else if (state.inRawBlock && OTHER.endPreScriptTag.test(tagCap[0])) state.inRawBlock = false;
        out.push({ type: 'html', raw: tagCap[0], inLink: state.inLink, inRawBlock: state.inRawBlock, block: false, text: tagCap[0] });
        p += tagCap[0].length;
        continue;
      }
      const autoCap = INLINE.autolink.exec(src.slice(p));
      if (autoCap) {
        flushText();
        let text, href;
        if (autoCap[2] === '@') { text = autoCap[1]; href = 'mailto:' + text; }
        else { text = autoCap[1]; href = text; }
        out.push({ type: 'link', raw: autoCap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] });
        p += autoCap[0].length;
        continue;
      }
    } else if (ch === '[' || (ch === '!' && src[p + 1] === '[')) {
      const linkTok = tryLink(lexer, src, p);
      if (linkTok === 'BAIL') throw new Bail('link');
      if (linkTok) { flushText(); out.push(linkTok.tok); p += linkTok.len; continue; }
      const refTok = tryReflink(lexer, src, p);
      if (refTok === 'BAIL') throw new Bail('reflink');
      if (refTok) {
        if (refTok.textOnly) { appendText(refTok.textOnly); p += 1; continue; }
        flushText(); out.push(refTok.tok); p += refTok.len; continue;
      }
    } else if (ch === '`') {
      const cap = INLINE.code.exec(src.slice(p));
      if (cap) {
        flushText();
        let text = cap[2].replace(OTHER.newLineCharGlobal, ' ');
        const hasNonSpace = OTHER.nonSpaceChar.test(text);
        const hasSpaceBothEnds = OTHER.startingSpaceChar.test(text) && OTHER.endingSpaceChar.test(text);
        if (hasNonSpace && hasSpaceBothEnds) text = text.substring(1, text.length - 1);
        out.push({ type: 'codespan', raw: cap[0], text });
        p += cap[0].length;
        continue;
      }
    } else if (ch === '*') {
      const em = tryEmStrong(lexer, ctx, src, p, prevChar);
      if (em) { flushText(); out.push(em.tok); p += em.len; continue; }
    } else if (ch === '_') {
      const em = tryEmStrong(lexer, ctx, src, p, prevChar);
      if (em) { flushText(); out.push(em.tok); p += em.len; continue; }
    } else if (ch === '~') {
      const dl = tryDel(lexer, ctx, src, p, prevChar);
      if (dl) { flushText(); out.push(dl.tok); p += dl.len; continue; }
    }

    // text run
    const end = scanTextEnd(p);
    if (end === p) throw new Bail('empty-text-run');
    appendText(src.slice(p, end));
    p = end;
  }
  flushText();
  return out;
}

// Is there a url/email/www start at src[i]? (the text regex's lookaheads)
function isUrlStart(src, i) {
  const sub = src.slice(i, i + 8);
  if (sub.startsWith('www.')) {
    if (i === 0) return true;
    const prev = src[i - 1];
    return prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' || prev === '\f' || prev === '*' || prev === '_' || prev === '~' || prev === '(';
  }
  if (/^[hH][tT][tT][pP][sS]?:\/\//.test(sub) || /^[fF][tT][pP]:\/\//.test(sub)) return true;
  return false;
}

function tryUrl(lexer, src, p) {
  const cap = INLINE.url.exec(src.slice(p));
  if (!cap) return null;
  let text, href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = INLINE._backpedal.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  return { len: cap[0].length, tok: { type: 'link', raw: cap[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] } };
}

function outputLink(lexer, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(OTHER.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = lexer.state.inLink;
  const outerLinkEmitted = lexer.state.linkEmitted;
  const outerInRawBlock = lexer.state.inRawBlock;
  lexer.state.inLink = true;
  lexer.state.linkEmitted = false;
  const tokens = [];
  let textHasLink;
  try {
    fastInlineTokens(lexer, text, tokens);
    textHasLink = lexer.state.linkEmitted;
  } catch (e) {
    // A bail discards this link: restore every state bit the label scan touched,
    // so the caller's marked fallback starts from the run's entry state.
    lexer.state.linkEmitted = outerLinkEmitted;
    lexer.state.inLink = outerInLink;
    lexer.state.inRawBlock = outerInRawBlock;
    throw e;
  }
  lexer.state.linkEmitted = outerLinkEmitted;
  lexer.state.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      lexer.state.inRawBlock = outerInRawBlock;
      return null;
    }
    lexer.state.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

function tryLink(lexer, src, p) {
  if (lexer.state.linkParenPossible === false) return null;
  const cap = INLINE.link.exec(src.slice(p));
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
  const trimmedUrl = cap[2].trim();
  if (OTHER.startAngleBracket.test(trimmedUrl)) {
    if (!OTHER.endAngleBracket.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return null;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (OTHER.startAngleBracket.test(href)) href = href.slice(1, -1);
  const tok = outputLink(lexer, cap, {
    href: href ? href.replace(INLINE.anyPunctuation, '$1') : href,
    title: title ? title.replace(INLINE.anyPunctuation, '$1') : title,
  }, cap[0]);
  if (!tok) return null;
  return { len: cap[0].length, tok };
}

function tryReflink(lexer, src, p) {
  let cap;
  if ((cap = INLINE.reflink.exec(src.slice(p))) || (cap = INLINE.nolink.exec(src.slice(p)))) {
    const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
    if (isLabelEndInsideToken(src, cap[1], labelStart)) return null;
    const link = lexer.tokens.links[normalizeLabel(cap[2] || cap[1])];
    if (!link) {
      const text = cap[0].charAt(0);
      return { textOnly: text };
    }
    const tok = outputLink(lexer, cap, link, cap[0]);
    if (!tok) return null;
    return { len: cap[0].length, tok };
  }
  return null;
}

// ---- emphasis / strikethrough: faithful ports of marked's Tokenizer ----
// (Tokenizer.ts emStrong/del, Lexer.ts #maskSrc/linkInText, helpers.ts closer
// scans). They work on the run's full masked source, exactly as marked's do;
// the inner text of a span is tokenized by this file's fast pass, recursively.

function linkInText(lexer, text) {
  if (!text.includes('[')) return false;
  const linkRule = INLINE.link;
  for (const match of text.matchAll(INLINE.blockSkip)) {
    if (linkRule.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(INLINE.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(lexer.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(lexer, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code, html and escapes so emStrong and del do not see their
// delimiters inside them. Every mask keeps the length it replaces.
// A run with no '[', backtick, '<' or backslash has nothing to mask.
function maskSrc(lexer, src) {
  let maskedSrc = src;
  const needsMask = src.includes('[') || src.includes('`') || src.includes('<') || src.includes('\\');
  if (!needsMask) return maskedSrc;
  if (lexer.tokens.links && src.includes('[')) {
    const reflinkSearch = INLINE.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(lexer.tokens.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(lexer, text)) {
          return '[' + text.replace(reflinkSearch, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(reflinkSearch, maskReflink);
  }
  maskedSrc = maskedSrc.replace(INLINE.anyPunctuationOutsideCode, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });
  maskedSrc = maskedSrc.replace(INLINE.blockSkip, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });
  return maskedSrc;
}

// Closer hints for one inline pass: the last `*` / `_` run that can close
// emphasis or strong, and the last `~` run that can close strikethrough.
const closerStacks = new WeakMap();
function scanClosers(src) {
  const lastEm = { '*': -1, _: -1 };
  let lastDel = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') lastDel = i;
      else lastEm[ch] = i;
    }
    i = j - 1;
  }
  return { maskedSrc: src, lastEm, lastDel };
}
function beginCloserScan(lexer, maskedSrc) {
  const frame = scanClosers(maskedSrc);
  const stack = closerStacks.get(lexer);
  if (stack) stack.push(frame);
  else closerStacks.set(lexer, [frame]);
}
function endCloserScan(lexer) {
  const stack = closerStacks.get(lexer);
  if (!stack) return;
  stack.pop();
  if (stack.length === 0) closerStacks.delete(lexer);
}
function lastEmCloser(lexer, maskedSrc, delim) {
  const frame = closerStacks.get(lexer)?.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastEm[delim];
  return scanClosers(maskedSrc).lastEm[delim];
}
function lastDelCloser(lexer, maskedSrc) {
  const frame = closerStacks.get(lexer)?.at(-1);
  if (frame && frame.maskedSrc === maskedSrc) return frame.lastDel;
  return scanClosers(maskedSrc).lastDel;
}

// Try emphasis/strong at run position p. Returns {len, tok} or null.
function tryEmStrong(lexer, ctx, src, p, prevChar) {
  const rem = src.slice(p);
  let match = INLINE.emStrongLDelim.exec(rem);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const masked = ctx.ensureMask();
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = masked.length - rem.length;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!INLINE.punctuation.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!INLINE.punctuation.exec(prevChar);
  if (match[4] && prevChar.match(OTHER.unicodeAlphaNumeric)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? INLINE.emStrongRDelimAst : INLINE.emStrongRDelimUnd;
    const lastPossible = lastEmCloser(lexer, masked, delimChar);
    const windowStart = masked.length - rem.length + lLength;
    if (lastPossible < windowStart) return null;
    const window = masked.slice(-1 * rem.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) { delimTotal += rLength; continue; }
      else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) { midDelimTotal += rLength; continue; }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = rem.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const tokens = [];
        fastInlineTokens(lexer, text, tokens);
        return { len: raw.length, tok: { type: 'em', raw, text, tokens } };
      }
      const text = raw.slice(2, -2);
      const tokens = [];
      fastInlineTokens(lexer, text, tokens);
      return { len: raw.length, tok: { type: 'strong', raw, text, tokens } };
    }
  }
  return null;
}

// Try strikethrough at run position p. Returns {len, tok} or null.
function tryDel(lexer, ctx, src, p, prevChar) {
  const rem = src.slice(p);
  let match = INLINE.delLDelim.exec(rem);
  if (!match) return null;
  const masked = ctx.ensureMask();
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || INLINE.punctuation.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = INLINE.delRDelim;
    const lastPossible = lastDelCloser(lexer, masked);
    const windowStart = masked.length - rem.length + lLength;
    if (lastPossible < windowStart) return null;
    const window = masked.slice(-1 * rem.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(window)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { delimTotal += rLength; continue; }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = rem.slice(0, lLength + match.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      const tokens = [];
      fastInlineTokens(lexer, text, tokens);
      return { len: raw.length, tok: { type: 'del', raw, text, tokens } };
    }
  }
  return null;
}
