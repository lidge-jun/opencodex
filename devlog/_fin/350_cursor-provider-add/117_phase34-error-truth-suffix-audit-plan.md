# 350.117 — Error-Message Truth + Reasoning-Suffix Consolidation + Test Evidence (work-phase 34)

Date: 2026-06-27
Branch: dev
Work phase: close finding **#3 (High, false safety claim)**, harden finding **#7 (Medium-high, suffix
not per-model)** — note: #7 is **largely already fixed** by `108`/`effort-map.ts`; this phase closes the
residual drift gaps — and close finding **#10 (test evidence mismatch)**.

> Status: **PLAN**. C2/C3-class. Three related-but-small concerns grouped to avoid micro-phases.

---

## 1. Easy explanation

Three loose ends:
1. **The error message lies.** When a Cursor transport error happens, opencodex always appends
   "No Cursor native file/shell/MCP/fetch/screen/computer-use command was executed" — even though a
   native exec may have already run earlier in the same turn. After `111` adds a deny gate it's still a
   per-turn fact, so the message must reflect what *actually* happened.
2. **Reasoning suffix is now per-model (good) but has two sources of truth.** `108` made
   `effort-map.ts` table-driven, but `discovery.ts` separately declares `supportsReasoningEffort`, and
   they can drift. Consolidate + cover the edge cases (already-suffixed passthrough, `xhigh`, non-effort
   models, `reasoning:none`).
3. **The review package's tests didn't match the devlog.** Make the test suite self-contained and the
   claimed test files actually present.

## 2. Pre-write evidence

### #3 — always-false safety sentence
```32:48:src/adapters/cursor.ts
function safeCursorTransportError(err: unknown): string {
  …
  const cause = sanitizeCursorTransportCause(err);
  if (cause) {
    return [`Cursor transport failed before completion (${cause}).`,
      "No Cursor native file, shell, MCP, fetch, screen, or computer-use command was executed."].join(" ");
  }
  return ["Cursor transport failed before completion.",
    "No Cursor native file, shell, MCP, fetch, screen, or computer-use command was executed."].join(" ");
}
```
- The sentence is **unconditional**. But `live-transport.ts:199-202` can execute
  `handleCursorNativeExec` before a later transport error → the claim can be false. (Review #3.)
- jawcode has no equivalent unconditional safety sentence (it returns typed rejections instead), so this
  is opencodex-specific text that must become conditional.

### #7 — per-model already done by 108, residual gaps
```57:68:src/adapters/cursor/effort-map.ts
export function cursorEffortSuffix(baseModelId: string, reasoning: string | undefined): string | undefined {
  const tiers = CURSOR_MODEL_EFFORT_TIERS[baseModelId];
  if (!tiers || tiers.length === 0) return undefined;
  …clamps low→tiers[0], high→tiers[top], medium→middle…
}
```
- This is the table-driven per-model mapping the review asked for — **#7's core is fixed** (commits
  `e0d6312`→`c637f4d`→`15c90dc`, devlog `107`/`108`). Residual gaps:
  - `request-builder.ts:17-21` `normalizeCursorModelId` is **not exported** (review asks to export for
    tests).
  - Two sources of truth: `effort-map.ts CURSOR_MODEL_EFFORT_TIERS` vs `discovery.ts`
    `supportsReasoningEffort` / `cursorModelReasoningEfforts` (`discovery.ts:116-125`). They can drift.
  - Already-suffixed passthrough (`claude-4.6-opus-max`) — `effort-map` keys are *base* ids, so a fully
    suffixed id has no table entry and is sent bare (correct by accident); needs an explicit
    "already terminal suffix → passthrough" guard + test (review: `foo-high-quality` must NOT be treated
    as already-suffixed).
  - `-thinking`/`-fast` variant bases aren't in the table (noted as a `108` limitation).

