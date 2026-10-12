# Lane 3 — Encrypted V2 passthrough and quota work

READ-ONLY adversarial review. Worktree `/private/tmp/ocx-closeout.xomWAA/wt`, detached at
`origin/dev` = `0f27bbeb3ce6a92077652695e161d49b88eedc7a`. The GitHub `dev` tip was re-read
immediately before verdict and had advanced by one commit to
`6580694c7911cfbf78da63b6258ec1c70bd8a0e3` — `test(oauth): restore a deleted contract test, and
fail when one disappears (#3530)`. That commit touches only `tests/repo-hygiene.test.ts` and
`tests/routing/anthropic-quorum-cache.test.ts`, changes no `src/` surface cited below, and I
re-ran mergeability for all five heads against `6580694c7`: #3444 and #3447 still merge clean
(exit 0), #2956, #2783 and #2973 still conflict on the same files (exit 1). Every disposition
below therefore holds against the current index; file:line citations are against `0f27bbeb3`,
which is identical to `6580694c7` for every path cited.

Mergeability was computed locally with `git merge-tree --write-tree origin/dev tmp-pr-<n>`
against fetched `refs/pull/<n>/head`. This matters: GitHub's `mergeable` field disagrees with
git for #3447, and the local three-way result is the one that reflects rename detection.

## Summary

| Item | Disposition | One-line reason |
|------|-------------|-----------------|
| #3444 | LAND_WITH_FIX | Correct, narrow, regression proven RED-on-dev; blocked only by `unsponsored_surface` on a 1-line `auth-cors.ts` policy row — needs maintainer sponsorship, not a code change. |
| #3447 | LAND_WITH_FIX | Real Antigravity/Ollama quota feature with 359 test lines; merges clean under rename detection, but leaves a pre-existing config-`baseUrl` bearer path unfixed and the config-route regression is missing. |
| #2956 | DEFER | 474 commits behind, zero human review, 4 real conflicts including two semantic ones in `summary.ts`/`logs-usage-routes.ts`; carry cost exceeds the lane. |
| #2783 | LAND_WITH_FIX | Author's own PR; all three maintainer blockers are still literally present at head — each is a bounded, named fix, not a redesign. |
| #2973 | LAND_WITH_FIX | Every substantive blocker is verified fixed at head; only staleness (152 commits) plus 4 mechanical conflicts remain. |

---

## #3444 — direct encrypted V2 task passthrough

**Disposition: LAND_WITH_FIX** (the "fix" is a maintainer sponsorship label, plus one draft-gate box)

### State

| Field | Value |
|---|---|
| Head | `baefb1334b69e1f37ae1446b6326ae09cb0021ac` |
| Base | `dev` |
| Mergeable | `MERGEABLE` / `BLOCKED` (GitHub), **clean** locally (merge-tree exit 0, tree `ed79a40e8`) |
| Review | `REVIEW_REQUIRED`, draft |
| Drift | merge-base `2421e44ce`, 40 behind / 2 ahead |
| CI on head | `hygiene` **fail**, `enforce-target` **fail**, `label`/`resolve-pr` pass, CodeRabbit skipped (draft) |
| Size | +111 / -4 across 6 files |

**Not conflicting.** This is the only item in the lane that merges cleanly.

### Why hygiene fails

The failure code is `unsponsored_surface`, from run `33872129233`:

```
##[error]PR hygiene failed: unsponsored_surface
```

The rule is `.github/scripts/pr-sponsored-surface.cjs:44` — `src/server/auth-cors.ts` is in
`RESTRICTED_FILES`. `assessSponsoredSurface` at `.github/scripts/pr-sponsored-surface.cjs:69-80`
returns the failure for any non-push-permission author touching that path without the
`maintainer-sponsored` label. Author `cb8010d6` has no push permission, so the gate fires.

