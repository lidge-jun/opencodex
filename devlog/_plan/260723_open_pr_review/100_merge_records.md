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
