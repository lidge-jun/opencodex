# Lane 4 — chore / review-ready / enhancement PRs

READ-ONLY adversarial triage. Worktree `/private/tmp/ocx-closeout.xomWAA/wt`, detached at
`origin/dev` **0f27bbeb3**. Index re-read immediately before verdict (dirty files present and
untouched during the review: `src/oauth/index.ts`, `src/providers/model-rename-startup.ts`,
`tests/oauth/oauth-provider-reconcile.test.ts`, `tests/providers/model-rename-migration.test.ts`).
At the final index re-read these had been reverted by the parent; the only remaining working-tree
entry is this untracked `devlog/_plan/260905_open_work_closeout/` directory. No verdict depends on
those files.

All PR-head verification ran against `git archive` exports under
`/private/tmp/ocx-closeout.xomWAA/x<pr>/` with `node_modules` symlinked. No repository file was
modified; no `bun test` ran without a file argument.

## Summary

| Item | Disposition | One-line reason |
|------|-------------|-----------------|
| #3530 | LAND_WITH_FIX | Restores a genuinely deleted contract test and adds a real anti-deletion guard; the `test 1/4` failure was a REAL layout violation already fixed on the current head, but the removal test proves the wrong seam. |
| #3323 | LAND_AS_IS | Removes a repo-root temp-file write from a test; clean merge, full CI green on exact head, no behavior risk. |
| #3487 | REIMPLEMENT | Correct one-line defect and correct fix, but the target file was moved by the `tests/<domain>/` reorg; the PR would resurrect a deleted path. |
| #3508 | DEFER | Approved and green, but the module is never imported by `Logs.tsx` — it lands 175 lines of unreachable code plus a duplicate of live inline filtering. |
| #3383 | DEFER | 121 commits behind, CONFLICTING across 15 files including `Models.tsx`/9 locales, no cross-platform CI on head, 6 unresolved review findings. |
| #3329 | LAND_WITH_FIX | Real feature with strong tests, but carries a verified reset-metadata correctness bug and a semantic rebase over the combos test move. |
| #3421 | LAND_WITH_FIX | Docker support with a verified runtime-identity regression (compat manifest excluded) and an all-interfaces bind default. |
| #2716 | DEFER | 118 commits behind, CONFLICTING on `Models.tsx` + 9 locales, stacked under #3383 on the same files, no exact-head CI. |
| #2432 | LAND_WITH_FIX | Documents a real undocumented sentinel; only blocker is staleness (88 commits) plus a trivial `src/types/provider.ts` doc-comment naming an unexported symbol. |
| #3531 | LAND_WITH_FIX | Compact subset of #3528 rebased onto the current test layout, but it breaks a pre-existing regression test from #2960 and silently drops model-alias display. |
| #3528 | SUPERSEDED | Its alias half is fully contained in #3531 (byte-identical src diffs) on stale test paths; the `ocx effort` half is unrelated scope that should be split. |

---

## Cross-cutting finding: the `tests/<domain>/` reorg is the dominant blocker

Two commits moved the test tree into domain directories:

- `5424ad465` — `test(layout): move cli, oauth, routing, claude-integration into tests/<domain>/ (#3497) (#3511)`
- `8b6e4542a` — `test(layout): move providers and codex-integration into tests/<domain>/ (#3497) (#3516)`

Every CONFLICTING item in this lane except #3383/#2716 (which conflict on GUI locales) conflicts
*only* because it edits a test path that no longer exists. That makes the rebase mechanical for
#3487 and #3528, and it is also the direct cause of the #3530 deletion this lane is cleaning up.

## Cross-cutting finding: intake-only CI is not evidence

#3383, #3329, #3421, #2716 and #2432 each show exactly four checks — `enforce-target`, `hygiene`,
`label`, `resolve-pr` — plus CodeRabbit. Cross-platform CI has never run on those exact heads, so
there is no test evidence for any of them at their current SHA. Per `AGENTS.md`, an empty required
set is not green.

---

## #3530 — test(oauth): restore a deleted contract test, and fail when one disappears

**Disposition: LAND_WITH_FIX**

- Head `2980eaa35f7077682c5815e33b42ea6d8856f44c`, base `dev`, author `lidge-jun` (maintainer).
- `MERGEABLE` / `BLOCKED` / `CHANGES_REQUESTED`. Merge-base is `0f27bbeb3` — level with dev tip.
- Not conflicting. `git merge-tree` reports a clean `merged` result for `tests/repo-hygiene.test.ts`
  and a plain add for `tests/routing/anthropic-quorum-cache.test.ts`.

### CI on the exact head — the `test 1/4` question, answered

**The reported `test 1/4` failure is a REAL failure, not a flake — and it is on the PREVIOUS commit,
not the current head.**

- Failing job `101177147739` belongs to sha `14fbbd187cb355fac2ce15c48982bf61204b1bee`, the head
  before the current one.
- The assertion, from the job log:

