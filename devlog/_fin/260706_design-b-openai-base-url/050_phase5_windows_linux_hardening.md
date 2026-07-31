# Phase 5 — Windows/Linux platform hardening (steady-state lock avoidance + CRLF)

- **Date:** 2026-07-06 · **Branch:** dev-B · **Class:** C3 (shared behavior on every start/stop, cross-platform)
- **Loop archetype:** spec-satisfaction repair (verifier defines done: targeted tests + full `bun test` + tsc)
- **Trigger:** Design B (phases 1-4) removed the re-tag failure class, but the
  steady-state paths still WRITE-open `state_5.sqlite` on every `ocx start` and
  `ocx stop` even when there is nothing to migrate. On Windows the Codex app holds
  the DB (WAL, busy_timeout 5s); each write open can stall up to ~10.5s
  (2 attempts x 5s busy + 500ms delay) AND surface a false
  "migration deferred / history could NOT be restored" warning although zero rows
  are pending. WAL allows concurrent READERS, so a readonly probe succeeds where
  the write open blocks.
- **Goal:** post-migration steady state never write-opens the history DB and never
  warns; locked-with-pending-work behavior is unchanged (write attempt + guardian
  retry). Injected TOML lines match the file's dominant line ending (CRLF configs
  stay CRLF, no mixed-EOL files on Windows).
- **Non-goals:** no change to the migration/eject SQL, no change to the guardian
  cadence, no change to legacy (non-loopback) forward-tag sync, no push/deploy,
  no proxy restart on this machine.
- **Verifier:** new targeted tests (steady-state skip, locked-probe fallthrough,
  CRLF round-trip) + existing suites green + `bun x tsc --noEmit`.
- **Stop condition:** C passes full suite; D records evidence.
- **HOTL bounds:** write scope = this repo only (src/, tests/, devlog/). No pushes,
  no global installs, no edits to ~/.opencodex or ~/.codex live configs, do not
  kill the running proxy (port 10100). Budget: current session tokens; hitting it
  = BUDGET_EXHAUSTED with best-so-far.
- **Escalation:** if the readonly probe turns out to block on a real Windows WAL
  handle (contradicting WAL reader semantics), drop item 1 and report NEEDS_HUMAN.

## Verified facts (fresh, this cycle)

1. `migrateHistoryToOpenai()` (codex-history-provider.ts:539) is called from
   `injectCodexConfig` (codex-inject.ts:396) on EVERY loopback start/sync. It goes
   straight to `withHistoryRetry(syncCodexHistoryProviderUnsafe("openai"))` — a
   write `openStateDb` (busy_timeout 5000) with 2 attempts/500ms, even when
   pending=0 and backup=0.
2. `restoreNativeCodex()` (codex-inject.ts:524) runs on every `ocx stop`/shutdown
   and calls `syncCodexHistoryProvider("openai")` — same write open; on failure it
   prints "routed threads stay hidden", which is FALSE under Design B steady state
   (threads are already tagged openai; nothing is hidden).
3. `countPendingOpencodexHistory` (codex-history-provider.ts:564) is a readonly
   probe (busy_timeout 100ms) whose pending predicate mirrors
   `ejectRemainingOpencodexHistory` exactly, and it counts backup manifest entries.
   `{pendingRows:0, backupEntries:0, failed:undefined}` proves the openai-direction
   restore would be a no-op. The guardian already uses it as a gate; inject/stop
   do not.
4. CRLF repro (bun probe, 2026-07-06): `setRootOpenaiBaseUrl` on a CRLF config
   inserts `\n`-terminated marker+key lines -> mixed-EOL file. Parsing still works
   (strip/idempotent re-inject verified in the same probe) — this is polish, not
   correctness; codex-rs's toml crate accepts both endings.

## Diff-level plan

## Audit fixes folded in (gpt-5.5 reviewer, 2026-07-06)

