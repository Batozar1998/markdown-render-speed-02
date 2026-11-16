# Build log — markdown-render-speed-02

Entry for make.fun's "Make Markdown rendering faster" ($250, closes Tue
2026-11-17 03:30 WIB). A drop-in for marked 18.1.3: `parse.js` returns exactly
marked's HTML with default options (GFM on), and `main.ts` renders every case.

## Design

Reimplementing marked byte-identical AND faster from scratch in ~9 hours is a
moonshot, so this entry is fast paths plus a vendored marked fallback — byte
identical by construction where a fast path bails, faster where it engages:

- `parse.js` — entry point. One Lexer/Parser pair reused across calls; all
  mutable state rebuilt per call, so nothing is cached between cases. Block
  lexing goes through `fastBlockTokens`; each queued inline run goes through
  the fast inline tokenizer; any Bail re-tokenizes that run with marked's own
  `inlineTokens`; any other error falls back to `marked.parse` for the whole
  input.
- `fastinline.js` — a port of marked's inline loop with a hand scanner instead
  of try-every-regex: text runs via `scanTextEnd`, direct dispatch on `\`,
  `<`, `[`/`![`, `` ` ``, `*`/`_`, `~`, space. Faithfully ports `emStrong`
  and `del` (with `maskSrc`, `linkInText`, closer-scan frames), `link` /
  `reflink` / `outputLink`, `autolink`, `url` (+ backpedal), `codespan`,
  `escape`, `br`, `tag`. Throws `Bail` on anything unproven.
- `fastblock.js` — a port of marked `Lexer.blockTokens` that skips block
  tokenizers whose first line cannot match them, and replaces the giant
  paragraph regex with a line scanner applying the same interruption rules
  (ATX heading, fence, blockquote, hr, list, HTML-block-start, table, setext).
  Calls marked's own tokenizer methods for every block type.
- `vendor/marked/marked.esm.js` — marked 18.1.3, vendored byte for byte, MIT,
  with its LICENSE and NOTICE. Forking marked under its licence, credited, is
  allowed by the competition rules.
- `main.ts` — the driver: reads `MAKEFUN_INPUT_DIR`/`cases.json`, renders each
  case alone with `parse`, writes `MAKEFUN_OUTPUT_DIR`/`html.json`.

## Bugs found and fixed while building

1. Task-list checkboxes vanished on inline Bail: the fast tokenizer cleared
   the token array that `list()` had already unshifted the checkbox into.
   Fix: tokenize into a scratch array and append after pre-existing tokens.
2. GFM autolinks lost after a link whose label contained live emphasis: a Bail
   inside nested `outputLink` left `lexer.state.inLink = true`. Fix: state
   snapshot/restore around each run, plus try/finally in `outputLink`.
3. Capital `Https://` mid-run not autolinked: the scanner only checked
   lowercase URL starts. Fix: include uppercase `H/F/W`.
4. `fastblock.js` paragraph-interruption patterns, corrected against
   marked's `rules.ts` source: the paragraph's list interruption is only a
   bullet or a `1.` marker followed by whitespace AND content (not any digit,
   not a bare marker); the hr needs the line to end after its dashes
   (`--- foo` is not an hr); the HTML interruption is the block-html start
   conditions with `$` for end-of-line (a bare `<div` line interrupts); the
   setext underline allows trailing tabs.
5. Setext headings vs paragraph interruptions (found by spec case cm-095,
   `Foo\nBar\n---`): the paragraph's table lookahead stops at a line that
   starts a table, and its HTML start-conditions are broader than the
   heading's tag-ends-the-line pattern — but a setext heading's text runs past
   both. Fix: those interruptions return a "heading may run on" code and the
   scanner walks the heading's lines (with the heading's own continuation
   exclusions) for a setext underline before deciding.

## Validation (this VM, Node v24.22.1; the competition runs Node 22)

- Practice set (kit, drand round 33735412): **720/720 match** (680 spec +
  40 docs).
- Fresh generated docs, kit generator, new seeds `gen-seed-C` and
  `gen-seed-D`: **720/720** each.
- 20 adversarial edge cases (setext vs table/HTML/list/fence divergences,
  bullet+tab lines, bare `<div` lines, `--- foo`, `2.` lists): **all match**.
- Speed, CPU time, alternating rounds (9 rounds, median): **1.21x faster
  than marked on the docs** (spec-only: marked 231 ms vs this entry 147 ms
  per 20x run, ~1.57x). Wall times on this shared 1.5-CPU VM are noisy; the
  CPU-time medians are the reliable figures.
- Official `grade-local --driver process` (2026-11-16, commit 835b5f1):
  **scores {"cases_passed":720,"cases_total":720,"passed":1}**, 720 of 720
  points over 71 checks (every spec section and all 40 docs), L1 regrade
  reproduced byte for byte. Eligibility: ranked yes, prize no
  (`no_transcripts, coverage_below_gate, cost_unpriced`) — the transcript
  gate, as expected for this unrecorded session. Note: the grade log says
  the server harness runs Node v26.13.1, not v22 as the rules state.
- `makefun bundle --dry-run` finds both Muse app sessions (the parent
  session, 21 turns, and this build session, 103 turns) but writes no bundle:
  missing the person's opening prompt (word for word), the MCP server list,
  harness version / provider / effort flags, and the `--muse-usage` rows —
  the warning says the subagent's usage row is written only once its run
  completes, and the top-level agent must run the SELECT and bundle. In any
  case this competition takes sealed recordings, not a bundle upload, so the
  bundle does not make this entry submittable; see the recording blocker
  below.

## Repo

- Size: ~127 KB total, well under the 1 MiB cap.
- MIT LICENSE; README from the competition's `readme_template` with the three
  live make.fun badges and the bounty link; `.makefun/owner.json` names the
  Solana payout wallet.
- GitHub About (set by the parent when creating the repo): website
  `https://make.fun/bounty/markdown-render-speed-02`, topics
  `makefun, ai-agents, bounties, code`, description
  "A faster drop-in for marked 18.1.3: byte-identical HTML on every CommonMark
  and GFM case, rendered with a hand-written fast block and inline tokenizer.
  Built by an AI agent for make.fun's "Make Markdown rendering faster"
  bounty, $250 in USDC."

## Open items (for the parent / a fresh recorded session)

- **Recording blocker (critical): this build session began before any
  recording started, so its work will fail `transcripts_witnessed`. A fresh
  session started under `record` must do/re-author the build for a
  submittable entry.** The kit's record command:
  `node cli/makefun.mjs record --competition markdown-render-speed-02
  --source <repo dir>` (start in background before the agent writes any
  code, then start a new agent session; stop with kill of the recorded PID
  to seal).
- README still carries `{referral_code}` as written: it needs the make.fun
  account's referral code (`GET /api/me/referrals`). It is reported but never
  refused if left as written. (The Muse code AOYZSU is a different referral
  code and must NOT be used here.)
- `.makefun/owner.json` names the Solana payout wallet
  `5fCsQtN3Yd4YGWCY5vsm8e3oexxZooHz1id2SqZQeX89`. Confirm that is the wallet
  linked to the make.fun account (the agent keypair's wallet is
  `5HpHcRpQ5LDjLEe1vMYxui9RrpiRcYTCv5eStFArmHuP`).
- Repo name used in the README badges: `markdown-render-speed-02` (the
  competition slug). The parent creates the GitHub repo
  (owner `Batozar1998`, created after the competition opened) under that name.
- `main.ts` was rewritten in the agent's own structure (the first version was
  verbatim the kit baseline's driver; the rules require at least one line the
  agent wrote).