```
(fail) tests/ layout > every test file resolves to a domain and migrated domains hold no stragglers
  {
-   "misplaced": [],
+   "misplaced": [ "adapters/anthropic/anthropic-quorum-cache.test.ts -> routing" ],
  }
  at tests/test-layout.test.ts:47:51
##[error]Test failure in shard 1/4 batch 21/23 (exit 1); not retrying assertion/test failures.
```

  This is deterministic and content-derived: the author first restored the file to
  `tests/adapters/anthropic/` and `layout.json` demanded `tests/routing/`. The runner itself states
  assertion failures are not retried, which rules out the flake classification.
- The fix is already in: `git ls-tree` shows `tests/adapters/anthropic/anthropic-quorum-cache.test.ts`
  at `14fbbd18` and `tests/routing/anthropic-quorum-cache.test.ts` at the current head.
- Re-verified on the current head: `bun test tests/test-layout.test.ts` -> **2 pass / 0 fail**.
- CI on the current head: `test 1/4` **pass (4m30s)**, `test 2/4` `3/4` `4/4` pass, `gates`,
  `storage policy`, `api usage`, `keyring` all pass. Only `macos 1/2` and `macos 2/2` still pending
  at time of writing.

**Classification: real failure, already resolved on the current head. No flake.**

### The defect is real

`anthropic-quorum-cache.test.ts` is genuinely absent from dev. Tracked-name check against the index:

| Required name | On dev |
|---|---|
| `always-on-429-failover.test.ts` | TRACKED |
| `anthropic-quorum-cache.test.ts` | **MISSING** |
| `generic-oauth-failover.test.ts` | TRACKED |
| `docs-429-failover-claims.test.ts` | TRACKED |

