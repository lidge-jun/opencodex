# 020 — Phase 2: PR 136 + 137 integration onto dev

## Merge order and rationale

1. `git merge --no-ff origin/pr/136` — small server fix first (2 files).
2. Hardening follow-up commit (NEW, ours) — timer-leak fix, see diff below.
3. `git merge --no-ff origin/pr/137` — large gui i18n change last (30+ files).
4. Push dev.

`--no-ff` keeps each PR's head SHA in dev's ancestry, so when dev reaches `main`
(WP4) GitHub auto-marks #136/#137 as MERGED with original author credit. Both
merge-trees against dev verified conflict-free (000_plan snapshot).

## Hardening follow-up (MODIFY src/server/claude-messages.ts) — audited shape

PR 136 calls `headerDeadline.clear()` only after a successful `fetch`. On the reject
path (catch block) the deadline timer keeps running until expiry — timer leak +
spurious `didExpire()` ambiguity. Audit verified `clear()` is idempotent
(`src/lib/abort.ts:39-42`) and `didExpire()` stays true after `clear()`
(`src/lib/abort.ts:28-38`) ⇒ use single-cleanup-site `finally`:

```ts
// after (follow-up commit) — finally gives one cleanup site
  try {
    upstream = await fetch(...);
  } catch (err) {
    if (headerDeadline.didExpire()) {
      finalize(504, ...); return anthropicErrorResponse(504, ...);
    }
    finalize(502, ...); return anthropicErrorResponse(502, ...);
  } finally {
    headerDeadline.clear();
  }
```

## Activation test (MODIFY tests/claude-messages-endpoint.test.ts)

Two-part oracle (audit blocker 2: a 502-only assertion cannot prove cleanup):

1. Endpoint activation test: upstream at unreachable port, long `connectTimeoutMs`;
   assert 502 — drives the exact reject path (`fetch` catch) the fix touches.
2. Deterministic cleanup assertion (WP2-P amendment, concrete seam): extract
   `fetchWithHeaderDeadline(input, init, timeoutMs, parent?, makeDeadline = clearableDeadline)`
   in src/server/claude-messages.ts — it owns try/catch/finally and GUARANTEES
   `deadline.clear()` in `finally`; returns `{upstream} | {expired:true} | {error}`.
   `anthropicNativePassthrough` consumes it. Unit tests drive the helper directly with
   a spy `makeDeadline` factory asserting `clear()` fires exactly once on all three
   paths: success, reject (unreachable port), timeout (didExpire). The endpoint 502
   test remains as activation evidence for the wired path.

## PR 137 integration checks

- AUDIT-VERIFIED (blocker 1, High): merging pr/137 onto current dev yields
  **49 i18n lint errors across the GUI**, not just Usage — files include
  gui/src/App.tsx:177, components/AddProviderModal.tsx (many), pages/ClaudeCode.tsx:139,
  pages/CodexAuth.tsx:262,359, pages/Dashboard.tsx:583,990,1001, pages/Models.tsx:584,595,
  pages/Providers.tsx:512, pages/Usage.tsx:387,412-413. PR 137's rule applies to every
  page/component (`gui/.eslint/i18n-file-groups.ts:2-8`, error-level in
  `gui/eslint.config.js:34-41`).
- Usage.tsx special case: dev REGRESSED existing translations — `t("usage.dayMon")`,
  `t("usage.heatmap.tooltipTokens")`, `t("usage.heatmap.tooltipRequests")` were replaced
  with hardcoded text (gui/src/pages/Usage.tsx:384-413). PR 137 already ships those keys
  (gui/src/i18n/en.ts:359-363) ⇒ RESTORE the `t(...)` calls, do not add new keys.
- Remediation follow-up commit (ours): after merge, run `cd gui && bun install && bun run lint`,
  inventory ALL errors, fix each by restoring/adding `t(...)` + locale keys in
  `gui/src/i18n/{en,ko,de,zh}.ts` per PR 137 conventions (allowlist only where PR 137
  itself allowlists). Re-run lint to 0 errors.
- Delegation (WP2-P amendment): the i18n remediation slice is dispatched to a
  gpt-5.6-sol worker with write scope gui/** ONLY (disjoint from main agent's
  src/server + tests/ slice). Main agent owns all git merges/commits/push.
- `bun run build:gui` must succeed (release prepublishOnly depends on it).

## Accept criteria

- dev history: merge(pr/136) → follow-up commit → merge(pr/137) [→ optional i18n
  follow-up] all present; `git push origin dev` receipt.
- `cd gui && bun run lint` → 0 errors after remediation commit.
- Full `bun test --isolate ./tests/` green locally before push (final gate is WP3).
- `gh pr view 136 137` still OPEN (they close at WP4 when main advances) — record state.