**This is a labelling gate, not a defect signal.** The entire `auth-cors.ts` delta is one line
adding `allowEncryptedV2AgentTasks: "editor"` to `PROVIDER_CONFIG_FIELD_POLICY` at
`src/server/auth-cors.ts:787`. That map is an exhaustive field-classification table; the new
entry classifies a non-secret boolean as editor-editable. It changes no authentication and no
CORS behavior. The gate cannot tell a one-line policy-table row from a real auth change — that
is the intended conservatism, and the documented remedy in `.github/scripts/pr-hygiene.cjs:241-242`
is exactly "ask a maintainer to apply `maintainer-sponsored` once they have reviewed it."

`enforce-target` also fails, but that is the draft readiness checklist: the fourth box
("My PR is ready for review") is unticked in the PR body, which is the gate holding it in draft.

### Is the change safe?

Yes, and the trust boundary is drawn tightly. `canPassThroughEncryptedV2AgentTask`
(`src/server/responses/core.ts:1760-1783`) requires **all** of: inbound wire is Responses, the
provider explicitly opted in with `allowEncryptedV2AgentTasks === true`, `authMode` resolves to
`key`, and the model's resolved wire override is still `openai-responses`. Default is off
(`src/types/provider.ts:273-278`, optional boolean; `src/config.ts:540` schema entry is
`.optional()`).

Both call sites are guarded correctly. The recovery skip at `src/server/responses/core.ts:3122`
adds `&& !canPassThroughEncryptedV2AgentTask(route, inboundWire)`, and the fail-closed check at
`core.ts:3249-3255` additionally requires `!options.comboAttempt`, so combo attempts keep the
old native-only fail-closed path. Both run against the **final** route after selection, which
preserves the existing property that native fallback can rescue a routed primary.

No privacy concern: nothing logs the task, and OpenCodex neither decrypts nor translates it —
the ciphertext is forwarded byte-unchanged, which the test asserts.

### Test evidence — proven RED on dev

`tests/agent-task-recovery.test.ts`, two added blocks (+65 lines):

- `trusted direct Responses routes bypass recovery and preserve encrypted tasks`
- `trusted passthrough stays fail closed for %s` (`test.each` x 3: OAuth auth, Chat adapter, model-level Chat override)

I ran this rather than trusting the PR body. Dev source + PR test file, in a scratch tree:

```
(fail) trusted direct Responses routes bypass recovery and preserve encrypted tasks
 22 pass / 1 fail
```

failing at `tests/agent-task-recovery.test.ts:177`. With PR source: `23 pass / 0 fail`. Dev
baseline before the new tests: `19 pass / 0 fail`.

Note the three fail-closed cases **pass on dev too** — correctly, since dev fails closed
everywhere. They are guard tests protecting the new opt-in from widening, which is the right
shape for a trust-boundary change.

### Blockers found in the diff

None. Scope is clean (no unrelated churn), docs row added at
`docs-site/src/content/docs/reference/configuration/providers.md:73`, no Node-only APIs, no
logging of request bodies or credentials.

### Fix list

1. Maintainer applies `maintainer-sponsored` after reviewing the one-line `auth-cors.ts` row — this alone clears `hygiene`.
2. Author ticks the fourth readiness box (or a maintainer carries the branch), clearing `enforce-target` and draft state.
3. Re-run exact-head CI; the branch is 40 behind so a rebase onto `0f27bbeb3` is advisable, but merge-tree says it is not required for correctness.

If carried by a maintainer instead: `Co-authored-by: cb8010d6` is mandatory per `AGENTS.md`
("Landing another author's work"), in the description or a branch commit so it survives the squash.

### Dependencies

Touches `src/config.ts` and `src/types/provider.ts`, which #2783 and #2973 also touch nearby.
All three add distinct optional fields to different schema objects, so the overlap is additive.
**#3444 should land first** — it is the only clean merge and the smallest diff.

---

## #3447 — Antigravity weekly quota + Ollama Cloud quota

**Disposition: LAND_WITH_FIX**

### State