The subject it covers is live code: `src/oauth/anthropic-routing.ts:253` `QUORUM_CACHE_TTL_MS = 2_000`,
`:255` `quorumCache`, `:278` the TTL read, and invalidations at `:626`, `:660`, `:693`. Deleted by
`8b6e4542a` (the #3516 reorg) as a conflict resolution, with no corresponding add.

### Test evidence

The new guard in `tests/repo-hygiene.test.ts:290-318` is **RED on dev** — `missing` would be
`["anthropic-quorum-cache.test.ts"]` against the current index. The restored file passes on its own
head: **6 pass / 0 fail / 38 expect() calls**.

### Blockers

1. **[High] The removal test does not exercise the removal path.**
   `tests/routing/anthropic-quorum-cache.test.ts:129-140` names itself
   *"removing an account invalidates immediately"* but only calls
   `clearAnthropicSessionAffinityForAccount(ids[1])`. The real DELETE route at
   `src/server/management/oauth-account-routes.ts:551` calls `removeAccount(provider, id)` **first**,
   then the routing cleanup at `:556`. The test never removes the credential, so the roster is
   unchanged and the test cannot observe the transition its name claims. It asserts only that the
   store was re-read. This is the maintainer review finding and it is correct.
2. **[Low] The PR description is stale.** Body still says the file is restored at
   `tests/adapters/anthropic/`; the current head correctly places it at `tests/routing/`.

### Falsified: the CodeRabbit atime objection

CodeRabbit argues the `atime` oracle at lines 61-77 is unreliable on `noatime` filesystems. **Not
supported by evidence on this repository's CI.** Job `101178655718` (Linux, current head) shows all
six tests passing, including the two that would silently pass-through if `atime` never moved:
`a burst of requests inside the TTL window shares one store read` and
`a rotation invalidates immediately`. The negative assertion `expect(storeWasRead()).toBe(false)`
and the positive `expect(storeWasRead()).toBe(true)` both hold, which is only possible if `atime`
tracks reads. Non-blocking; a read counter would be more robust but the oracle is not broken here.

### Fix list

1. In `tests/routing/anthropic-quorum-cache.test.ts`, make the removal test mirror the route:
   `await removeAccount("anthropic", ids[1]!)` then `clearAnthropicSessionAffinityForAccount(ids[1]!)`,
   and assert both `hasAnthropicFailoverQuorum(start + 1) === false` and that the store was re-read.
2. Update the PR description to say `tests/routing/`.
3. Let `macos 1/2` and `2/2` finish green on the fixed head.

### Dependencies

None on files. Conceptually it is the cleanup for the same `8b6e4542a` reorg that makes #3487 and
#3528 conflict, so landing it first makes the lane's deletion story coherent.

---

## #3323 — test: isolate the route scanner probe in a unique temp directory

**Disposition: LAND_AS_IS**

- Head `0facdae6990716c49b793df5e237ea26354262c1`, base `dev`, author `luvs01`.
- `MERGEABLE` / `BLOCKED` / `REVIEW_REQUIRED`. Labels `chore`, `review-ready`.
- Not conflicting: `git merge-tree` returns a clean `merged` blob, and dev has not touched
  `tests/management-route-registry.test.ts` since the merge-base `ff1ac6b8c`.

### CI on the exact head — fully green

Unlike the rest of this lane, #3323 has a complete run: `test 1/4`-`4/4` pass, `gates` (1m24s),
`macos` (13m), `keyring macos/ubuntu/windows`, `storage policy`, `api usage`, `react-doctor`,
`enforce-target`, `hygiene`, `label`, CodeRabbit — all pass.

### The defect is real

Dev still writes the probe into the repository root:
`tests/management-route-registry.test.ts:125` — `const tmp = join(repoRoot, ".tmp-scanner-probe.ts");`.
A crash between write and `finally` leaves `.tmp-scanner-probe.ts` in the working tree, and
concurrent runs collide on one fixed path.

### Test evidence

The change *is* the test. It is not a regression test for a runtime bug, so there is no RED-on-dev
expectation to meet. Verified on the PR head: `bun test tests/management-route-registry.test.ts` ->
**13 pass / 0 fail**.

### Quality notes (non-blocking, all improvements)

- Replaces two `require("node:fs")` calls with proper ESM imports.
- Moves `writeFileSync` **inside** the `try`, so a write failure still triggers cleanup.
- `rmSync(tempDir, { recursive: true, force: true })` removes the whole `mkdtempSync` directory.

No security-boundary, privacy, or Node-only concern: `node:fs`/`node:os` are already used throughout
this file and are Bun-supported. No unrelated churn — one file, +6/-4.

### Dependencies

None. Nothing else in the lane touches this file.

---

## #3487 — test(kiro): prove the bounded completion fallback runs

**Disposition: REIMPLEMENT**

- Head `ee3b22d284b592a3a41d6d8b2db32c7e5c231b09`, base `dev`, author `Ingwannu`.
- `CONFLICTING` / `DIRTY` / `REVIEW_REQUIRED`. 26 commits behind dev.
- CI at the exact head was fully green (all four test shards, macOS, keyring, gates) — but that ran
  before the reorg landed.

### Why it conflicts — and why a rebase is mechanical

`git merge-tree` reports `removed in local` for `tests/kiro-stream.test.ts`: dev deleted the path in
`8b6e4542a`. The file now lives at `tests/providers/kiro/kiro-stream.test.ts`, and the target hunk is
at line 1723 there. **Pure rename, no semantic conflict** — the surrounding test body is identical.
The PR as-is would re-create a deleted file and leave two divergent copies, which
`tests/test-layout.test.ts` would then fail on. That is why this is REIMPLEMENT rather than
LAND_WITH_FIX: the patch cannot be applied to the path it names.

### The defect is real

At `tests/providers/kiro/kiro-stream.test.ts:1723` the stub is installed but never observed:

```ts
globalThis.fetch = (async () => new Response(streamOf(eventFrame({ content: "Final from fallback." })))) as typeof fetch;
```

The test — *"an attempt that falls back to the completion retry does not calibrate"* — asserts only
that the estimate is unchanged. If the bounded fallback silently stopped firing, the calibration
would also not move and the test would still pass. The added `fallbackCalls` counter with
`expect(fallbackCalls).toBe(1)` closes exactly that false-confidence hole. This is a legitimate
REVIEW-REGRESS-01 class fix.

### Test evidence

The one-line assertion is the entire change (+6/-1). It would not be RED on dev today, because the
fallback does fire; it is a *guard* against a future silent regression. That is the correct shape for
this defect and needs no additional test.

### Blockers

Only the path. No correctness, security, privacy, or Node-only issue; no unrelated churn.

### Fix list (for the reimplementation)

1. Apply the identical +6/-1 hunk to `tests/providers/kiro/kiro-stream.test.ts` at the
   `Final from fallback` stub (line 1723 on current dev).
2. Preserve authorship with a `Co-authored-by: Ingwannu <...>` trailer in a branch commit, per
   `AGENTS.md` "Landing another author's work" — a prose mention does not count.
3. Run `bun test tests/providers/kiro/kiro-stream.test.ts`.

### Dependencies

Same reorg family as #3530 and #3528. No file overlap with any other lane item.

---

## #3508 — feat(logs): add composable log filter engine

**Disposition: DEFER**

- Head `b78cadf12506df20b1e14ee42224ab4321dedbe5`, base `dev`, author `yansigit`.
- `MERGEABLE` / **`CLEAN`** / **`APPROVED`**. Labels `enhancement`, `review-ready`,
  `gui-screenshot-waived`.
- Not conflicting; both files are pure adds.
- **CI on the exact head is fully green**: `test 1/4`-`4/4`, `macos 1/2`+`2/2`, `npm-global` x3,
  `gates`, `keyring` x3, `storage policy`, `api usage`, `react-doctor`.

This is the one item where a green, approved, cleanly-mergeable PR still should not land as-is, so
the reasoning is spelled out.

### The blocker: the module is unreachable

`gui/src/pages/logs-filter.ts` is imported by exactly one file — its own test:

```
gui/tests/logs-filter.test.ts:7:} from "../src/pages/logs-filter";
```

The three other `rg` hits for `logs-filter` in the PR head are the unrelated CSS class
`logs-filter-field` in `Logs.tsx` and `styles.css`. `Logs.tsx` never imports the engine.

Meanwhile the live filtering still runs inline at `gui/src/pages/Logs.tsx:516`:

```ts
const filteredLogs = logs.filter(log => (
  logMatchesSurface(log, surfaceFilter)
  && (!interceptedHelpersOnly || Boolean(log.shadowCallRewrittenFrom))
  && logMatchesModelQuery(log, modelFilter)
  && (!conversationQuery || matchesLogConversationId(log.conversationId, conversationQuery, conversationQueryHash))
));
```

So merging adds 175 lines of dead source plus 141 lines of tests that only test the dead source, and
creates a second, divergent definition of "how a log row is filtered" next to the real one. The new
module also introduces behavior the page does not have (status, time window, tok/s bounds, provider
exact-match), so the two will drift the moment either is edited.

The green CI is honest but uninformative: the tests exercise a module nothing calls. The
`gui-screenshot-waived` label is consistent with this — there is no UI change, because nothing is
wired.

### Test evidence

`gui/tests/logs-filter.test.ts` is a thorough unit suite for the new module and would be RED without
it (the import would not resolve). But it proves nothing about `Logs.tsx`. The missing test is the
one that matters: a test asserting the **page** produces the same filtered set through the engine.

### Defer reason (concrete)

Land it together with the `Logs.tsx` call-site migration that deletes the inline `filteredLogs`
block, in one PR or as an explicit two-PR stack where the child is already open. Until then the
repository gains a maintenance liability with no user-visible behavior. If the author confirms the
wiring PR is imminent, this flips to LAND_AS_IS as the parent of that stack.

### Non-blocking quality notes

The module itself is well built: injected `now` clock, defensive `attempts()` narrowing of untrusted
log data, deterministic option ordering, no `any`. No security, privacy, or Node-only concern.

### Dependencies

None currently. It would become the parent of the `Logs.tsx` migration.

---

## #3383 — feat(models): add main picker ordering controls

**Disposition: DEFER**

- Head `51726d2c7c58146defdd6088aefa2b95a1e58553`, base `dev`, author `x3M3x`.
- `CONFLICTING` / `DIRTY` / `REVIEW_REQUIRED`. 26 files, +562/-89. **121 commits behind dev.**
- CI: intake-only (`enforce-target`, `hygiene`, `label`, `resolve-pr`) + CodeRabbit. **No
  cross-platform CI has ever run on this head.**

### Conflicts — semantic, not mechanical

`git merge-tree` reports 2 textual conflict markers and `changed in both` on 15 files:

`gui/src/i18n/{de,en,fr,ja,ko,ru,tr,zh-TW,zh}.ts`, `gui/src/pages/Models.tsx`,
`src/claude/model-info.ts`, `src/codex/catalog.ts`, `src/server/index.ts`,
`src/server/management/agent-settings-routes.ts`, `src/types/config.ts`.

The locale files conflict because newer Cursor documentation and translations landed in the same
table regions. `src/server/index.ts` is a composition root under an explicit `AGENTS.md` invariant
(no `await` between `Bun.serve` and `labActivationRequired`), so its conflict must be resolved by
hand, not by a merge tool.

### Unresolved review findings (6, from two CodeRabbit passes)

1. `src/server/management/agent-settings-routes.ts:674` — request body parsed and accessed without
   validating it is a non-null, non-array object; null/array/primitive bodies bypass the intended 400.
   Untrusted input at a management trust boundary.
2. `agent-settings-routes.ts:696-713` — `pickerOrder` validation accepts only `catalogModelSlug`
   values, rejecting the `provider/id` form.
3. `src/codex/catalog/sync.ts:636-641` — priority bands can tie/overlap so a listed row may not stay
   ahead of unlisted rows for partial orders longer than five entries.
4. `gui/src/pages/Models.tsx:1601-1611` — `savePickerOrder` does not share one bounded-fetch scope
   across both requests, so `pickerBusy` can stay stuck if a request stalls.
5. `gui/src/i18n/ja.ts:2291` — unnatural standalone label.
6. A regression test is requested for the >5-entry partial-order case.

### Defer reason (concrete)

Three independent conditions each block landing: a 121-commit semantic rebase across a protected
composition root and nine locales; zero test evidence at the exact head; and an unvalidated
management request body. This is not close to mergeable, and rebasing it before #2716 (which fights
for the same `Models.tsx` and locale lines) would force the conflict to be solved twice.

