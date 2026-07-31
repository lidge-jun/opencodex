# 100 — Local merge stack records (codex/pr-review-260723)

Local-only stacking of merge-ready PRs. NO push, NO GitHub mutations. Sol subagent
(gpt-5.6-sol, medium) audits each cycle.

## Base refresh (pre-WP2)

- 1639af37: no-ff merge of origin/dev 02b67b03 — absorbs upstream-merged #316
  (anthropic SSE) and #317 (WHAM monthly). WP3 (#317) therefore becomes **NOOP**.

## WP2 — PR #307 display names (doc 030)

- Sol audit (agent 019f8dbc): **PASS**, 0 blockers. Merge-tree clean; no semantic
  conflict with #313/#316/#317; injection contained (JSON.stringify persistence,
  slash rejection at CLI/API); catalogModelSlug export present.
- Merge commit: **2523a6f5** (`merge: PR #307 ...`), 3 files +168/−1, zero conflicts.
- Verification: `bun run typecheck` exit 0; `bun run test` **3631 pass / 0 fail**
  (3614→3631: +17 tests from #307 + base refresh). First run's 2 fails + 2 errors were
  missing gui node_modules (react/jsx-dev-runtime) in the fresh worktree — resolved by
  `bun install` in gui/, unrelated to the merge.
- Outcome: **DONE**.

## WP3 — PR #317 (doc 090)

- Outcome: **NOOP** — already contained in origin/dev 02b67b03 absorbed at base refresh.
  Evidence: `git merge-base --is-ancestor pr-317 HEAD` → true.

## WP4 — PR #309 google wire compatibility (doc 020)

- Sol audit round 1 (agent 019f8dbc): **FAIL**, 2 blockers.
  1. **High — toolNameCodec collision non-determinism across requests**
     (google-wire-compiler.ts:21-42): salted names depend on encounter order; if a
     valid tool name equals a generated `prefix_hash8` candidate, reordering the tool
     set changes the wire name of the colliding tool. Antigravity replay keys
     signatures by provider-visible name (google-antigravity-replay.ts:39,120), so a
     reorder/subset across turns can lose the cached signature and re-create the 400.
  2. **Medium — allowlist over-applied to Vertex/AI Studio**: drops `minimum`,
     `maximum`, `additionalProperties`, `pattern` which Google documents as supported;
     the PR's "Google-documented allowlist" claim is inaccurate for non-CCA paths and
     it reverses existing test assertions (google-tool-schema.test.ts:27,80 in current
     tree). Suggested fix: provider-profiled compilation (strict sanitizer only for
     Cloud Code Assist), keep documented fields for Vertex/AI Studio.
- Synthesis (REVIEW-SYNTHESIS-01):
  - Blocker 1 accepted with scope note: common case (no collision) IS deterministic
    since hash is of the original name; failure needs an adversarial/unlucky name
    collision. Real but low-probability; still a correctness gap upstream should fix.
  - Blocker 2 accepted: substantive design regression for Vertex/direct-Gemini users;
    resolving it means restructuring the PR (provider-profiled sanitizer), which is
    author/maintainer work, not a merge-time patch we should improvise locally.
- Decision: WP4 closed as **NEEDS_HUMAN** — do not merge #309 into the local stack
  as composed. Findings should go back to the PR author (GitHub posting is out of
  scope for this local session; Jun decides whether/how to relay).
- Stack state: unchanged (last green: 2523a6f5 + devlog commits).

## WP5 — PR #279 Copilot chat completions (doc 070)

- Sol audit round 1: **FAIL**, 3 blockers.
  1. High — /v1/models switched to `requireResponsesApiAuth` drops Authorization /
     x-api-key admission on remote binds (breaks OpenAI bearer clients AND Claude
     gateway discovery via anthropic-version). Fix: keep `requireApiAuth` — /v1/models
     never forwards Authorization upstream, so the dual-bearer concern doesn't apply.
  2. Medium — docs/github-copilot-app.md remote setup self-contradictory (API-key
     field vs x-opencodex-api-key header). **Residual**: docs-only, loopback unaffected;
     recorded here as upstream feedback, not fixed locally.
  3. High — outbound.ts hand-rolled `\n\n` splitter misses CRLF framing and
     terminal-event-at-EOF → valid responses misreported as "truncated". Semantic
     conflict with the stack's shared sse-decoder (#316). Fix: use decodeServerSentEvents.
- Fixup commit 1: /v1/models back to requireApiAuth(data-plane) with comment;
  responsesSseToChatCompletionsSse rewritten onto shared decoder; CRLF/EOF regression test.
- Sol round 2: **FAIL**, 1 new blocker — cancel() hung behind idle upstream read
  (generator return waits for pending await; live probe showed upstreamCancelled:false).
- Fixup commit 2: decodeServerSentEvents gains optional { signal }; abort cancels the
  underlying reader directly; outbound cancel aborts first then closes iterator;
  idle-upstream cancellation regression test. No-signal consumers (#316 anthropic path)
  unchanged.
- Sol round 3: **PASS** — "cancellation resolves promptly, cancels upstream exactly
  once, listener cleanup safe, no-signal consumers unchanged, 27 focused tests pass."
- Merge commit **eebd4977** + 2 fixups. Verification: typecheck 0;
  `bun run test` **3651 pass / 0 fail** across 297 files (85.97s).
- Outcome: **DONE** (with residual docs feedback for upstream).

## WP6 — PR #304 kiro follow-up (doc 050)

- Sol security sub-verdict: **CLEAN** — read-only KIROCLI_DB_PATH selector; `%:token`
  constant bound parameter (no SQL injection); ambiguous/missing token selection fails
  without leaking values/keys/paths; clientIdHash constrained; diagnostics categorical;
  redaction intact (upstream-http-error.ts:6). Security files byte-identical HEAD vs
  pr-304 (credential hardening had already landed with #302 restore). privacy:scan pass.
- Sol merge verdict round 1: **FAIL** — 5 real conflicts (kiro.ts, structure/04,
  kiro-stream + 2 e2e test files). My merge-tree preflight had missed the `+`-prefixed
  markers; Sol used `merge-tree --write-tree` correctly. Lesson recorded.
- Resolution: took the PR side in all 5 regions — pr-304 merged upstream dev at
  9ca7ea32, so PR side is a superset containing our stack side. Verified: 4 code/test
  files byte-identical to pr-304 post-resolution; structure doc keeps stack Cursor
  section; kiro-stream test count 53==53.
- Merge commit **bb94ecbe**. Sol C-round verification: **PASS** ("conflict resolution
  faithfully preserves the stack while applying #304's intended completion behavior";
  test delta -1 intentional: 4 old fallback cases → 2 completion-semantics cases +
  test-runner test; #279/#316 blobs unchanged).
- Verification: typecheck 0; `bun run test` **3650 pass / 0 fail** across 298 files;
  privacy scan passed.
- Outcome: **DONE**.

## Final stack summary

| WP | PR | Outcome | Merge SHA | Tests after |
|----|----|---------|-----------|-------------|
| WP2 | #307 display names | DONE | 2523a6f5 | 3631/0 |
| WP3 | #317 WHAM monthly | NOOP (absorbed via base refresh 1639af37) | — | — |
| WP4 | #309 google wire | NEEDS_HUMAN (Sol FAIL: codec collision + Vertex allowlist overreach) | not merged | — |
| WP5 | #279 Copilot chat | DONE (+2 audited fixups) | eebd4977 | 3651/0 |
| WP6 | #304 kiro follow-up | DONE (security CLEAN; 5 conflicts resolved) | bb94ecbe | 3650/0 |

Branch: `codex/pr-review-260723` (local only — NOT pushed; GitHub untouched).
Upstream feedback owed: #309 two blockers; #279 docs contradiction (residual).

## Integration with maintainer dev (a0b9688d) — WP-INT

While our local stack was building, the maintainer advanced origin/dev to a0b9688d:
upstream merged #307, #309, #279 (as-composed, without our fixups), #303 docs,
#318 cursor continuation (9cf0abd4, 29cb2dcd), #319 fast-uri 3.1.4, and converged
v2.7.34 from main.

Reconciliation rationale (per the reasoned-mixing brief):

- **Upstream is base of truth for maintainer decisions.** #309 landed upstream despite
  our NEEDS_HUMAN audit — respected, not reverted. Our two audit blockers
  (toolNameCodec cross-request collision nondeterminism; Vertex/AI-Studio allowlist
  overreach) remain KNOWN-ISSUE feedback for upstream, recorded in WP4 above.
- **Our side carries verified improvements upstream lacks:** the two #279 fixups
  (/v1/models back to requireApiAuth — upstream merged the regression; abortable
  shared SSE decoder replacing the hand-rolled splitter with its CRLF/EOF and
  idle-cancel defects) and the #304 merge (kiro clean-text-EOF + test isolation,
  security-reviewed CLEAN; PR still open upstream).
- Merge mechanics: `git merge --no-ff origin/dev` → **ab72fc10**, zero conflicts;
  result tree d31cce0d verified byte-equal to the Sol-audited synthetic tree.
- Sol integration audit (agent 019f8ded): **PASS**, five areas, no blockers, no file
  requiring manual blending; package.json blend is the intended union (upstream
  fast-uri override + our scripts/test.ts runner), version stays 2.7.34.
- Verification: typecheck 0; `bun run test` **3676 pass / 0 fail** across 299 files;
  privacy scan passed.

## Push to origin/dev — WP-PUSH (user-approved this turn)

- Sol pre-push gate: **GO** (ancestry holds; 32 changed files match reviewed stack,
  no junk/local-state paths; no codexclaw/goalplan files in pushed tree).
- Push: `a0b9688d..3a87829f  HEAD -> dev` (fast-forward, no force). Pre-push hook ran;
  gui doctor skipped (no gui/ changes in range).
- Remote verification: `git ls-remote origin dev` == 3a87829f == local HEAD.
- Side effect: GitHub closed PR #304 (its head 9ca7ea32 is now an ancestor of dev).
- Open PRs remaining after push: #306 (held for CI + GUI approval), #325 (new, untriaged).
- Final dev tree carries: upstream a0b9688d (incl. #309 as maintainer decision) +
  local #304 merge + two #279 fixups + review/merge/integration devlog units.