- **(major 1) CRLF scope was too narrow.** Every transform in the inject pipeline
  rebuilds content with hard `"\n"` (stripExistingModelProvider, ensureFastModeFeature,
  removeOcxSection, setRootModelCatalogPath, ...), and `setRootOpenaiBaseUrl`'s
  idempotent rewrite (`lines[i] = key`) would LF-terminate one line of a CRLF file.
  Fix adopted: EOL normalization at the BOUNDARY instead of per-transform surgery —
  record `dominantEol(original)` once, normalize to LF before the transform pipeline,
  convert back to the recorded EOL right before `atomicWriteFile`. All transforms
  stay LF-pure. `removeCodexConfig` gets the same wrap; byte-level EOL
  uniformization only happens when a transform actually changed something (the
  unchanged-content fast path compares in LF space and skips the write).
- **(major 2) No silent semantic change to the exported restore API.**
  `syncCodexHistoryProvider("openai")` keeps today's default write-open behavior.
  The steady-state gate is opt-in: a new `opts.skipWhenProvablyNoop` flag, passed
  ONLY by `restoreNativeCodex` when the loaded config is loopback (Design B mode,
  `!shouldInjectApiAuthHeader(config)`). Legacy (non-loopback) stop/restore paths
  are byte-for-byte unchanged. TOCTOU note: under Design B no writer produces
  `opencodex` rows anymore (the proxy stopped re-tagging), so probe-then-skip
  cannot lose a concurrent row; in legacy mode the flag is never set.
  `migrateHistoryToOpenai` gets the gate built in — it is Design-B-specific by
  contract (inject/guardian callers only) and the guardian's re-count protection
  (history-migration-guardian.ts:75-80) is preserved because backupEntries>0 or
  probe-failed still falls through to the write attempt.
- **(minor 3) Wording fixed:** a missing DB returns `{ pendingRows: 0, backupEntries }`
  — backup entries are still counted (codex-history-provider.ts:564-571), so a fresh
  reinstall with a leftover backup manifest does NOT satisfy `openaiRestoreIsNoop`.
  Test added for exactly that case.
- recover-history / restoreLegacyOpenaiHistory verified unaffected (own eject path,
  cli.ts:389-395). No existing test expects migrateHistoryToOpenai to write-open on
  a steady-state fixture.

### 1. MODIFY `src/codex-history-provider.ts` — readonly steady-state gate

Add a tiny helper and use it in the two openai-direction entry points:

```ts
/** True when a readonly probe PROVES the openai-direction restore would be a no-op. */
function openaiRestoreIsNoop(stateDbPath: string, backupPath: string): boolean {
  const pending = countPendingOpencodexHistory(stateDbPath, backupPath);
  return !pending.failed && pending.pendingRows === 0 && pending.backupEntries === 0;
}
```

- `migrateHistoryToOpenai(...)`: after the `existsSync` early-return, insert
  `if (openaiRestoreIsNoop(stateDbPath, backupPath)) return { rows: 0, files: 0 };`
- `syncCodexHistoryProvider(provider, stateDbPath?, backupPath?, opts?)`: new
  optional `opts: { skipWhenProvablyNoop?: boolean }`. Only when the flag is set,
  provider is "openai", AND the DB exists, apply the gate before `withHistoryRetry`.
  Default behavior (no flag) is unchanged. The opencodex (forward) direction never
  gates.
- Probe-failed (`failed: true`) falls through to today's write attempt — locked DBs
  with unknown state keep the current behavior and warnings.
- Missing DB: `countPendingOpencodexHistory` still counts backup entries, so
  leftover-manifest reinstalls do not skip; ordering after the existsSync guard
  keeps the missing-DB early return identical to today.

### 2. MODIFY `src/codex-inject.ts` — line-ending-preserving injection

- NEW helpers (exported for tests):
  `dominantEol(content): "\r\n" | "\n"` — CRLF when CRLF sequences are at least as
  common as bare LFs (and at least one exists);
  `applyEol(content, eol)` — normalize every `\r\n` to `\n`, then expand to the
  target EOL.
- `injectCodexConfig`: `const eol = dominantEol(raw)`; run the whole transform
  pipeline on `applyEol(raw, "\n")`; write `applyEol(result, eol)`; journal the
  exact written bytes (markJournalInjectedState receives the final form).