### Dependencies — stack order

**Overlaps #2716 on exactly 10 files**: `gui/src/pages/Models.tsx` and all nine
`gui/src/i18n/*.ts`. These two cannot be rebased independently. Recommended order: land **#2716
first** (smaller, more self-contained GUI surface), then rebase #3383 on top; or explicitly stack
#3383 on #2716's head. Also touches `src/types/config.ts`, shared with #3329.

---

## #3329 — feat(combos): per-combo cooldownMs and waitForCooldownMs

**Disposition: LAND_WITH_FIX**

- Head `1876d6001db50462805537f9bfea655ed97987ea`, base `dev`, author `Veritas-7`.
- `CONFLICTING` / `DIRTY` / `CHANGES_REQUESTED`. 17 files, +819/-60. **138 commits behind dev** —
  the stalest code item in the lane.
- CI: intake-only + CodeRabbit. No cross-platform CI on this head.

### Conflicts — mixed

`git merge-tree` shows 0 textual conflict markers but `changed in both` on `src/combos/failover.ts`,
`src/server/responses/core.ts`, `src/types/config.ts`, `tests/server-combo-failover-e2e.test.ts`,
plus `removed in local` for three test files the reorg moved:

| PR path | Current dev path |
|---|---|
| `tests/combos.test.ts` | `tests/codex-integration/combos.test.ts` |
| `tests/combo-management-api.test.ts` | `tests/routing/combo-management-api.test.ts` |
| `tests/cyber-policy-error-fidelity.test.ts` | `tests/providers/cyber-policy-error-fidelity.test.ts` |