| Field | Value |
|---|---|
| Head | `745b70e1e76f6d6824557efd968f65878e4caa5b` |
| Base | `dev` |
| Mergeable | GitHub says `CONFLICTING`/`DIRTY`; **git merges it clean** (merge-tree exit 0, tree `7b85172d8`) |
| Review | `CHANGES_REQUESTED` (CodeRabbit only — no human CHANGES_REQUESTED review) |
| Drift | merge-base `52f4ffa5d`, 47 behind / 1 ahead |
| CI on head | all pass — `hygiene`, `enforce-target`, `label`, `resolve-pr`, CodeRabbit completed |
| Size | +567 / -9 across 3 files |

### The conflict is a rename, and it resolves

GitHub reports `CONFLICTING` because the PR edits `tests/provider-quota.test.ts` and
`tests/provider-account-quota.test.ts` at the repository root, while dev moved both into
`tests/providers/` in `8b6e4542a` ("test(layout): move providers and codex-integration into
tests/<domain>/"). GitHub's mergeability probe does not apply rename detection the way a local
three-way merge does.

Locally, git follows the renames and produces a clean tree. I verified the content actually
lands rather than merely merging: the merged tree's `tests/providers/provider-quota.test.ts` is
3106 lines vs 2804 on dev — exactly the +302 the PR adds — and contains 14 matches for
`parseOllamaCloudQuota|Ollama Cloud`.

**A rebase is mechanical**, but it must be done rename-aware: the author needs to move their
edits onto `tests/providers/`. If they instead push the old flat paths, they will trip the new
duplicate-basename gate at `tests/repo-hygiene.test.ts:269` ("no two test files share a
basename"), which dev added in `0f27bbeb3`.

### The feature

Two independent additions to `src/providers/quota.ts`:

1. **Ollama Cloud quota** — `parseOllamaCloudQuota` reads `GET https://ollama.com/api/usage`, mapping `limits.session` to the 5-hour window, `limits.weekly` to weekly, `limits.monthly` to monthly, normalizing 0..1 fractions to percent. Dev has no Ollama quota support at all.
2. **Antigravity weekly windows** — `retrieveUserQuotaSummary` parsing that produces `Gem`/`Gem (Weekly)`/`Cla`/`Cla (Weekly)` labels with a `PREFERRED_ORDER` sort. Dev's `fetchAntigravityQuota` (`src/providers/quota.ts:2362-2384`) only calls `fetchAvailableModels` and produces no weekly window.

### Review threads — what remains

Two CodeRabbit findings. I checked both against the head.

**Finding 1 (Critical, "duplicate `seen` declarations") — FALSE POSITIVE. Retracted.**
CodeRabbit claims `tests/provider-account-quota.test.ts:506` and `tests/provider-quota.test.ts:2796`
redeclare `const seen` "in the same `test()` callback scope" and that "TypeScript rejects the
test files before the suite can run." They do not. Line 470 is inside
`test("probes each account with its own bearer...")` and line 506 is inside a **separate**
`test("falls back to fetchAvailableModels when retrieveUserQuotaSummary returns 404")`. Distinct
lexical scopes, legal TypeScript. The file has 10+ such per-test `const seen` declarations, a
long-standing pattern. Confirmed by CI: all checks including `hygiene` are green on this head,
which would be impossible if the files failed to compile. No action.

**Finding 2 (Major, bearer sent to configured `baseUrl`) — PARTIALLY VALID, and the valid half is not fixed.**
CodeRabbit's prompt is imprecise, but there is a real issue underneath. The PR has *two*
Antigravity code paths and only one is hardened:

- `fetchAntigravityUsageQuota` (per-account, PR head lines ~2484-2521) is **correct**: it pins `ANTIGRAVITY_ACCOUNT_QUOTA_BASE = "https://daily-cloudcode-pa.googleapis.com"`, routes both the summary and the `fetchAvailableModels` fallback through `providerOutboundPost`, and checks `providerRedirectError` on both. Its docstring explicitly reasons that a configured `baseUrl` "is a routing choice for requests, not a second source of Google's accounting."
- `fetchAntigravityQuota` (provider-level, PR head lines ~2531-2555) is **not**: it computes `const baseUrl = (config.baseUrl || ANTIGRAVITY_ACCOUNT_QUOTA_BASE)` and the PR adds a **new** direct `await fetch(...)` to `${baseUrl}/v1internal:retrieveUserQuotaSummary` carrying `Authorization: Bearer ${accessToken}`, with default redirect following and no `providerRedirectError` check.

The mitigating fact, and why this is not Critical: the direct-`fetch`-to-`config.baseUrl`
pattern is **pre-existing on dev** at `src/providers/quota.ts:2371-2382`, which already sends
the same bearer to the same operator-configured URL. The PR does not introduce the weakness;
it adds a second request that inherits it. Still, it is a security-boundary surface per
`AGENTS.md`, the neighbouring function in the same diff demonstrates the correct pattern, and
extending an unpinned credential path is the kind of thing that should not grow.

### Test evidence

Strong: +302 lines in `provider-quota.test.ts` and +57 in `provider-account-quota.test.ts`.
The per-account tests are genuinely adversarial — they set
`globalThis.fetch` to a thrower ("plain fetch must not be used for account bearers") and assert
the pinned transport is used, the exact URL is
`https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`, and the pinned
address is honoured. These would be RED on dev (no `parseOllamaCloudQuota`, no
`setAntigravityAccountQuotaTransportForTests`, no summary parsing — the symbols do not exist).

**Missing coverage:** nothing exercises `fetchAntigravityQuota`'s new summary request against a
non-canonical `config.baseUrl`. The minimal test: configure a loopback `baseUrl`, call the
provider-level path, and assert the bearer is not sent / the request is refused.

### Fix list

1. Route the new `retrieveUserQuotaSummary` request in `fetchAntigravityQuota` through `providerOutboundPost` against `ANTIGRAVITY_ACCOUNT_QUOTA_BASE` with a `providerRedirectError` check, matching `fetchAntigravityUsageQuota` in the same file.
2. Add the redirect / non-canonical-baseUrl regression described above.
3. Rebase the two test files onto `tests/providers/` so the duplicate-basename gate stays green.
4. Reply to CodeRabbit's Critical finding marking it a false positive with the scope reasoning, so it does not get "fixed" into a real bug.

Optional, out of scope for this PR: harden the pre-existing dev-side `fetchAvailableModels`
call the same way, as a separate change.

### Dependencies

Sole owner of `src/providers/quota.ts` among clean candidates — but **#2783 also modifies
`src/providers/quota.ts` and conflicts there**. Stack order: **#3447 before #2783**. #3447 is
one commit, currently mergeable, and carries green CI; making the larger #2783 rebase onto it
is far cheaper than the reverse.

---

## #2956 — usage stats (precise time ranges, offline reports, GUI picker)

**Disposition: DEFER**

### State

| Field | Value |
|---|---|
| Head | `cc6aa5f481403a2369bf1610a7b909dc7aadbf32` |
| Base | `dev` |
| Mergeable | `CONFLICTING` / `DIRTY` (confirmed locally, merge-tree exit 1) |
| Review | `REVIEW_REQUIRED`, draft, **zero human reviews** (CodeRabbit skipped as draft) |
| Drift | merge-base `47b8d1643`, **474 behind** / 7 ahead |
| CI on head | only lightweight checks ran — `enforce-target`, `hygiene`, `label`, `resolve-pr` pass. **No test/typecheck matrix evidence exists on any head.** |
| Size | +1261 / -114 across 34 files |
| Last touched | 2026-08-30 |

### Conflicts

Four files, and two are semantic rather than mechanical:

| File | Kind |
|---|---|
| `src/usage/summary.ts` | **semantic** |
| `src/server/management/logs-usage-routes.ts` | **semantic** |
| `gui/src/pages/Usage.tsx` | large positional (+217/-55) |
| `docs-site/src/content/docs/reference/management-api.md` | mechanical |

`summary.ts` is the hard one. The PR rewrites `rangeWindow` wholesale, replacing the
`today`/`7d`/`30d` branch structure (dev: `src/usage/summary.ts:261-277`) with a
`localCalendarDayCount` + `resolveTimeRange` model, and widens `USAGE_RANGES` to add
`"yesterday"` (dev: `src/usage/summary.ts:16`). Dev has moved substantially underneath this
across 474 commits — `summary.ts` now carries cost-estimation plumbing
(`estimateAttemptCost`, `serviceTierContext`) and an `all`-range day-count path at
`src/usage/summary.ts:1366` that the PR's rewrite does not account for. Resolving this is a
re-derivation of the author's intent against a changed base, not a textual merge.

The PR also adds `src/usage/time-range.ts` (+200) and `gui/src/usage-time-range.ts` (+20),
neither of which exists on dev — those parts are additive and would carry cleanly.

A third, quieter conflict: the PR edits `tests/usage-summary.test.ts` and
`tests/cli-usage-report.test.ts` at the root, but dev has moved them to
`tests/usage/usage-summary.test.ts` and `tests/cli/cli-usage-report.test.ts`. Same relocation
trap as #3447.

### The feature is real and not yet superseded

Dev genuinely lacks this: `src/usage/time-range.ts` does not exist, `src/cli/observe.ts` has no
`since`/`until`/`timeRange` flags (ripgrep returns nothing), and `USAGE_RANGES` is still the
4-member union. So this is not SUPERSEDED — the capability gap is open.

### Test evidence

The PR carries `tests/usage-time-range-enhanced.test.ts` (+232) and
`gui/tests/usage-time-filter.test.tsx` (+119), which would be RED on dev purely because
`src/usage/time-range.ts` does not exist (import failure). That is real coverage for the new
module, though import-failure-RED is weaker evidence than a behavioral assertion against
existing code.

### Non-blockers checked and cleared

The new `readFileSync` from `node:fs` in `summary.ts` (offline `--file` reports) is **not** a
Bun-native violation: `node:fs` is established precedent in this exact subsystem —
`src/usage/log.ts:2`, `src/usage/ledger-scanner.ts:2`, `src/usage/debug.ts:3`, and
`src/server/management/logs-usage-routes.ts:2` all import it. Worth noting for a future review
round: the offline reader splits the whole file in memory with no `managementUsageMaxReadBytes`
equivalent (dev bounds the management path at `src/server/management/logs-usage-routes.ts:185`),
but that is a CLI-local path on an operator-supplied file, so it is a Medium, not a blocker.

### Why DEFER rather than carry

This is a judgment call, so here is the arithmetic. A bounded carry is not realistic in this lane:

- 474 commits of drift against a file (`summary.ts`) that was actively developed in that window;
- two semantic conflicts requiring re-derivation, one in a ~1400-line module;
- a 217-line GUI rewrite in `Usage.tsx` that would need visual verification and a screenshot per `AGENTS.md`'s gui-screenshot rule;
- **no human review has ever been performed**, so a carry would be simultaneously rebasing and first-reviewing 1261 lines across 34 files;
- no test-matrix CI has ever run on it.

That combination means a carry is a rewrite wearing a rebase's clothes. The honest disposition
is DEFER with a concrete re-entry condition rather than a speculative LAND_WITH_FIX.

**Re-entry condition:** ask the author to rebase onto current `dev`, split the additive
`time-range.ts` core from the `Usage.tsx` GUI work into two PRs, move the test files to their
`tests/<domain>/` homes, and mark ready-for-review. The `time-range.ts` half is then a
reviewable standalone unit. If the author is unresponsive, reimplementing the range-parsing
core fresh is cheaper than carrying this diff — with `Co-authored-by: Manson2438` per `AGENTS.md`.

### Dependencies

`src/server/management/logs-usage-routes.ts` and `src/usage/summary.ts` are untouched by the
other four items. No stack ordering constraint — it is independent, which is part of why
deferring it costs the campaign nothing.

---

## #2783 — quota reset detection (author's own PR)

**Disposition: LAND_WITH_FIX**

### State

| Field | Value |
|---|---|
| Head | `ad74f037dcb5c47126ea7c0ca30f989b71da1afc` |
| Base | `dev` |
| Mergeable | `CONFLICTING` / `DIRTY` (confirmed locally) |
| Review | `CHANGES_REQUESTED` by `Ingwannu` on this exact head |
| Drift | merge-base `50e955604`, **675 behind** / 23 ahead |
| CI on head | **full matrix green** — `test 1-4/4`, `macos`, `gates`, `keyring` x3, `npm-global` x3, `api usage`, `storage policy`, `react-doctor`, `hygiene`, `enforce-target` all pass |
| Size | +6144 / -73 across 52 files |
| Author | `lidge-jun` (maintainer, repository owner) |

### Conflicts

| File | Kind |
|---|---|
| `src/config.ts` | mechanical (additive schema section) |
| `src/providers/quota.ts` | **semantic** — collides with #3447 |
| `tests/lab/core-lab-boundary.test.ts` | mechanical |
| `devlog/_plan/260827_igwanu_bug_pr_merge_round/041_wp2b_2729_supersede.md` | add/add, trivial |

### The three maintainer blockers are all still present at head

The `CHANGES_REQUESTED` review states "exact-head CI being green does not close these runtime
boundaries." I verified each against `tmp-pr-2783` rather than trusting the review.

**Blocker 1 — webhook SSRF / scheme. CONFIRMED.**
`src/config.ts:866` is `webhookUrl: z.string().url().optional()` — `z.string().url()` accepts
any scheme, including `http:`. In `src/quota/reset-sinks.ts`, `deliverWebhook` calls
`assertUrlResolvesPublic(url)` only when `!config.allowPrivateNetwork`, and then issues
`await fetch(url, { method: "POST", ... })` with **default redirect handling**. So the initial
URL is validated and the redirect target is not: a public HTTPS endpoint can 302 the POST to
loopback or a cloud metadata address, and a plain `http://` URL puts the payload and the
credential-bearing webhook path on the wire in cleartext. The code comment correctly identifies
the SSRF surface and then leaves the redirect hop open.

**Blocker 2 — poller floor and cadence. CONFIRMED, and it is self-contradicting in source.**
`src/quota/reset-poller.ts:16-20` documents the constant as "Above the 5-minute provider cache
TTL and the 10-minute per-account TTL" and then declares `export const MIN_INTERVAL_MS = 60_000;`
— 60 seconds, which is *below* both TTLs it claims to exceed. Separately,
`src/server/background-lifecycle.ts:65` calls `startQuotaResetPoller()` with no argument, so the
interval is always `DEFAULT_INTERVAL_MS` (15 min); the configured `pollSeconds` never reaches
`setInterval`. `tick()` at `src/quota/reset-poller.ts:40` only checks
`resolveQuotaResetPollMs() === 0`, i.e. it honours "off" but ignores any other configured
cadence. An operator setting `pollSeconds: 300` silently still polls at 15 minutes. No
single-in-flight guard and no lifecycle generation fence: `setInterval(() => void tick())` can
overlap, and an in-flight tick can publish after `stopQuotaResetPoller()`.

**Blocker 3 — claim durability. CONFIRMED.**
`src/quota/reset-seen-store.ts:250-258`: `claimQuotaReset` does `claims.set(...)`, then
`prune()`, then `persistNow()`, then unconditionally `return true`. `prune()`
(`src/quota/reset-seen-store.ts:206-218`) can evict the just-added claim if its `resetAt` is
already past and it is older than `CLAIM_MAX_AGE_MS`; `persistNow()`
(`src/quota/reset-seen-store.ts:149-160`) swallows every write error in a bare `catch` marked
"Best-effort persistence only." Either path returns `true` to a caller that reads it as
"durably claimed, safe to dispatch," which is exactly the duplicate-notification-after-restart
the docstring promises to prevent.

### Test evidence

Extensive — 52 files, full matrix green. But note what green CI means here: it proves the
implemented behavior is self-consistent, not that the boundaries are right. All three blockers
are cases where the tests assert the current (wrong) behavior or do not probe the boundary at
all. Specifically missing:

1. a redirect-to-loopback regression (sink that 302s to `127.0.0.1`, assert the POST is refused);
2. a cadence regression (configure `pollSeconds`, assert `setInterval` receives it) plus an overlap / after-stop publish test;
3. a claim-durability regression (force `persistNow` to throw, assert `claimQuotaReset` returns `false`).

### Fix list

1. `src/config.ts:866` — constrain `webhookUrl` to HTTPS at write and read validation.
2. `src/quota/reset-sinks.ts` `deliverWebhook` — `redirect: "manual"`, then either reject redirects outright or revalidate and pin every hop; add the loopback-redirect regression.
3. `src/quota/reset-poller.ts:20` — raise `MIN_INTERVAL_MS` above the 10-minute account TTL so the constant matches its own docstring, or correct the docstring and justify 60s.
4. `src/server/background-lifecycle.ts:65` — pass the resolved `pollSeconds` into `startQuotaResetPoller`; make `tick()` honour cadence changes.
5. `src/quota/reset-poller.ts` — add a single-in-flight guard and a generation counter so a tick completing after `stop` cannot publish.
6. `src/quota/reset-seen-store.ts:250-258` — return `false` when `prune()` evicted the claim or `persistNow()` failed.
7. Rebase onto `0f27bbeb3` **after #3447 lands**, resolving `src/providers/quota.ts` against it.

### Is a bounded carry realistic?

Yes, with a caveat. 6144 lines is large, but the diff is overwhelmingly *new* files under
`src/quota/` (nine modules that do not exist on dev) plus their tests — it is additive, not a
refactor of live code, which is why only four files conflict despite 675 commits of drift.
The six fixes above are each localized to one function. This is the author's own PR, so there
is no attribution or responsiveness risk and no `Co-authored-by` requirement.

The caveat is sequencing: rebase after #3447, and treat the `src/providers/quota.ts` resolution
as semantic — both PRs restructure quota fetching.

### Dependencies

- **#3447** — shared `src/providers/quota.ts`, real conflict. #3447 lands first.
- **#3444, #2973** — shared `src/config.ts` / `src/types/config.ts`, additive only.

---

## #2973 — quota window activation (maintainer-sponsored)

**Disposition: LAND_WITH_FIX**

### State

| Field | Value |
|---|---|
| Head | `b6a8792675757b5236e2675a57c0b8082c51df66` (authored 2026-09-01, committed 2026-09-02) |
| Base | `dev` |
| Mergeable | `CONFLICTING` / `DIRTY` (confirmed locally) |
| Review | `CHANGES_REQUESTED`, last review `2026-09-01T15:21:15Z` on `653978f40` |
| Drift | merge-base `bb27c26be`, **152 behind** / 9 ahead |
| CI on head | full matrix green — `test 1-4/4`, `macos`, `gates`, `keyring` x3, `npm-global` x3, `api usage`, `storage policy`, `react-doctor`, `hygiene`, `enforce-target` |
| Labels | `enhancement`, **`maintainer-sponsored`** (restricted-surface gate already satisfied) |
| Size | +1025 / -60 across 33 files |

### The review history is the key fact

Three `CHANGES_REQUESTED` reviews, and reading them in order shows convergence:

| Review | Head | Substance |
|---|---|---|
| 08-30 | `e131896ff` | 17 GUI failures — `CodexAccountPool` dereferenced `account.quotaAutoRefresh` on fixtures that omit it |
| 09-01 08:42 | `cbdae0e64` | 3 blockers: type-unsafe legacy test that never injected its fixture; `registerStateSweepAfterTick` nested-server displacement; 409 doc overstatement |
| 09-01 15:21 | `653978f40` | **"The three blockers from my previous review are fixed on this head."** Held at changes-requested explicitly "because the integration evidence is stale, not because those fixes need redesign." |

The reviewer then enumerated only staleness items: base behind `dev`, PR body citing an old
head, an unticked readiness box, and no exact-head cross-platform evidence. And the head moved
once more after that review — `b6a879267` "fix(codex): restore displaced quota worker
registrations" — which is precisely blocker 2's subject, and that head now carries the full
green matrix the reviewer asked for.

So: **no substantive defect is currently outstanding.** The review's own closing line is "Once
that exact head is green, this remains a strong merge candidate," and it is green.

### Conflicts — all four mechanical

| File | Kind |
|---|---|
| `gui/src/i18n/fr.ts` | mechanical — adjacent locale-string insertion |
| `gui/src/styles.css` | mechanical — adjacent rule blocks |
| `src/server/management/config-routes.ts` | mechanical — adjacent route registration |
| `tests/gui/quota-bars-rows.test.ts` | mechanical — adjacent cases |

Notably the other eight `gui/src/i18n/*.ts` files auto-merged, which is the signature of a
positional collision rather than a semantic one: `fr.ts` conflicts only because dev happened to
add a neighbouring key. `src/config.ts`, `src/types/config.ts`, `src/server/index.ts` and
`src/codex/quota-auto-refresh.ts` all auto-merged despite 152 commits of drift.

### Test evidence

Carries `gui/tests/codex-account-pool-toast-tone.test.tsx` (legacy-payload compatibility through
the real `/api/codex-auth/accounts` normalization boundary) and lifecycle regressions covering
registration replacement and failed-start cleanup — both added specifically in response to
review, and both would be RED on dev since `src/codex/quota-auto-refresh.ts` does not exist
there. The reviewer independently confirmed "9 quota-worker tests and 39 focused account-pool
controller/behavior tests passed."

### Blockers found in the diff

None outstanding. The security-surface concern is pre-cleared by the `maintainer-sponsored`
label. `src/server/index.ts` is touched — worth one check during the rebase that the
`AGENTS.md` synchronous-activation invariant (no `await` between `Bun.serve` and the
`labActivationRequired` gate) still holds; `tests/core-lab-boundary.test.ts` enforces this
mechanically and is green on the head.

### Fix list

1. Rebase onto `0f27bbeb3`, resolving the four mechanical conflicts.
2. Update the PR body's Verification section to the post-rebase head.
3. Tick the remaining readiness box to clear draft.
4. Re-run exact-head CI; confirm `tests/core-lab-boundary.test.ts` and the GUI suite stay green.
5. If carried by a maintainer: `Co-authored-by: terrytan95`.

A bounded carry here is clearly realistic — four mechanical conflicts and no open defect. Of
the three large items in this lane, this is the one closest to landing.

### Dependencies

Shares `src/config.ts` and `src/types/config.ts` with #2783 and #3444, additively (distinct
optional fields). Shares nothing with #3447. No hard ordering constraint; sequence it after
#3444 to keep `src/config.ts` resolutions single-file-at-a-time.

---

## Recommended stack order

```
#3444  (clean merge; needs maintainer-sponsored label only)
  |
#3447  (rename-aware rebase; owns src/providers/quota.ts)
  |
#2783  (rebase onto #3447; 6 named boundary fixes)

#2973  (independent; 4 mechanical conflicts) -- can proceed in parallel after #3444

#2956  (deferred; independent, no ordering impact)
```

## Coverage ledger

Every changed file in #3444 and #3447 was read. For #2956, #2783 and #2973 the `src/` surface
and all conflicting files were read; locale/docs/asset files were skipped as mechanical, and the
GUI files in #2956 were assessed by size and conflict status rather than line-by-line, which is
recorded above as part of the DEFER reasoning.

## Method notes

- All GitHub state re-read immediately before verdict; `dev` tip `0f27bbeb3` unchanged throughout the review.
- Mergeability from local `git merge-tree --write-tree` against fetched `refs/pull/<n>/head`, because GitHub's `mergeable` flag is wrong for #3447 (rename detection).
- RED/GREEN for #3444 established by running the PR's test file against dev source in a scratch tree, not by trusting the PR body.
- No repository-wide suite was run. Focused runs only: `bun test tests/agent-task-recovery.test.ts` on dev, on dev+PR-test, and on PR head.
- No files in `src/`, `tests/`, or `gui/` were modified; scratch trees live outside the worktree.
- One incident worth recording: an early `git fetch origin dev:refs/remotes/origin/dev --force` deleted the `origin/dev` tracking ref in the shared git dir. It was immediately restored with `git fetch origin refs/heads/dev:refs/remotes/origin/dev` and verified equal to the GitHub tip `0f27bbeb3`. No worktree content or PR ref was affected.