### #10 — test evidence
- Review noted `cursor-blob.test.ts` / `cursor-effort-suffix.test.ts` referenced by devlog but absent
  from the review zip, and the zip wasn't self-contained (`package.json`/`tsconfig`/bun missing). Make
  the review package reproducible.

## 3. Decision

1. Thread a per-turn native-exec audit from `111` into the adapter; make the safety sentence conditional.
2. Consolidate effort metadata onto `effort-map.ts` as the single source; have `discovery.ts` derive
   `supportsReasoningEffort`/`cursorModelReasoningEfforts` from it. Export `normalizeCursorModelId` and
   add explicit already-suffixed passthrough.
3. Verify the named test files exist; add a self-contained review-package note.

## 4. Diff-level plan

### MODIFY `src/adapters/cursor.ts` (#3)
- Accept a per-turn audit (set by the live transport / `111`'s `handleCursorNativeExec`): which exec
  cases were **requested** and whether each was `executed` or `denied`.
- `safeCursorTransportError(err, audit)`:
  - `audit.requested.length === 0` → keep "No Cursor native … command was executed." (now truthful).
  - otherwise → "Cursor transport failed before completion (${cause}). Before the failure, Cursor
    requested native exec: ${cases}; ${executedCount} executed, ${deniedCount} denied." with redacted
    case names only (no args). Keep `sanitizeCursorTransportCause` redaction.

### MODIFY `src/adapters/cursor/effort-map.ts` + `discovery.ts` (#7 residual)
- Export from `effort-map.ts`: `cursorModelEffortTiers()` (the table) so `discovery.ts` derives
  `supportsReasoningEffort = cursorModelHasEffortTiers(id)` and
  `cursorModelReasoningEfforts()` from the same table (remove the separate `CURSOR_REASONING_EFFORTS`
  duplication, or make it the fallback only).
- `request-builder.ts`: `export function normalizeCursorModelId(...)`; add
  `alreadyHasTerminalEffortSuffix(id)` (final token ∈ {low,medium,high,max,xhigh}) → passthrough; ensure
  `foo-high-quality` is NOT considered suffixed (final token is `quality`).

### Tests (#10)
- Ensure `tests/cursor-effort-suffix.test.ts` and `tests/cursor-blob.test.ts` (or the `114`
  `cursor-conversation-store.test.ts`) exist and are committed (not git-ignored).
- When building the next review package, include `package.json` + `tsconfig.json` + `tests/` so
  `bun test` / `bun x tsc --noEmit` reproduce. (Tooling note, not a source change.)

## 5. Verification plan (non-destructive)
- NEW/extend `tests/cursor-adapter-error.test.ts`:
  - error with empty audit → message says no native command executed.
  - error with audit `{requested:["readArgs","shellArgs"], executed:1, denied:1}` → message names the
    cases + counts, and is redacted (no `Bearer`, no args).
- extend `tests/cursor-effort-suffix.test.ts`:
  - bare reasoning model + `high` → top tier; + `none`/absent → deterministic default.
  - already-suffixed (`claude-4.6-opus-max`) passthrough; `foo-high-quality` still gets a suffix if it
    were a reasoning base (assert it is NOT treated as already-suffixed).
  - non-reasoning (`composer-2.5`, `auto`, `grok-*`, `gemini-*`) → bare.
  - `xhigh`-capable model preserves `xhigh`; non-`xhigh` model clamps down deterministically.
  - `discovery.ts supportsReasoningEffort` matches `effort-map` for every static id (drift guard).
- `bun test tests/cursor-*.test.ts` → green; `bun x tsc --noEmit` → exit 0.

## 6. Out of scope
- `-thinking`/`-fast` variant tiers — separate small follow-up (pass fully-qualified id meanwhile).

## 7. Cross-references
- GPT Pro review 260627 — findings **#3 (High)**, **#7 (Medium-high)**, **#10 (Medium)**.
- `107`/`108` (suffix work this consolidates) · `111` (native-exec audit source) · `118` (index).