The test moves are mechanical. `src/server/responses/core.ts` is **semantic**: it is one of the three
files `AGENTS.md` forbids from reaching `src/lab/`, and it has moved substantially in 138 commits.

### The feature is real

Combo failover currently has no per-combo cooldown or wait budget; the PR adds `cooldownMs` and
`waitForCooldownMs` through `src/combos/{types,resolve,failover,index}.ts`, the management route, and
`src/types/config.ts`. Not already fixed on dev.

### Test evidence — the strongest in the lane

`tests/combos.test.ts` +302, `tests/combo-management-api.test.ts` +130,
`tests/server-combo-failover-e2e.test.ts` +98, `tests/cyber-policy-error-fidelity.test.ts` +15. These
are genuine RED-on-dev regression tests: the config fields do not exist on dev, so they cannot compile
against it. Coverage spans resolution, management API persistence, and end-to-end failover.

### Blockers

1. **[High] Reset metadata dropped for body-confirmed quota failures wrapped in 5xx.**
   At `src/server/responses/core.ts:1645-1647` the `resetAt` metadata is retained only when the raw
   status is 402/429. `shouldRetryCodexPoolAccountQuota` also recognizes body-confirmed quota
   exhaustion inside HTTP 5xx and normalizes it to 429. When no alternate account exists, the raw 5xx
   reaches `consumeComboFailure` and the status-only condition discards a valid
   `x-codex-*-reset-at`. **Consequence: the combo target becomes eligible again before the real quota
   reset** — the exact failure this feature exists to prevent. Independently reported by CodeRabbit
   and the maintainer.
2. **[Medium] Korean docs contradict the runtime.**
   `docs-site/src/content/docs/ko/guides/combos.md:130` states every all-cooling selection returns
   HTTP 503 immediately, directly after documenting a positive `waitForCooldownMs`. Contradicts both
   the English source and the implementation.
3. **[Medium] Cooldown precedence unstated across 5 locales.** English `combos.md:423-425` plus
   ja/ko/ru/zh-cn need to say `Retry-After` and Codex reset signals take precedence over the
   configured cooldown.

### Fix list

1. Preserve the effective quota classification (not the raw status) through
   `retryCodexPoolOnAlternateAccount` -> `consumeComboFailure`, keeping the `cyberFailure` exclusion
   and direct 402/429 handling.
2. Add a focused regression for 5xx-body-confirmed quota retaining `resetAt`.
3. Correct `ko/guides/combos.md:130` to bound the immediate-503 claim to a zero wait budget or an
   earliest cooldown exceeding the budget.
4. Synchronize the precedence wording across the five locales.
5. Rebase: move the three test files to their `tests/<domain>/` paths and re-resolve
   `src/server/responses/core.ts` by hand.
6. Extend combo-update persistence assertions around `explicitDefault` (CodeRabbit).
7. Require full cross-platform CI on the rebased head.

### Dependencies

Shares `src/types/config.ts` with #3383. Sequence after any core-path work in other lanes.

---

## #3421 — Add Docker Compose deployment support

**Disposition: LAND_WITH_FIX**

- Head `432016100bb8c30f212be1e6aa71816bc7f1f932`, base `dev`, author `Skyline-23`.
- `MERGEABLE` / `BLOCKED` / `CHANGES_REQUESTED`. 16 files, +327/-89. 89 commits behind dev.
- **Not conflicting** — `git merge-tree` shows only `added in remote`; dev has touched none of these
  paths since the merge-base. A rebase is trivial.
- CI: intake-only + CodeRabbit. No cross-platform CI on this head.

### Blockers — both verified against dev, both real

1. **[High] The container is not runtime-equivalent to the packaged artifact.**
   `.dockerignore:9` excludes `src/generated/compatibility-version.json`, and the Dockerfile copies
   `src` without running the package generator. `scripts/prepare-package.ts:4` imports
   `generateCompatibilityVersionManifest`, so the normal package always has it. The runtime is
   documented fail-closed at `src/routing/compatibility/version.ts:80`:
   *"There is intentionally no runtime-only fallback ... live-route subject resolution fails closed
   and follows the profile's unknown-evidence policy."* `readOpenCodexCompatibilityVersion()` returns
   `null` (`:91`), and `src/routing/compatibility/subject.ts:96` then returns early with bare
   `subjectIds`. **This changes routing behavior in the container versus every other install** — not
   merely missing metadata.