- `removeCodexConfig`: same boundary wrap; the "no change" fast path compares in LF
  space so an untouched file is never rewritten just to normalize EOLs.
- Individual transforms stay LF-pure — no per-function `\r` handling needed. This
  also covers the legacy branch (setRootModelProvider + provider table append) for
  free, closing the reviewer's out-of-scope objection.

### 3. MODIFY `src/codex-inject.ts` — honest stop message (rides the gate)

No text change needed: with the gate, steady-state stop returns `{rows:0, files:0}`
(not failed), so the misleading "routed threads stay hidden" warning simply stops
firing when nothing is pending. Locked+pending keeps the warning — still true then.

## Tests

`tests/codex-history-provider.test.ts`:
- `migrateHistoryToOpenai` steady state (openai-tagged rows, no backup): returns
  `{rows:0,files:0}`, rollout files byte-unchanged.
- Pending fixture still migrates through the gate (fallthrough proof).
- Missing DB + leftover backup manifest does NOT satisfy the noop gate
  (`countPendingOpencodexHistory` reports backupEntries>0).
- `syncCodexHistoryProvider("openai", ..., { skipWhenProvablyNoop: true })`:
  steady state returns zeros without rewriting rollouts; with pending opencodex
  rows it still restores; WITHOUT the flag behavior is unchanged (existing tests
  already cover the default path).

`tests/codex-inject.test.ts` (pure helpers) + `tests/codex-inject-integration.test.ts`:
- `dominantEol`/`applyEol` unit cases (LF-only, CRLF-only, mixed-majority).
- Integration: CRLF config -> injectCodexConfig -> file is uniformly CRLF (zero bare
  LFs), contains the injected base_url; re-inject idempotent; removeCodexConfig
  strips routing and stays CRLF.
- LF config regression: output contains no `\r`.

## Accept

- Targeted tests + full `bun test` green, `bun x tsc --noEmit` clean.
- rg proof: inject/stop steady-state call paths reach the gate (migrateHistoryToOpenai
  built-in; restoreNativeCodex passes skipWhenProvablyNoop only under loopback).
- Legacy (non-loopback) restore semantics byte-for-byte unchanged.

## D — closeout (2026-07-06)

**Outcome: DONE.**

Shipped (dev-B, uncommitted at review time, committed with this doc):
- `src/codex-history-provider.ts`: `openaiRestoreIsNoop` readonly gate — built into
  `migrateHistoryToOpenai` (Design-B-specific), opt-in `skipWhenProvablyNoop` on
  `syncCodexHistoryProvider` (default semantics unchanged).
- `src/codex-inject.ts`: `dominantEol`/`applyEol` boundary EOL normalization wrapped
  around the inject + remove transform pipelines; `restoreNativeCodex` passes the
  noop-skip flag only when the loaded config is loopback (legacy non-loopback
  unchanged, config-load throw contained).
- Tests: +9 (steady-state byte-identity, pending fallthrough, reinstall-manifest
  guard, flagged sync skip/restore, dominantEol/applyEol units, CRLF + LF
  integration round-trips).

Evidence: full `bun test` 1473 pass / 0 fail; `bun x tsc --noEmit` clean; privacy
scan pass; `git diff --check` clean. Independent gpt-5.5 reviews: A-gate
FAIL-with-fixes (all folded — boundary EOL, opt-in flag, manifest wording),
C-gate PASS (one low test-wording note, folded).

What did NOT change / dead hypotheses (LOOP-PESSIMIST-01):
- Per-transform CRLF surgery was the wrong shape — boundary normalization made every
  transform EOL-correct at once, including the legacy branch the first plan draft
  had scoped out.
- Lone `\r` (old-Mac endings) are intentionally left alone; converting them would
  risk touching CR bytes that are illegal in TOML anyway.
- The steady-state test proves main-DB byte identity, not WAL/SHM sidecar silence;
  the no-write guarantee is structural (gate returns before any writer opens).
- Evidence that would falsify this direction: a Windows report where the READONLY
  probe itself blocks on the app's WAL handle — escalation stays as written in the
  plan header (drop item 1, NEEDS_HUMAN).
