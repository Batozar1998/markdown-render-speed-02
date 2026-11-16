// Fast block tokenizer: a drop-in for marked 18.1.3's Lexer.blockTokens that
// produces byte-identical token arrays for the inputs it accepts, and throws
// Bail for anything it cannot prove, so the caller falls back to marked's own
// blockTokens. Forked from marked (MIT, vendor/marked/LICENSE): the loop and
// the block tokenizers are marked's own methods; this file only (a) skips
// tokenizers whose first line cannot match them, and (b) replaces the giant
// paragraph regex with a line scanner that applies the same interruption rules.
// Nothing is cached between calls.
import { Bail } from './fastinline.js';

// Block tag list (CommonMark HTML block tags), as in marked's rules.
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
// Interruption tests for the paragraph scanner (single lines, no \n). These
// mirror the lookaheads in marked's paragraph regex (rules.ts), not the block
// tokenizers themselves: the paragraph's list interruption is only a bullet or
// a `1.` marker followed by whitespace AND content; the html interruption is
// the block-html start conditions (types 1-6); the hr needs the line to end
// after its dashes (`--- foo` is not an hr).
const RE_HR_LINE = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/;
const RE_ATX_LINE = /^ {0,3}#{1,6}(?:\s|$)/;
const RE_FENCE_LINE = /^ {0,3}(?:`{3,}(?=[^`]*$)|~~~)/;
const RE_BLOCKQUOTE_LINE = /^ {0,3}>/;
// A line that interrupts a paragraph as a list: a bullet, or an ordered marker
// starting from 1, followed by whitespace and non-space content.
const RE_PARA_LIST = /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/;
// The setext heading's `bull ` exclusion: a bullet (any digit) plus one
// literal space. A bullet followed by a TAB interrupts a paragraph but does
// not block a heading's text, so that case needs its own walk (see below).
const RE_LH_BULL = /^ {0,3}(?:[*+-]|\d{1,9}[.)]) /;
// The setext heading's continuation exclusions that differ from the
// paragraph's: a fence run (no backtick lookahead), an HTML line whose tag
// ends the line, a table delimiter row.
const RE_LH_FENCE = /^ {0,3}(?:`{3,}|~{3,})/;
const RE_LH_HTML = /^ {0,3}<[^>]+>$/;
const RE_LH_TABLE = /^ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*$/;
const RE_HTML_INT_LINE = new RegExp(
  `^ {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
  'i',
);
const RE_SETEXT_LINE = /^ {0,3}(?:=+|-+)[ \t]*$/;
const RE_DELIM_LINE = /^[ \t|:~-]*$/;

function leadingSpaces(line) {
  let i = 0;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  return i;
}

// Does line L (a full line, no \n) interrupt a paragraph, i.e. start a block
// the paragraph regex's lookahead excludes? `next` is the following line (or
// null) and `rest` the remaining source at L, for the table test. Returns 0
// (no interrupt), 1 (a hard interrupt — the line also blocks a setext
// heading's text, because the paragraph's pattern for it is the same as, or
// narrower than, the heading's), or 2 (the paragraph ends here but a setext
// heading's text may run on: a list line whose bullet is followed by a tab,
// an HTML line whose tag does not end the line, or a table header line — all
// cases where the paragraph's interruption pattern is broader than the
// heading's continuation exclusions, so the caller walks the heading's lines
// to find out).
function interruptsParagraph(lexer, line, next, rest) {
  const ls = leadingSpaces(line);
  if (ls > 3) return 0;
  const c = line.charCodeAt(ls);
  if (c === 35) { // #
    if (RE_ATX_LINE.test(line)) return 1;
  } else if (c === 62) { // >
    return 1;
  } else if (c === 96 || c === 126) { // ` ~
    if (RE_FENCE_LINE.test(line)) return 1;
  } else if (c === 45 || c === 95 || c === 42) { // - _ *
    if (RE_HR_LINE.test(line)) return 1;
    if (RE_PARA_LIST.test(line)) return RE_LH_BULL.test(line) ? 1 : 2;
  } else if (c === 43) { // +
    if (RE_PARA_LIST.test(line)) return RE_LH_BULL.test(line) ? 1 : 2;
  } else if (c >= 48 && c <= 57) { // digit
    if (RE_PARA_LIST.test(line)) return RE_LH_BULL.test(line) ? 1 : 2;
  } else if (c === 60) { // <
    if (RE_HTML_INT_LINE.test(line)) return 2;
  }
  // table: this line is a header and the next a delimiter row
  if (next !== null && RE_DELIM_LINE.test(next) && next.includes('-')) {
    if (lexer.tokenizer.rules.block.table.test(rest)) return 2;
  }
  return 0;
}

// Does line L block a setext heading's text (the heading continuation
// lookahead in rules.ts)? Blank lines are checked by the caller.
function lheadingExcluded(line) {
  return RE_LH_BULL.test(line)
    || RE_LH_FENCE.test(line)
    || RE_BLOCKQUOTE_LINE.test(line)
    || RE_ATX_LINE.test(line)
    || RE_HR_LINE.test(line)
    || RE_LH_HTML.test(line)
    || RE_LH_TABLE.test(line);
}

// Walk the lines from `start` (the start of a line in `src`) as a setext
// heading's text, for the case where the paragraph already ended on a line
// the heading's text still accepts. Returns the setext underline line when
// one is found before any blocking line, else null.
function findSetextAfter(src, start) {
  let pos = start;
  while (pos < src.length) {
    const nl = src.indexOf('\n', pos);
    const line = nl === -1 ? src.slice(pos) : src.slice(pos, nl);
    if (line.trim() === '') return null;
    if (RE_SETEXT_LINE.test(line)) return line;
    if (lheadingExcluded(line)) return null;
    if (nl === -1) return null;
    pos = nl + 1;
  }
  return null;
}

// Scan a paragraph starting at the beginning of `src`. Returns {raw, text,
// setext, setextHr} or null when marked's paragraph regex would not match
// here. Mirrors the regex: lines joined until a blank line or an interrupting
// line; the raw holds the lines without a trailing newline. `setext` is true
// when the paragraph's lines are followed by a setext underline (the line
// right after them, or further on past a line the heading's text still
// accepts): marked's lheading, tried before the paragraph, takes the whole
// thing as a heading instead, so the caller calls lheading() and bails if it
// fails — except when the underline is `---`, which ends a paragraph as an hr
// anyway (`setextHr`), so the scanned paragraph is correct on its own.
function scanParagraph(lexer, src) {
  const nl0 = src.indexOf('\n');
  const first = nl0 === -1 ? src : src.slice(0, nl0);
  if (first.length === 0) return null;
  let end = first.length; // end index (exclusive) of the paragraph raw
  let pos = end;
  let setext = false;
  let setextHr = false;
  while (pos < src.length) {
    // src[pos] is '\n'; the next line starts at pos+1
    const ls = pos + 1;
    const nl = src.indexOf('\n', ls);
    const line = nl === -1 ? src.slice(ls) : src.slice(ls, nl);
    if (line.trim() === '') break; // blank line ends the paragraph
    if (RE_SETEXT_LINE.test(line)) { setext = true; setextHr = RE_HR_LINE.test(line); break; }
    // the line after this one, for the table test
    let next = null;
    if (nl !== -1) {
      const nextStart = nl + 1;
      const nl2 = src.indexOf('\n', nextStart);
      next = nl2 === -1 ? src.slice(nextStart) : src.slice(nextStart, nl2);
    }
    const code = interruptsParagraph(lexer, line, next, src.slice(ls));
    if (code === 1) break;
    if (code === 2) {
      // The paragraph ends here, but a setext heading's text may run on.
      const underline = findSetextAfter(src, ls);
      if (underline !== null) { setext = true; setextHr = RE_HR_LINE.test(underline); }
      break;
    }
    end = nl === -1 ? src.length : nl;
    pos = end;
  }
  const raw = src.slice(0, end);
  return { raw, text: raw, setext, setextHr };
}

// Port of Lexer.blockTokens (marked 18.1.3), with the attempt skipping and the
// fast paragraph scanner above. `tokens` is the array to fill (a TokensList at
// the top level, a plain array for nested calls).
export function fastBlockTokens(lexer, src, tokens, lastParagraphClipped = false) {
  const tokenizer = lexer.tokenizer;
  const rules = tokenizer.rules;
  if (lexer.options.pedantic) {
    src = src.replace(rules.other.tabCharGlobal, '    ').replace(rules.other.spaceLine, '');
  }
  let srcLength = Infinity;
  while (src) {
    if (src.length < srcLength) {
      srcLength = src.length;
    } else {
      throw new Bail('infinite-loop');
    }
    // Classify the first line once: leading spaces and first significant char.
    const nl = src.indexOf('\n');
    const firstLine = nl === -1 ? src : src.slice(0, nl);
    const ls = leadingSpaces(firstLine);
    const fc = ls < firstLine.length ? firstLine.charCodeAt(ls) : -1;
    const isBlank = firstLine.trim() === '';

    let token;

    // newline
    if ((token = tokenizer.space(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) {
        lastToken.raw += '\n';
      } else {
        tokens.push(token);
      }
      continue;
    }

    // code (indented): line starts with 4 spaces or a tab within 3 spaces
    const indented = !isBlank && (ls >= 4 || (ls < 4 && firstLine.charCodeAt(ls) === 9));
    if (indented && (token = tokenizer.code(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        lexer.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    // fences
    if (ls <= 3 && (fc === 96 || fc === 126) && (token = tokenizer.fences(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // heading
    if (ls <= 3 && fc === 35 && (token = tokenizer.heading(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // hr
    if (ls <= 3 && (fc === 45 || fc === 95 || fc === 42) && (token = tokenizer.hr(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // blockquote
    if (ls <= 3 && fc === 62 && (token = tokenizer.blockquote(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // list
    if (ls <= 3 && (fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) && (token = tokenizer.list(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // html
    if (ls <= 3 && fc === 60 && (token = tokenizer.html(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // def
    if (ls <= 3 && fc === 91 && (token = tokenizer.def(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        lexer.inlineQueue.at(-1).src = lastToken.text;
      } else {
        if (!lexer.tokens.links[token.tag]) {
          lexer.tokens.links[token.tag] = { href: token.href, title: token.title };
        }
        tokens.push(token);
      }
      continue;
    }

    // table (gfm): only when the second line looks like a delimiter row
    let secondLine = null;
    if (nl !== -1) {
      const nl2 = src.indexOf('\n', nl + 1);
      secondLine = nl2 === -1 ? src.slice(nl + 1) : src.slice(nl + 1, nl2);
    }
    if (secondLine !== null && RE_DELIM_LINE.test(secondLine) && secondLine.includes('-') && (token = tokenizer.table(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // lheading: only when the second line is a setext underline
    if (secondLine !== null && RE_SETEXT_LINE.test(secondLine) && (token = tokenizer.lheading(src))) {
      src = src.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // top-level paragraph (fast scanner)
    if (lexer.state.top) {
      const scanned = scanParagraph(lexer, src);
      if (scanned) {
        if (scanned.setext) {
          const lh = tokenizer.lheading(src);
          if (lh) {
            src = src.substring(lh.raw.length);
            tokens.push(lh);
            continue;
          }
          // lheading() failed: the paragraph's lines were not valid heading
          // text. A `---` underline still ends the paragraph as an hr, so
          // the scanned paragraph is correct; any other underline would be
          // paragraph text, so fall back to marked for the whole document.
          if (!scanned.setextHr) throw new Bail('lheading-mismatch');
        }
        const text = scanned.text.charAt(scanned.text.length - 1) === '\n' ? scanned.text.slice(0, -1) : scanned.text;
        token = { type: 'paragraph', raw: scanned.raw, text, tokens: lexer.inline(text) };
        const lastToken = tokens.at(-1);
        if (lastParagraphClipped && lastToken?.type === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          lexer.inlineQueue.pop();
          lexer.inlineQueue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        lastParagraphClipped = false;
        src = src.substring(token.raw.length);
        continue;
      }
    }

    // text
    if ((token = tokenizer.text(src))) {
      src = src.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        lexer.inlineQueue.pop();
        lexer.inlineQueue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    if (src) throw new Bail('infinite-loop');
  }

  lexer.state.top = true;
  return tokens;
}