2. **[High, security boundary] Compose publishes the data port on all host interfaces.**
   `compose.yaml:13` is `"${OPENCODEX_PORT:-10100}:10100"`, which binds `0.0.0.0` on the Docker host.
   The admission token limits unauthenticated use, but loopback is the correct default for a local
   Docker Desktop deployment. This is a deployment/authn-adjacent surface, so `AGENTS.md` security
   review applies.
3. **[Medium] Docs token-path inconsistency.** `docs-site/.../guides/remote-hub.md:175` reads the
   token from `/run/secrets/ocx_api_token` while the bootstrap step uses the canonical `ocx-state`
   volume path.

### Test evidence

`tests/container-bootstrap.test.ts` (+32) is a genuinely good boundary test for
`docker/bootstrap-token.ts`: chunked input, exact 4096-byte maximum, and rejection of empty,
multiline, and oversized input. It is RED on dev only in the sense that `docker/bootstrap-token.ts`
does not exist there — appropriate for new-file work.

**Missing test:** nothing asserts the container's runtime identity. The minimal addition is an
assertion in the final runtime stage that `readOpenCodexCompatibilityVersion()` returns a valid
SHA-256 value.

### Fix list

1. Generate `compatibility-version.json` during the image build via the package-owned generator and
   copy it into the runtime stage. Do **not** commit a stale generated file.
2. Add the runtime-stage assertion that `readOpenCodexCompatibilityVersion()` is non-null.
3. Default the published port to loopback:
   `"${OPENCODEX_BIND_ADDRESS:-127.0.0.1}:${OPENCODEX_PORT:-10100}:10100"`, with documented opt-in to
   `0.0.0.0` or a LAN/Tailscale address for remote-hub use.
4. Fix the `remote-hub.md:175` token path (and mirrored locales).
5. Rebase onto current dev; require exact-head container build **and** normal CI.
6. Security review before merge, per `AGENTS.md` (deployment + token handling).

### Dependencies

None — no file overlap with any other lane item. Can proceed in parallel.

---

## #2716 — feat: add discovered model display name editor

**Disposition: DEFER**

- Head `27ba09f405a22d7d20743f15ce25e3ecb1ac8e8f`, base `dev`, author `zigzag-007`.
- `MERGEABLE` per the latest poll but `BLOCKED` / `CHANGES_REQUESTED`; `git merge-tree` against the
  current tip still reports `changed in both` on 12 files. **118 commits behind dev.**
- 17 files, +1325/-3. CI: intake-only + CodeRabbit.

### Conflicts

`changed in both`: `gui/src/pages/Models.tsx`, `gui/src/styles.css`, all nine `gui/src/i18n/*.ts`,
and `docs-site/.../reference/configuration/providers.md`. Recent Cursor documentation and translation
additions occupy the same regions. Mechanical per hunk but wide, and the maintainer's Korean review
confirms the same finding independently.

### Blockers

1. **Staleness + conflicts** across 12 files, unresolved at the current head.
2. **No exact-head CI.** Cross-platform CI and React Doctor have not run; for a +1325-line GUI change
   with a 433-line test file, there is no evidence the tests pass anywhere.
3. **[Low] Unrelated churn.** The PR adds `docs/superpowers/plans/...` (+253) and
   `docs/superpowers/specs/...` (+138) — 391 lines of personal planning artifacts in a tracked
   directory that is not `devlog/`. `AGENTS.md` designates `devlog/` for planning notes; these do not
   belong in `docs/` and should be dropped from the diff.
4. **[Low] Two i18n wording fixes** (`tr.ts:2399` `ör.`->`örn.`; `zh-TW.ts:2358`
   `提供者名稱`->`供應商名稱`) and one docs hyphenation nit.
5. GUI change => final merge needs maintainer sign-off and a refreshed screenshot.

### Test evidence

`gui/tests/models-display-name-editor.test.tsx` (+433) is a substantial component suite that would be
RED on dev (`ModelDisplayNameDialog.tsx` does not exist). Coverage looks appropriate; it simply has
never been run by CI on this head.

### Defer reason (concrete)

A 118-commit rebase across 12 conflicting files, zero exact-head test evidence, and 391 lines of
out-of-scope documents. The author has been asked twice for a rebase. Deferring until a rebased head
with green CI and a screenshot exists.

### Dependencies — stack order

**Overlaps #3383 on 10 files** (`Models.tsx` + nine locales) and **#2432 on
`docs-site/.../reference/configuration/providers.md`**. Recommended: land #2716 first, then #3383,
and keep #2432's edit to the same providers reference in mind when sequencing.

---

## #2432 — docs: document the `__omit__` reasoning-effort wire sentinel

**Disposition: LAND_WITH_FIX**

- Head `c83d8eda1ad1c4938019914c26d12b8dfeaaa74f`, base `dev`, author `mdwsk88`.
- `MERGEABLE` / `BLOCKED` / `CHANGES_REQUESTED`. 9 files, +26/-18. 88 commits behind dev.
- `changed in both` on all eight `providers.md` locales and `src/types/provider.ts`, but every hunk is
  a two-line table-row replacement — **mechanical**.
