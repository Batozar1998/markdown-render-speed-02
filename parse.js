// parse.js — a faster drop-in for marked 18.1.3 (default options, GFM on).
// Fork of marked (MIT, vendor/marked/LICENSE) with hand-written fast block and
// inline tokenizers (./fastblock.js, ./fastinline.js): block lexing skips
// tokenizers whose first line cannot match and scans paragraphs by line
// instead of running the giant paragraph regex, and every inline run is
// tokenized by a char scanner instead of marked's try-every-regex loop;
// rendering still runs through marked's own Parser. Anything the fast
// tokenizers cannot prove identical is re-done by marked itself; any
// unexpected error falls back to marked.parse for the whole input. Nothing is
// cached between calls: each parse() builds fresh tokens from its input.
import { Lexer, Parser, marked } from './vendor/marked/marked.esm.js';
import { fastInlineTokens, Bail } from './fastinline.js';
import { fastBlockTokens } from './fastblock.js';

// One worker lexer/parser pair, reused across calls. All mutable state (tokens,
// links, inline queue, lexer state) is rebuilt from the input on every call, so
// no content survives from one case to the next.
const lexer = new Lexer();
const parser = new Parser();

function resetLexer() {
  lexer.tokens = [];
  lexer.tokens.links = Object.create(null);
  lexer.inlineQueue = [];
  lexer.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
  lexer.tokenizer.lexer = lexer;
}

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults. */
export function parse(markdown) {
  try {
    const src = typeof markdown === 'string' ? markdown : String(markdown);
    resetLexer();
    // Lexer.lex without its inline phase: blockTokens collects the link
    // definitions and queues the inline runs; we tokenize those ourselves.
    const norm = src.replace(/\r\n?/g, '\n');
    let tokens;
    try {
      tokens = fastBlockTokens(lexer, norm, lexer.tokens);
    } catch (e) {
      if (e instanceof Bail) {
        // The fast block tokenizer may have left partial tokens and a queued
        // inline run behind; reset and let marked's own blockTokens redo it.
        resetLexer();
        tokens = lexer.blockTokens(norm, lexer.tokens);
      } else {
        throw e;
      }
    }
    for (let i = 0; i < lexer.inlineQueue.length; i++) {
      const next = lexer.inlineQueue[i];
      // an inline <pre>, <code>, <kbd> or <script> left open ends with the block
      // holding it; carried over, it would stop every later block's text from
      // being escaped (same reset marked's lex() does)
      lexer.state.inRawBlock = false;
      // Tokenize into a scratch array: next.tokens may already hold tokens a
      // block tokenizer placed there (a task list's checkbox), which must stay
      // ahead of the inline tokens, exactly as marked's lex() appends after them.
      const tmp = [];
      // Snapshot the lexer's inline state: a bail mid-run must leave it exactly
      // as the run found it, so marked's fallback tokenizes from a clean start.
      const snap = { inLink: lexer.state.inLink, inRawBlock: lexer.state.inRawBlock, linkEmitted: lexer.state.linkEmitted, linkParenPossible: lexer.state.linkParenPossible };
      try {
        fastInlineTokens(lexer, next.src, tmp);
        for (let j = 0; j < tmp.length; j++) next.tokens.push(tmp[j]);
      } catch (e) {
        if (e instanceof Bail) {
          lexer.state.inLink = snap.inLink;
          lexer.state.inRawBlock = snap.inRawBlock;
          lexer.state.linkEmitted = snap.linkEmitted;
          lexer.state.linkParenPossible = snap.linkParenPossible;
          lexer.inlineTokens(next.src, next.tokens);
        } else {
          throw e;
        }
      }
    }
    lexer.inlineQueue = [];
    return parser.parse(tokens);
  } catch {
    return marked.parse(markdown);
  }
}