- CI: intake-only + CodeRabbit.

### The gap is real

The sentinel exists and is load-bearing: `src/reasoning-effort.ts:21` —
`export const REASONING_EFFORT_OMIT_SENTINEL = "__omit__";` — consumed at `:24`, `:217`, `:228`,
`:230`, with adapter-specific handling in `src/adapters/ollama-native.ts` and
`src/adapters/anthropic.ts`. Dev documentation says nothing about it:
`docs-site/.../reference/configuration/providers.md:114` reads only *"Provider-wide wire aliases for
reasoning labels."* A user cannot discover `__omit__` from the docs. Confirmed **not** superseded.

### Test evidence

Docs plus two doc-comments; no runtime change, so no regression test is warranted. The behavior is
already covered by the adapter tests referenced at `ollama-native.ts` (issue #2356). Correct scope.

### Blockers

1. **[Low] The doc-comment names a symbol the file cannot see.** The added comment in
   `src/types/provider.ts` says *"Map a label to `REASONING_EFFORT_OMIT_SENTINEL`"*, but
   `src/types/provider.ts` does not import that constant. Since it also gives the literal, this is
   cosmetic — prefer the literal alone, or reference `src/reasoning-effort.ts` explicitly.
2. **[Low] Locale precision (CodeRabbit).** ja/ko/ru/tr should distinguish omission of the
   OpenAI-compatible `reasoning_effort` field from omission of Ollama's native `think` field, and the
   English `:114` example should say which wire it targets.
3. **[Low] French typographic apostrophe** in `l'omission` (explicitly non-blocking per reviewer).
4. Still a draft by the checklist; 88-commit rebase and an exact-head `docs-site` build needed.

The maintainer's most recent incremental review confirms the two earlier blocking issues are already
resolved (table alignment, French attribution) and that the isolated docs build passed at 393 pages.

### Fix list

1. Drop the unexported-symbol reference in `src/types/provider.ts`, or point to
   `src/reasoning-effort.ts`.
2. Apply the ja/ko/ru/tr wire-field distinction and clarify the English example.
3. Rebase onto current dev, re-resolve the eight locale table rows.
4. Re-run the exact-head `docs-site` build; tick the latest-dev checklist item only after the rebase.

### Dependencies

Shares `docs-site/.../reference/configuration/providers.md` with **#2716**. Whichever lands second
must re-resolve that table. Order is not important; the overlap is one file and mechanical.

---

## #3531 / #3528 — the `agy` alias pair

### The overlap, measured

Normalized `git diff` hashes (index lines stripped) for the four shared source files:

| File | #3531 | #3528 | Result |
|---|---|---|---|
| `src/codex/catalog/sync.ts` | `04a8ac9c08da` | `04a8ac9c08da` | **identical** |
| `src/providers/derive.ts` | `26c46b2dbdfa` | `26c46b2dbdfa` | **identical** |
| `src/providers/registry.ts` | `ce4a119b4356` | `ce4a119b4356` | **identical** |
| `src/router.ts` | `dc6bbbf0ae5a` | `dc6bbbf0ae5a` | **identical** |

**#3531 is exactly the alias subset of #3528**, byte-for-byte on every source file, by the same author
(`benedictusrey`), opened 10 minutes later. The only differences:

- **#3528 adds unrelated scope**: `src/cli/effort.ts` (+337), `src/cli/{dispatch,help,registry}.ts`,
  and `tests/cli-effort.test.ts` (+238) — a top-level `ocx effort` command that has nothing to do with
  the alias.
- **#3531 targets the current test layout**, #3528 targets the pre-reorg paths:

| #3528 (stale) | #3531 (current) |
|---|---|
| `tests/codex-catalog.test.ts` | `tests/codex-integration/codex-catalog.test.ts` |
| `tests/provider-model-aliases.test.ts` | `tests/providers/provider-model-aliases.test.ts` |

That is precisely why #3528 is `CONFLICTING`/`DIRTY` and #3531 is `MERGEABLE`: #3531 is the same work
rebased onto the post-`8b6e4542a` tree with the CLI scope removed.

---

### #3528

**Disposition: SUPERSEDED**

- Head `735e3f5c58e382edce06df0c684c91efed2a1ddb`, `CONFLICTING` / `DIRTY` / `REVIEW_REQUIRED`,
  **draft**. 25 commits behind dev. CI: intake-only.
- Superseded **for the alias half only**, by #3531, which carries the identical source diff on
  non-conflicting test paths.
- The `ocx effort` CLI half (+575 lines) is *not* superseded and is *not* reviewed here on its merits:
  it is unrelated scope bundled into an alias PR. It should be re-opened as its own PR against current
  dev, where it can get real CI and a focused review.
- Note: closing #3528 in favor of #3531 needs no `Co-authored-by` trailer — same author.

---

### #3531

**Disposition: LAND_WITH_FIX**

- Head `f486b5d607246b068c50bf13a6c4208fcbed1388`, base `dev`, merge-base `0f27bbeb3` — level with
  dev tip. `MERGEABLE` / `BLOCKED` / `REVIEW_REQUIRED`.
- Left draft during this review; CodeRabbit still pending. CI: `label` and `resolve-pr` pass,
  `enforce-target` and `hygiene` pending. **No test shard has run.**
- Not conflicting: clean `merged` results on all six files.

#### Blockers — found by running the tests, not by reading the diff

1. **[High] It breaks a pre-existing regression test it does not update.**
   Running the PR's own touched suites on its head:
   `bun test tests/providers/provider-model-aliases.test.ts tests/codex-integration/codex-catalog.test.ts`
   -> **276 pass, 1 fail**.

   ```
   (fail) configured CatalogModel displayName -> catalog display_name
          > the issue reproduction uses the effective model alias for the picker label
   at tests/codex-integration/codex-catalog.test.ts:2321
   Expected: "google-antigravity/gemini-3.7"
   Received: "agy/gemini-3.7"
   ```

   That test is not incidental: it was added by `0892b99d7`
   *"fix(catalog): display effective model aliases in Codex picker (#2960)"* — it is the regression
   proof for a previously fixed issue, and it lives at
   `tests/codex-integration/codex-catalog.test.ts:2286`. Because `enforce-target`/`hygiene` are the
   only checks queued, **CI would not have caught this before review.**

2. **[High] The early return silently discards later display rules.**
   The added hunk at `src/codex/catalog/sync.ts:277-279`:

   ```ts
   if (provider === "google-antigravity") {
     return "agy/" + model;
   }
   ```

   `routedDisplayName` is called from `:309` and `:378` with a slug whose model portion already
   carries the effective alias (`gemini-3.7-flash` -> `gemini-3.7`). Returning early makes the
   Antigravity branch bypass every later display rule, and the failure above shows the observable
   result. The function's own doc-comment at `:265-271` states *"All other providers keep the raw slug
   exactly as before"* — this adds a second provider-specific rule without updating that contract.

3. **[Medium] Decide display-only vs. routing, and say so.** The PR asserts display-only relabeling
   while also adding a routing alias in `src/router.ts` and a registry `alias` field. Both may be
   intended, but the catalog test above shows the display half has an unintended consequence.

#### What is correct

The routing half is sound and well tested. `tests/providers/provider-model-aliases.test.ts` (+48)
covers `agy/` resolution, case-insensitivity (`AGY/`), the canonical name still working, and — the
best assertion in the change — a user-defined `alias` overriding the built-in. The `src/router.ts`
fallback to `PROVIDER_REGISTRY` correctly preserves user precedence. Those tests are RED on dev
(no `alias: "agy"` in the registry).

#### Fix list

1. Reconcile with `codex-catalog.test.ts:2286`. Either update that test **with an explicit rationale**
   for why `agy/gemini-3.7` is now correct, or restrict the compact prefix so the effective-alias path
   from #2960 is preserved. Do not silently rewrite a regression test from a closed issue.
2. Move the Antigravity branch so it composes with the existing display rules instead of returning
   before them; update the `routedDisplayName` doc-comment at `:265-271`.
3. Add a regression test pinning Antigravity **with** a `modelAliases` entry, which is the exact case
   that broke.
4. Mark ready for review and require full cross-platform CI — the current four-check set cannot
   surface this class of failure.
5. Close #3528 in favor of this PR; re-open its `ocx effort` CLI work separately.

#### Dependencies

Supersedes #3528's alias half. `src/codex/catalog/sync.ts` is also touched by #3383 (picker ordering,
`:636-641`) — if both proceed, land #3531 first, since it is level with the dev tip while #3383 needs
a 121-commit rebase.

---

## Verification appendix

Commands used (all read-only; network calls escalated):

- `gh pr view/checks/diff`, `gh run list/view`, `gh api .../check-runs`, `.../actions/jobs/<id>/logs`
- `git fetch origin pull/<n>/head:tmp-pr-<n>` (fetch only; `dev` never checked out)
- `git merge-base`, `git merge-tree <base> HEAD tmp-pr-<n>`, `git ls-tree`, `git ls-files`, `git log -S`
- `git archive tmp-pr-<n> | tar -x -C /private/tmp/.../x<n>` then focused `bun test tests/<file>.test.ts`

Focused test runs performed (each with an explicit file argument):

| Target | Result |
|---|---|
| #3530 `tests/routing/anthropic-quorum-cache.test.ts` | 6 pass / 0 fail |
| #3530 `tests/test-layout.test.ts` | 2 pass / 0 fail (prior-head failure fixed) |
| #3323 `tests/management-route-registry.test.ts` | 13 pass / 0 fail |
| #3531 `provider-model-aliases` + `codex-catalog` | 276 pass / **1 fail** |

`tests/repo-hygiene.test.ts` was also run against the #3530 export; its 11 failures are artifacts of
running outside a git working tree (`git ls-files failed: not a git repository`) and are not
attributable to the PR — the same file passes in CI on the exact head.
