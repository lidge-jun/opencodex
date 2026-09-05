# 040 — wp4 / Stack D: usage and quota

Diff-level implementation plan for one PABCD work-phase. Written to be executable by an
implementer with no other context: every change site is quoted from the tree, every conflict has
a mechanical-or-semantic verdict, and every verifier was run before this doc was written.

Unit: `devlog/_plan/260905_open_work_closeout`. Lane research: `003_lane_v2_and_quota.md`.

## Base state (re-read immediately before writing)

`git fetch origin dev` -> `origin/dev` = **`6580694c7`**
(`test(oauth): restore a deleted contract test, and fail when one disappears (#3530)`).

Research-time tip was `0f27bbeb3`. Drift check for this lane's files:

```
$ git log --oneline 0f27bbeb3..origin/dev -- src/providers/quota.ts src/config.ts \
    src/types/config.ts src/types/provider.ts src/server/background-lifecycle.ts \
    src/server/management/config-routes.ts gui/src/i18n/fr.ts gui/src/styles.css
(empty)
```

`git diff --stat 0f27bbeb3 6580694c7` touches only `tests/repo-hygiene.test.ts` (+29) and
`tests/routing/anthropic-quorum-cache.test.ts` (+146). **Zero drift affecting any item below.**
Every `file:line` citation in the lane doc still resolves.

Mergeability re-verified against `6580694c7` with `git merge-tree --write-tree`:

| PR | Head | merge-tree exit | Conflicting paths |
|----|------|-----------------|-------------------|
| #3447 | `745b70e1e` | **0** (clean, tree `43d11d5e9`) | none — rename detection resolves the `tests/providers/` move |
| #2783 | `ad74f037d` | 1 | `src/config.ts`, `src/providers/quota.ts`, `tests/lab/core-lab-boundary.test.ts`, `devlog/_plan/260827_igwanu_bug_pr_merge_round/041_wp2b_2729_supersede.md` |
| #2973 | `b6a879267` | 1 | `gui/src/i18n/fr.ts`, `gui/src/styles.css`, `src/server/management/config-routes.ts`, `tests/gui/quota-bars-rows.test.ts` |

All three heads are unchanged from the lane snapshot (`gh pr view --json headRefOid`).

---

## 1. Loop-spec header

**Archetype:** spec-satisfaction repair. Each layer has a written specification — a docstring, a
neighbouring correct implementation, or a maintainer review — that the code at head does not
satisfy. The work is to close the gap named in that spec, not to redesign the feature.

**Trigger:** wp4 of the `260905_open_work_closeout` campaign, after wp3 (#3444) lands.

**Goal:** land #3447, then #2783, then #2973 on `dev` as a bottom-up stack, with each layer's
named defects fixed and covered by a regression that is RED without the fix.

**Non-goals:**

- #2956 — deferred; see section 6.
- Hardening the **pre-existing** `fetchAvailableModels` unpinned-bearer path on `dev`
  (`src/providers/quota.ts:2371-2382`). Real, but out of scope: the lane doc records it as a
  separate change, and widening #3447 past its own delta breaks the RED/GREEN story.
- `main`/`preview` promotion, releases, credential or account changes.
- Any repository-wide suite run.

**Verifier commands.** Each was executed in `/private/tmp/ocx-closeout.xomWAA/wt` at
`6580694c7` before this doc was written; each reads the change target of the layer it is
attached to.

| # | Command | Exit | Observed | Reads |
|---|---------|------|----------|-------|
| V1 | `bun test tests/providers/provider-quota.test.ts` | **0** | 110 pass / 0 fail, 365 expects | `src/providers/quota.ts` — provider-level path (#3447) |
| V2 | `bun test tests/providers/provider-account-quota.test.ts` | **0** | 17 pass / 0 fail, 80 expects | `src/providers/quota.ts` — per-account path (#3447) |
| V3 | `bun test tests/lab/core-lab-boundary.test.ts` | **0** | 17 pass / 0 fail, 48 expects | runtime import graph (#2783 conflict file) |
| V4 | `bun test tests/server-background-lifecycle.test.ts` | **0 unsandboxed** | 3 pass / 0 fail | `src/server/background-lifecycle.ts` (#2783 blocker 2) |
| V5 | `bun test tests/gui/quota-bars-rows.test.ts` | see note | — | `gui/src/components/QuotaBars.tsx` (#2973 conflict file) |
| V6 | `bun run typecheck` | run per layer | — | whole `src/` graph |
| V7 | `git fetch origin dev && git merge-base --is-ancestor <sha> FETCH_HEAD` | 0 = landed | — | landing proof |

**Two environment-only failures — do not investigate them as defects.** Both were diagnosed
before this doc was written:

- **V4** exits 1 *inside the Codex sandbox* with
  `error: Failed to start server. Is port 0 in use? code: "EADDRINUSE"` at
  `src/server/index.ts:2367`. The sandbox denies loopback bind. Re-run with escalated
  permissions: **exit 0, 3 pass / 0 fail**. Verified both ways.
- **V5** exits 1 with
  `error: Cannot find module 'react/jsx-dev-runtime' from '.../gui/src/components/QuotaBars.tsx'`
  because `gui/node_modules` is absent in this worktree (`ls -d gui/node_modules` -> not found).
  Run `cd gui && bun install` first, per `AGENTS.md`'s container section. This is not a #2973
  regression.

A piped invocation (`bun test ... | tail`) reports the **pipeline's** exit status and will mask a
failure as 0. Capture the status directly (`bun test <file> >/dev/null 2>&1; echo $?`) when the
exit code is the thing being asserted. Both false-green readings above were caught that way.

**Stop condition.** All three of:

1. #3447, #2783, #2973 each squash-merged into `dev`, proven by V7 on each merge SHA;
2. every fix in sections 3.1-3.3 present in the merged tree, each with its regression;
3. exact-head hosted CI green on each PR head at merge time (`gh pr checks <n>` filtered to the
   head SHA — an empty `--required` list is **not** green evidence).

**Memory artifact:** this doc plus the merge ledger in `060`. Record per layer: PR number, final
head SHA, merge SHA, V7 result, and the exact-head CI run id.

**Expected terminal outcomes:** three PRs merged; #2956 left open with the re-entry condition
posted; CodeRabbit's false-positive thread on #3447 answered so it is not "fixed" into a real bug.

**Escalation — stop the phase and report, do not improvise:**

- `src/providers/quota.ts` conflict in layer 2 resolves to anything other than "both functions
  present, both pinned" (semantic; see 3.2);
- `bun run typecheck` fails after a conflict resolution;
- exact-head CI fails on a **non**-environment check;
- a fix in 3.2 requires touching a file outside the layer's map;
- any `origin/dev` movement that touches `src/providers/quota.ts`, `src/config.ts`, or
  `src/quota/` — re-run the drift check before continuing.

---

## 2. Stack map (DEV-STACK-01..03)

A real dependency chain: #3447 and #2783 both restructure `src/providers/quota.ts`, and #2783's
conflict there is semantic.

| Layer | Branch | Targets | PR | Proves alone |
|-------|--------|---------|----|--------------|
| 1 | `codex/260905-antigravity-ollama-quota` | `dev` | #3447 (carried) | Antigravity weekly + Ollama Cloud quota parse, with **both** Antigravity paths pinned |
| 2 | `codex/260905-quota-reset-detection` | layer 1 branch | #2783 | Reset detection is boundary-safe: no redirect SSRF, honest cadence, honest claim durability |
| 3 | `codex/260905-quota-window-activation` | `dev` | #2973 (carried) | Codex quota windows auto-activate; GUI renders them |

**Why this order.**

- **1 before 2 — hard, shared-file.** Both edit `src/providers/quota.ts`; #2783 conflicts there
  against `6580694c7`. #3447 is one commit, +567/-9 across 3 files, merges clean, and carries
  green CI. #2783 is 23 commits, +6144/-73 across 52 files. Rebasing the large diff onto the
  small one is strictly cheaper than the reverse, and it means the semantic quota.ts resolution
  is done once, by the layer that understands both sides.
- **3 is independent.** #2973 shares nothing with #3447 and only touches `src/config.ts` /
  `src/types/config.ts` additively with #2783 (distinct optional fields, auto-merged despite 152
  commits of drift). It targets `dev` directly and may proceed in parallel once wp3's #3444 has
  landed — sequencing it after #3444 keeps `src/config.ts` resolutions single-file-at-a-time.

```
dev (6580694c7)
 +- codex/260905-antigravity-ollama-quota   #3447   [layer 1]
     +- codex/260905-quota-reset-detection  #2783   [layer 2]

dev (6580694c7)
 +- codex/260905-quota-window-activation    #2973   [layer 3, independent]
```

Per `AGENTS.md`, a stacked child targets its parent's **head branch** while the parent is open,
and is retargeted to `dev` after the parent lands. `enforce-target` skips the wrong-base gate
for those children.

### Merged-directly items (not restacked)

**None in this lane.** No Stack D item is LAND_AS_IS: all three need code or conflict work.
For reference, the pre-merge sequence used elsewhere in the campaign is: dismiss the stale
review, mark ready, confirm exact-head CI, then admin squash-merge.

### Carried contributor work — attribution is mandatory

#3447 and #2973 are contributor PRs. Landing them via a maintainer branch requires a
`Co-authored-by` trailer **in a branch commit or the PR description**, so it survives the squash.
Prose naming the author is not equivalent — GitHub reads the trailer, and `CREDITS.md` exists
because 27 landings got this wrong.

Emails resolved with `gh pr view <n> --json commits --jq '[.commits[].authors[]|{name,email,login}]|unique'`:

| PR | Login | Trailer |
|----|-------|---------|
| #3447 | `hualiny` | `Co-authored-by: yhualin <hualiny233@gmail.com>` |
| #2973 | `terrytan95` | `Co-authored-by: Terry Tan <tmy1995hflc@gmail.com>` |
| #2783 | `lidge-jun` | **not required** — author is the maintainer running this campaign |

---

## 3. Per-item plans

### 3.1 Layer 1 — #3447 Antigravity weekly + Ollama Cloud quota

**Head:** `745b70e1e` · **Author:** `hualiny` · **Labels:** `enhancement`, `review-ready` ·
**Draft:** no · **Review:** `CHANGES_REQUESTED` (CodeRabbit only; no human changes-requested) ·
**Size:** +567/-9 across 3 files · **CI on head:** all green.

GitHub reports `CONFLICTING`; git does not. The PR edits `tests/provider-quota.test.ts` and
`tests/provider-account-quota.test.ts` at the repository root, and `dev` moved both into
`tests/providers/` in `8b6e4542a`. GitHub's probe skips rename detection; `merge-tree` exits 0.

#### Branch creation

```bash
cd <clean worktree at origin/dev>
git fetch origin dev
git fetch origin refs/pull/3447/head:tmp-pr-3447
git switch -c codex/260905-antigravity-ollama-quota origin/dev
git cherry-pick 745b70e1e        # single commit
```

The cherry-pick is where the rename lands. Git applies the test hunks to
`tests/providers/*.test.ts` via rename detection. **Verify no root-level test file was
recreated** — if `tests/provider-quota.test.ts` exists at the repository root after the pick, the
duplicate-basename gate at `tests/repo-hygiene.test.ts:269` ("no two test files share a
basename") fails:

```bash
git status --porcelain
ls tests/provider-quota.test.ts tests/provider-account-quota.test.ts 2>&1   # must be "No such file"
git mv tests/provider-quota.test.ts tests/providers/provider-quota.test.ts  # only if recreated
```

Then append the trailer:

```bash
git commit --amend --no-verify --trailer "Co-authored-by: yhualin <hualiny233@gmail.com>"
```

#### File change map

**F1 — `src/providers/quota.ts`, `fetchAntigravityQuota` (PR head lines 2524-2573): pin the new summary request.**

This is the one real defect. The PR adds a **new** direct `fetch` carrying a bearer to an
operator-configured `baseUrl`, with default redirect following and no redirect check — while the
function immediately above it, added in the same diff, does the same job correctly.

Current code (PR head, `src/providers/quota.ts:2533-2547`):

```ts
  const baseUrl = (config.baseUrl || ANTIGRAVITY_ACCOUNT_QUOTA_BASE).replace(/\/+$/, "");

  try {
    const summaryResponse = await fetch(`${baseUrl}/v1internal:retrieveUserQuotaSummary`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": antigravityUserAgent(),
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ project: credential.projectId }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (summaryResponse.status === 401 || summaryResponse.status === 403) return null;
```

Target code — mirror `fetchAntigravityUsageQuota` (`src/providers/quota.ts:2483-2497`) exactly:

```ts
  const summaryUrl = `${ANTIGRAVITY_ACCOUNT_QUOTA_BASE}/v1internal:retrieveUserQuotaSummary`;

  try {
    const summaryResponse = await providerOutboundPost(
      "google-antigravity",
      { baseUrl: ANTIGRAVITY_ACCOUNT_QUOTA_BASE },
      summaryUrl,
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": antigravityUserAgent(),
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ project: credential.projectId }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
      antigravityOutboundDependencies,
    );
    if (await providerRedirectError(summaryResponse, summaryUrl)) return null;
    if (summaryResponse.status === 401 || summaryResponse.status === 403) return null;
```

Notes that make this mechanical rather than a judgment call:

- `providerOutboundPost` and `providerRedirectError` are **already imported** at
  `src/providers/quota.ts:17`. No import change.
- `ANTIGRAVITY_ACCOUNT_QUOTA_BASE` (`:2468`) and `antigravityOutboundDependencies` (`:2469`)
  are module-level and in scope.
- `providerOutboundPost` is POST-only and rejects non-HTTPS at
  `src/lib/provider-outbound.ts:115-118` (`ProviderOutboundPolicyError: "provider POST URL must
  use HTTPS"`). Since the URL is now the pinned constant, that branch is unreachable here — which
  is the point.
- Passing the pinned base as the `provider` config (not `config`) is what drops `config.baseUrl`
  from the destination decision. This is the documented rationale in the sibling docstring:
  a configured `baseUrl` "is a routing choice for requests, not a second source of Google's
  accounting."
- **Leave the `fetchAvailableModels` fallback at `:2558` alone.** It is unchanged from `dev`
  (`src/providers/quota.ts:2371-2382`), so touching it moves the diff outside the PR's delta.
  Non-goal, recorded above.

The `const baseUrl = ...` binding at `:2533` is still consumed by the fallback at `:2558`; keep it.

**F2 — `tests/providers/provider-quota.test.ts`: add the missing regression.**

#### Conflict resolution recipe

| Path | Kind | Recipe |
|------|------|--------|
| `tests/provider-quota.test.ts` -> `tests/providers/provider-quota.test.ts` | **mechanical (rename)** | Cherry-pick applies it; confirm no root file remains |
| `tests/provider-account-quota.test.ts` -> `tests/providers/provider-account-quota.test.ts` | **mechanical (rename)** | Same |
| `src/providers/quota.ts` | **none** | Clean against `6580694c7` |

#### Regression test

- **File:** `tests/providers/provider-quota.test.ts`
- **Name:** `fetchAntigravityQuota does not send the account bearer to a configured baseUrl`
- **Shape:** configure a provider with `baseUrl: "http://127.0.0.1:1/"`; install a pinned
  transport via `setAntigravityAccountQuotaTransportForTests`; set `globalThis.fetch` to a
  thrower (`"plain fetch must not be used for account bearers"` — the existing idiom in
  `tests/providers/provider-account-quota.test.ts`); assert the summary request URL is exactly
  `https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary` and that no
  request carried an `Authorization` header to the loopback host.
- **Second case:** `fetchAntigravityQuota refuses a redirected summary response` — pinned
  transport returns `302` with a `location` of `http://127.0.0.1/`; assert the result is `null`
  and the redirect target was never fetched.
- **RED on layer-1-without-F1:** the thrower fires, because `fetchAntigravityQuota` calls
  `globalThis.fetch` directly at `:2536`. **GREEN after F1:** the request goes through the pinned
  transport against the constant base, and `providerRedirectError` short-circuits the 302.
- **RED on `dev`:** stronger still — `parseAntigravityQuotaSummary`,
  `setAntigravityAccountQuotaTransportForTests` and `parseOllamaCloudQuota` do not exist, so the
  file fails to resolve.

#### Focused verifier

```bash
bun test tests/providers/provider-quota.test.ts          # V1 — baseline 110 pass / 0 fail
bun test tests/providers/provider-account-quota.test.ts  # V2 — baseline 17 pass / 0 fail
bun run typecheck
```

#### Accept criteria, with activation scenario per conditional path (C-ACTIVATION-GROUNDING-01)

Every branch below is named with the configuration that reaches it. A path no test can activate
is not accepted.

| # | Path | Activation scenario | Expected |
|---|------|---------------------|----------|
| A1 | `fetchAntigravityQuota` summary success | `google-antigravity` credential with `projectId`; pinned transport returns a valid summary body | `report(provider, "google-antigravity:retrieveUserQuotaSummary", quota)` |
| A2 | Summary 401/403 | Pinned transport returns 401 | `null` — no fallback, no partial row |
| A3 | Summary redirect | Pinned transport returns 302 -> loopback | `null`; `providerRedirectError` fires; bearer never re-sent |
| A4 | Summary throws | Transport rejects | falls through to `fetchAvailableModels` (unchanged dev behaviour) |
| A5 | Configured non-canonical `baseUrl` | `baseUrl: "http://127.0.0.1:1/"` | Summary still goes to `daily-cloudcode-pa.googleapis.com`; `globalThis.fetch` thrower never fires |
| A6 | No credential / no `projectId` | credential absent | `null` before any request |
| A7 | Ollama Cloud canonical base | `ollama-cloud` provider, canonical `baseUrl`, api key present | `report(provider, "ollama-cloud:usage", quota)` |
| A8 | Ollama Cloud non-canonical base | `baseUrl` not canonical | `null` before any request — `isCanonicalOllamaCloudBaseUrl` guard at `:715` |
| A9 | Ollama legacy vs migrated plan | body with `limits.session`+`limits.weekly`; then `limits.monthly` | five-hour + weekly percents; then monthly percent |
| A10 | Ollama zero windows | `limits` present but no parsable usage | `null` (`windows > 0` guard at `:710`) |
| A11 | Ollama 404 vs 4xx | 404; then 403 | `null`; then `TERMINAL_QUOTA_FAILURE` |

A7-A11 are already covered by the PR's +302 test lines; re-assert they still pass post-rename.
A3 and A5 are the **new** obligations from F1/F2.

#### Docs-site sync

Required — this adds a user-visible provider capability. `docs-site/` currently documents no
Ollama quota and no Antigravity weekly window (`rg -i 'ollama' providers.md` returns only
adapter/base-url rows). Add to
`docs-site/src/content/docs/reference/configuration/providers.md`: Ollama Cloud reads
`GET https://ollama.com/api/usage` only when `baseUrl` is canonical, and Antigravity now reports
`Gem`/`Gem (Weekly)`/`Cla`/`Cla (Weekly)` windows. State that quota probes always go to Google's
own host regardless of a configured `baseUrl` — that is now a documented guarantee, not an
implementation detail.

#### Review-thread obligation

Reply to CodeRabbit's **Critical** "duplicate `seen` declarations" finding marking it a false
positive: `tests/provider-account-quota.test.ts:470` and `:506` are in two **different**
`test()` callbacks, so the declarations are in distinct lexical scopes and are legal TypeScript.
Green `hygiene` on the head corroborates it — a file that failed to compile could not pass.
Say so explicitly, so a later pass does not "fix" it into a real bug.

#### PR skeleton

> **Title:** `feat(quota): support Google Antigravity weekly quota and Ollama Cloud quota`
>
> **Summary**
> Adds Ollama Cloud quota (`GET /api/usage`, canonical-base-only) and Antigravity weekly
> windows via `retrieveUserQuotaSummary`. Carries #3447 by `@hualiny`, rebased rename-aware onto
> `tests/providers/`, plus one fix: the provider-level summary request is pinned to Google's own
> host through `providerOutboundPost` with a redirect check, matching `fetchAntigravityUsageQuota`
> in the same file. Without it the PR added a second bearer-carrying request to an
> operator-configured `baseUrl` with default redirect following.
>
> **Verification**
> `bun test tests/providers/provider-quota.test.ts` · `bun test tests/providers/provider-account-quota.test.ts` · `bun run typecheck` · exact-head CI.
>
> **Stack**
>
> | Layer | PR | Targets |
> |---|---|---|
> | 1 (this) | #3447 carry | `dev` |
> | 2 | #2783 | layer 1 |
>
> **Checklist** — all boxes ticked.
>
> `Co-authored-by: yhualin <hualiny233@gmail.com>`

No `Closes #` line: `gh pr view 3447 --json body` shows no issue reference. Close #3447 manually
once this lands on `dev` (GitHub auto-closes only on merge into `main`).

---

### 3.2 Layer 2 — #2783 quota reset detection

**Head:** `ad74f037d` · **Author:** `lidge-jun` (maintainer) · **Draft:** no ·
**Review:** `CHANGES_REQUESTED` by `Ingwannu` on this exact head · **Size:** +6144/-73 across 52
files · **Drift:** 675 behind · **CI on head:** full matrix green.

Green CI here proves the implemented behaviour is self-consistent — not that the boundaries are
right. All three maintainer blockers are cases where tests assert current behaviour or do not
probe the boundary. Each was re-verified against `tmp-pr-2783` for this doc; **all three are
still literally present at head.**

The diff is overwhelmingly additive — nine new modules under `src/quota/` — which is why only
four files conflict despite 675 commits.

#### Branch creation (after layer 1 exists)

```bash
git fetch origin refs/pull/2783/head:tmp-pr-2783
git switch -c codex/260905-quota-reset-detection codex/260905-antigravity-ollama-quota
git merge tmp-pr-2783            # resolve the four conflicts below
```

A merge is preferable to `rebase` for 23 commits across 675 commits of drift: it resolves each
conflicting file **once** instead of once per commit. Squash-merge flattens it anyway.

#### Conflict resolution recipe

| Path | Kind | Recipe |
|------|------|--------|
| `src/config.ts` | **mechanical** | Additive schema section. Keep both sides: dev's neighbours and the PR's `quotaResetNotifySchema` (PR `:861-869`) plus its `configSchema` entry (`:921`). No shared key. |
| `src/providers/quota.ts` | **semantic — the one that needs judgment** | See below. |
| `tests/lab/core-lab-boundary.test.ts` | **mechanical** | Both sides add entries to the boundary allow/deny lists. Union them; `src/quota/` must stay off the core path. |
| `devlog/_plan/260827_igwanu_bug_pr_merge_round/041_wp2b_2729_supersede.md` | **mechanical (add/add)** | Historical devlog note; take `dev`'s copy. No runtime effect. |

**`src/providers/quota.ts` — semantic resolution.** Both PRs restructure quota fetching. #3447
(now in the base) adds `parseOllamaCloudQuota`, `fetchOllamaCloudQuota`,
`parseAntigravityQuotaSummary`, `fetchAntigravityUsageQuota`, and rewrites
`fetchAntigravityQuota`. #2783 adds reset-observation hooks into the report path.

The resolution invariant: **both features survive, and every Antigravity request stays pinned.**
Concretely — keep #3447's pinned `providerOutboundPost` call sites verbatim; graft #2783's
observation hook onto the **result** of `report(...)`, not into the request construction. If a
resolution deletes a `providerRedirectError` call or reintroduces a `config.baseUrl`-derived URL
for a bearer-carrying request, it is wrong — that is layer 1's whole delta. Re-read F1 above
before resolving, and re-run V1/V2 immediately after, since they are layer 1's guard.

#### File change map — six bounded fixes, each localized to one function

**B1 — `src/config.ts:865`: constrain `webhookUrl` to HTTPS.**

Current: `webhookUrl: z.string().url().optional(),` — `z.string().url()` accepts **any** scheme,
including `http:`, putting the payload and the credential-bearing webhook path in cleartext.

Target:

```ts
  webhookUrl: z.string().url().refine(
    value => { try { return new URL(value).protocol === "https:"; } catch { return false; } },
    { message: "webhookUrl must use https" },
  ).optional(),
```

The schema is `.strict()` and feeds both write validation and the read path via
`quotaResetNotifyError` (`src/config.ts:2117-2124`) and the ignore-reason reporter (`:1705-1709`),
so one edit covers both. Verify the `schema_invalid:` message still renders.

**B2 — `src/quota/reset-sinks.ts`, `deliverWebhook` (`:88-126`): close the redirect hop.**

The initial URL is validated and the redirect target is not. Current:

```ts
  if (!config.allowPrivateNetwork) {
    try {
      await assertUrlResolvesPublic(url);
    } catch {
      return { sink: "webhook", ok: false, reason: "blocked-destination" };
    }
  }

  const timeout = signalWithTimeout(config.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
      signal: timeout.signal,
    });
```

A public HTTPS endpoint can `302` the POST to loopback or a cloud metadata address. Target: add
`redirect: "manual"` to the `fetch` init, then treat any 3xx as a refusal:

```ts
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: json,
      redirect: "manual",
      signal: timeout.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      cancelResponseBodyBestEffort(response);
      return { sink: "webhook", ok: false, reason: "blocked-destination" };
    }
```

Refuse rather than re-validate-and-follow: the operator can configure the final URL directly,
which is the same stance `providerRedirectError` takes
(`src/lib/provider-outbound.ts:94-104`: "configure the final provider URL directly"). Reuse the
existing `"blocked-destination"` reason so no new enum member is needed — see section 4.

**B3 — `src/quota/reset-poller.ts:20`: make `MIN_INTERVAL_MS` match its own docstring.**

The source contradicts itself. The docstring at `:16-19` says "Above the 5-minute provider cache
TTL and the 10-minute per-account TTL", then:

```ts
export const MIN_INTERVAL_MS = 60_000;
```

60 s is below both TTLs it claims to exceed. Target: `export const MIN_INTERVAL_MS = 10 * 60_000;`
(above the 10-minute per-account TTL, as documented).

Coupling to check: `src/quota/reset-notify-config.ts:35` has `const MIN_POLL_SECONDS = 60`, and
`resolveQuotaResetPollMs` clamps with it (`:89-91`). After B4 the resolver's value reaches
`setInterval`, so leaving `MIN_POLL_SECONDS = 60` while raising `MIN_INTERVAL_MS` means the
poller floor silently overrides an accepted config value. Raise `MIN_POLL_SECONDS` to `600` to
match, and keep the `pollSeconds === 0` passive-only escape (`:89`) intact.

**B4 — `src/server/background-lifecycle.ts:65`: pass the configured cadence.**

Current: `startQuotaResetPoller();` — no argument, so the interval is always
`DEFAULT_INTERVAL_MS` (15 min) and the configured `pollSeconds` never reaches `setInterval`.
`tick()` (`src/quota/reset-poller.ts:40`) only checks `resolveQuotaResetPollMs() === 0`, so it
honours "off" and ignores every other cadence. An operator setting `pollSeconds: 300` silently
polls at 15 minutes.

Target: resolve the configured value and pass it —
`startQuotaResetPoller(resolveQuotaResetPollMs() || undefined);` — and in `tick()`, compare the
resolved cadence against the live interval, restarting the timer when it changed. That preserves
the module's stated "toggling takes effect on the next tick without a restart" property, which is
the reason the config gate lives in the callee.

**B5 — `src/quota/reset-poller.ts`: single-in-flight guard and generation fence.**

`setInterval(() => void tick(), bounded)` (`:59`) can overlap, and an in-flight tick can publish
after `stopQuotaResetPoller()`. Target: a module-level `let inFlight = false` returning early
while set, and a `let generation = 0` incremented in both `start` and `stop`, captured at tick
entry and re-checked before publishing. Drop the result when the generation moved.

**B6 — `src/quota/reset-seen-store.ts:250-258`: stop returning `true` for a lost claim.**

Current:

```ts
export function claimQuotaReset(key: string, at: number, resetAt?: number): boolean {
  hydrate();
  if (claims.has(key)) return false;
  claims.set(key, { at, ...(resetAt !== undefined ? { resetAt } : {}) });
  prune();
  persistNow();
  return true;
}
```

Two ways this lies to its caller. `prune()` (`:206-218`) can evict the just-added claim when its
`resetAt` is already past and it is older than `CLAIM_MAX_AGE_MS`. `persistNow()` (`:149-160`)
swallows every write error in a bare `catch` marked "Best-effort persistence only." Either way the
caller reads `true` as "durably claimed, safe to dispatch" — producing exactly the
duplicate-notification-after-restart the docstring promises to prevent.

Target: make `persistNow()` report success (return `boolean`, or set a module flag), then:

```ts
  claims.set(key, { at, ...(resetAt !== undefined ? { resetAt } : {}) });
  prune();
  if (!claims.has(key)) return false;   // prune() evicted it: not durably claimed
  return persistNow();                  // false when the write failed
```

Keep `persistNow`'s `catch` — the change is reporting the failure, not throwing. The
"no await inside" property that makes the check-and-set indivisible under Bun's single-threaded
turn semantics (docstring `:243-248`) must survive: all three additions are synchronous.

#### Regression tests

| Fix | File | Test name | RED before / GREEN after |
|-----|------|-----------|--------------------------|
| B1 | `tests/quota-reset-notify-config.test.ts` | `an http webhookUrl is rejected as schema_invalid` | RED: `z.string().url()` accepts `http://...`, so the config validates. GREEN: refinement rejects it. |
| B2 | `tests/quota-reset-notify.test.ts` | `a webhook that redirects to loopback is refused` | RED: default redirect following POSTs the payload to `127.0.0.1` and returns `ok: true`. GREEN: 3xx -> `blocked-destination`, loopback never receives a request. |
| B3+B4 | `tests/server-background-lifecycle.test.ts` | `the configured pollSeconds reaches the poller interval` | RED: `startQuotaResetPoller()` takes no argument; the spy sees `DEFAULT_INTERVAL_MS`. GREEN: sees the resolved value. |
| B5 | `tests/quota-reset-observation.test.ts` | `an overlapping tick is skipped and a tick completing after stop does not publish` | RED: two concurrent ticks both run; a post-`stop` tick publishes. GREEN: second returns early; generation fence drops the late publish. |
| B6 | `tests/quota-reset-seen-store.test.ts` | `claimQuotaReset returns false when the claim is not durable` | RED: returns `true` in both the pruned-immediately and `persistNow`-throws cases. GREEN: `false` in both. |

All five files ship in the PR (`git diff --name-only 6580694c7...tmp-pr-2783`), so these are
additions to existing suites. `tests/server-background-lifecycle.test.ts` already exists on
`dev`; the other four arrive with the PR.

Note the RED baseline: these are RED **on the PR head**, not on `dev` — the modules do not exist
on `dev`, so a dev-side run is an import failure, which is weaker evidence. Establish RED by
running each test against the merged branch **before** applying its fix. Do that explicitly; it
is the only way the six fixes are proven load-bearing.

#### Focused verifier

```bash
bun test tests/quota-reset-notify-config.test.ts
bun test tests/quota-reset-notify.test.ts
bun test tests/quota-reset-seen-store.test.ts
bun test tests/quota-reset-observation.test.ts
bun test tests/quota-reset-detector.test.ts
bun test tests/server-background-lifecycle.test.ts     # V4 — needs unsandboxed loopback bind
bun test tests/lab/core-lab-boundary.test.ts           # V3 — conflict file
bun test tests/providers/provider-quota.test.ts        # V1 — layer 1 guard after the semantic resolution
bun run typecheck
```

`bun run test:changed` is appropriate here too — the touch set spans 52 files. Per `AGENTS.md`
it follows Bun's parsed module graph and cannot see subprocess dependencies:
`tests/helpers/quota-reset-burst-child.ts` is spawned as a child process, so
`tests/quota-reset-observation.test.ts` must be run explicitly.

#### Accept criteria, with activation scenario per conditional path

| # | Path | Activation scenario | Expected |
|---|------|---------------------|----------|
| B1a | https webhook | `quotaResetNotify.webhookUrl: "https://example.com/hook"` | accepted |
| B1b | http webhook | `"http://example.com/hook"` | `schema_invalid: quotaResetNotify.webhookUrl`; section rejected at write |
| B2a | Public 2xx | sink returns 200 | `{ ok: true }` |
| B2b | Redirect to loopback | sink returns 302 -> `http://127.0.0.1:9/` | `{ ok: false, reason: "blocked-destination" }`; loopback never contacted |
| B2c | Private with opt-in | `allowPrivateNetwork: true`, direct loopback URL | delivered — the documented self-hosted-receiver opt-in still works |
| B2d | Timeout | sink never responds past `timeoutMs` | `{ ok: false, reason: "timeout" }` |
| B3a | Below-floor cadence | `pollSeconds: 60` | clamped to the 10-minute floor; no timer faster than the account TTL |
| B4a | Configured cadence | `pollSeconds: 900` | `setInterval` receives 900 000 ms |
| B4b | Passive-only | `pollSeconds: 0` | no timer; passive detection still runs |
| B4c | Cadence changed live | config edited from 900 -> 1800 between ticks | next tick adopts it without a restart |
| B5a | Overlapping tick | tick 1 still awaiting when the interval fires | tick 2 returns immediately; no second probe |
| B5b | Tick after stop | `stopQuotaResetPoller()` during an in-flight tick | result discarded; nothing published |
| B6a | Normal claim | fresh key, writable state file | `true`, one notification |
| B6b | Write failure | `atomicWriteFile` throws | `false`; caller does not dispatch |
| B6c | Pruned immediately | claim with a past `resetAt` older than `CLAIM_MAX_AGE_MS` | `false` |
| B6d | Duplicate claim | same key twice | second returns `false` (unchanged) |

#### Docs-site sync

The PR already updates `docs-site/src/content/docs/reference/configuration/server.md`,
`reference/management-api.md` and `reference/cli/providers-accounts.md` (all auto-merged). Update
for the fixes: `webhookUrl` must be `https` (B1); webhook redirects are refused, configure the
final URL (B2); the `pollSeconds` floor is 600 s with 0 meaning passive-only (B3/B4).

#### Security-boundary flag

**B1 and B2 are security-boundary changes** (outbound credential-bearing request destination,
SSRF). Per `AGENTS.md` and `MAINTAINERS.md` these require explicit security review. The author
is the maintainer, so this is a self-review the merge ledger must record rather than a delegated
approval — note the reviewer and the exact head reviewed. The layer-1 quota.ts resolution
inherits the same flag.

#### PR skeleton

> **Title:** `feat(quota): detect usage-window resets and notify on them`
>
> **Summary**
> Adds `src/quota/` reset detection with webhook and command sinks. Rebased onto layer 1 and
> resolves `src/providers/quota.ts` semantically against the Antigravity/Ollama work. Six fixes
> for the three review blockers: HTTPS-only `webhookUrl`; `redirect: "manual"` with 3xx refused;
> `MIN_INTERVAL_MS` raised to match its docstring; the configured `pollSeconds` now reaches
> `setInterval`; single-in-flight plus generation fence; `claimQuotaReset` returns `false` when
> the claim was pruned or the write failed.
>
> **Verification** — the focused list above, plus `bun run test:changed` and exact-head CI.
>
> **Stack**
>
> | Layer | PR | Targets |
> |---|---|---|
> | 1 | #3447 carry | `dev` |
> | 2 (this) | #2783 | layer 1 branch -> retarget to `dev` after layer 1 lands |
>
> **Checklist** — all boxes ticked.

No `Closes #` line — no issue reference in the PR body.

---

### 3.3 Layer 3 — #2973 quota window activation (independent)

**Head:** `b6a879267` · **Author:** `terrytan95` · **Draft:** yes ·
**Labels:** `enhancement`, **`maintainer-sponsored`** (restricted-surface gate already satisfied) ·
**Review:** `CHANGES_REQUESTED` (last review `2026-09-01T15:21:15Z`, on the **older** head
`653978f40`) · **Size:** +1025/-60 across 33 files · **Drift:** 152 behind · **CI on head:** full
matrix green.

**No substantive defect is outstanding.** The review history converges: the 09-01 15:21 review
says "The three blockers from my previous review are fixed on this head" and holds at
changes-requested explicitly "because the integration evidence is stale, not because those fixes
need redesign." The head then moved once more — `b6a879267`, "fix(codex): restore displaced quota
worker registrations", which is precisely blocker 2's subject — and that head carries the full
green matrix the reviewer asked for. The work here is staleness plus four mechanical conflicts.

#### Branch creation

```bash
git fetch origin refs/pull/2973/head:tmp-pr-2973
git switch -c codex/260905-quota-window-activation origin/dev
git merge tmp-pr-2973          # resolve the four conflicts below
git commit --amend --no-verify --trailer "Co-authored-by: Terry Tan <tmy1995hflc@gmail.com>"
```

Targets `dev` directly — no stack dependency on layers 1-2.

#### Conflict resolution recipe — all four mechanical

| Path | Kind | Recipe |
|------|------|--------|
| `gui/src/i18n/fr.ts` | **mechanical** | Adjacent locale-key insertion. Keep both keys, preserve alphabetical/positional order. The other **eight** `gui/src/i18n/*.ts` files auto-merged — the signature of a positional collision, not a semantic one: `fr.ts` conflicts only because `dev` added a neighbouring key. |
| `gui/src/styles.css` | **mechanical** | Adjacent rule blocks. Keep both; no selector overlap. |
| `src/server/management/config-routes.ts` | **mechanical** | Adjacent route registration. Keep both routes; check for no duplicate path. |
| `tests/gui/quota-bars-rows.test.ts` | **mechanical** | Adjacent cases. Union them. |

`src/config.ts`, `src/types/config.ts`, `src/server/index.ts` and `src/codex/quota-auto-refresh.ts`
**auto-merged** despite 152 commits of drift — confirmed by `merge-tree`, which lists only the
four paths above.

#### Test-path relocation — check before pushing

The PR edits `tests/quota-bars-rows.test.ts`, `tests/codex-quota-auto-refresh.test.ts`,
`tests/server-background-lifecycle.test.ts` and `tests/state-store-sweeper.test.ts`. On `dev`:

| PR path | Path on `dev` |
|---|---|
| `tests/quota-bars-rows.test.ts` | `tests/gui/quota-bars-rows.test.ts` |
| `tests/state-store-sweeper.test.ts` | `tests/oauth/state-store-sweeper.test.ts` |
| `tests/server-background-lifecycle.test.ts` | unchanged (still at root) |
| `tests/codex-quota-auto-refresh.test.ts` | new file — place under `tests/codex/` |

The merge already resolves the first two by rename detection (the conflict is reported at the
`tests/gui/` path). Confirm no root-level duplicate survives, or
`tests/repo-hygiene.test.ts:269` fails:

```bash
git ls-files 'tests/**/*.test.ts*' | xargs -n1 basename | sort | uniq -d   # must be empty
```

#### Invariant to re-check during the merge

`src/server/index.ts` is touched. `AGENTS.md` requires that `startServer` stay synchronous
between the `Bun.serve` call and the `labActivationRequired` gate — no `await` may be introduced
there, and `startServer` must not become `async`. `tests/lab/core-lab-boundary.test.ts` enforces
this mechanically and is green on the head; re-run it after resolving (V3).

#### Regression tests (already in the PR — verify, do not re-derive)

| File | Test | RED on `dev` because |
|------|------|----------------------|
| `gui/tests/codex-account-pool-toast-tone.test.tsx` | legacy-payload compatibility through the real `/api/codex-auth/accounts` normalization boundary | `src/codex/quota-auto-refresh.ts` does not exist on `dev` |
| `tests/codex-quota-auto-refresh.test.ts` | worker registration replacement and failed-start cleanup | same |
| `tests/server-background-lifecycle.test.ts` | nested-server registration displacement | the displaced-registration path does not exist on `dev` |

Both were added specifically in response to review. The reviewer independently confirmed
"9 quota-worker tests and 39 focused account-pool controller/behavior tests passed."

#### Focused verifier

```bash
cd gui && bun install && cd ..                      # required for V5 — see the environment note
bun test tests/gui/quota-bars-rows.test.ts          # V5
bun test tests/codex/codex-quota-auto-refresh.test.ts
bun test tests/server-background-lifecycle.test.ts  # V4 — unsandboxed
bun test tests/lab/core-lab-boundary.test.ts        # V3
bun run lint:gui
bun run typecheck
```

#### Accept criteria, with activation scenario per conditional path

| # | Path | Activation scenario | Expected |
|---|------|---------------------|----------|
| C1 | Auto-refresh enabled | account with `quotaAutoRefresh: true` | worker registered; window refreshes on schedule |
| C2 | Field absent (legacy payload) | account fixture **omitting** `quotaAutoRefresh` | no dereference error — this is the 08-30 review's 17 GUI failures; the toast-tone test covers it |
| C3 | Explicitly disabled | `quotaAutoRefresh: false` | no worker registered |
| C4 | Nested server start | second `startServer` while the first is live | the newer registration does not displace the older server's process-wide work |
| C5 | Failed start cleanup | `startServer` throws after registration | registrations cleaned up; no orphan worker |
| C6 | Config route write | POST the new config route | value persisted; `.strict()` rejects unknown keys |
| C7 | GUI locale coverage | switch to `fr` | new keys render; no missing-key fallback |

C2 is the one to actually exercise by hand — it is the regression that produced the first review
round, and it activates only through a payload shape the normalization boundary must tolerate.

#### Docs-site sync

The PR already updates `getting-started/how-it-works.mdx`,
`reference/configuration/providers.md`, `reference/management-api.md`,
`structure/05_gui-and-management-api.md` and `structure/08_openai-provider-tiers.md` — all
auto-merged. Re-read `providers.md` after the merge for a stale statement about quota windows
not auto-activating.

#### GUI screenshot obligation

`enforce-target` rejects a PR whose title or description mentions `gui` without a screenshot of
the UI change. The PR carries `.github/pr-assets/quota-window-auto-refresh.png`; ensure it is
referenced in the carried description, and re-capture it if the merge changes the rendering.

#### PR skeleton

> **Title:** `feat(codex): auto-activate quota reset windows`
>
> **Summary**
> Carries #2973 by `@terrytan95`, rebased onto `6580694c7` with four mechanical conflicts
> resolved (`gui/src/i18n/fr.ts`, `gui/src/styles.css`,
> `src/server/management/config-routes.ts`, `tests/gui/quota-bars-rows.test.ts`). All three
> blockers from the review series are fixed on the carried head; this rebase supplies the
> exact-head evidence the last review asked for.
>
> **Verification** — the focused list above, plus `bun run lint:gui` and exact-head CI.
> ![quota window auto refresh](.github/pr-assets/quota-window-auto-refresh.png)
>
> **Stack**
>
> | Layer | PR | Targets |
> |---|---|---|
> | 3 (this) | #2973 carry | `dev` — independent of layers 1-2 |
>
> **Checklist** — all boxes ticked.
>
> `Closes #2969.`
> `Co-authored-by: Terry Tan <tmy1995hflc@gmail.com>`

`Closes #2969` is carried from the original PR body. Because these PRs target `dev` and GitHub
auto-closes only on merge into `main`, close #2969 manually once this lands.

---

## 4. Field and enum chains

**Layer 1 (#3447) — N/A.** No new config field. `fetchOllamaCloudQuota` and
`fetchAntigravityQuota` read the **existing** `config.baseUrl` and `config.apiKey`; the new
outputs (`fiveHourPercent`, `weeklyPercent`, `monthlyPercent`, `customWindows`) are existing
`ProviderQuota` members. The only new module-level constants —
`ANTIGRAVITY_ACCOUNT_QUOTA_BASE` (`:2468`) and `OLLAMA_CLOUD_USAGE_URL` — are internal, not
serialized. F1 **removes** a config read rather than adding one.

**Layer 2 (#2783) — one new config section.** Full chain, verified end to end:

| Stage | Site | Content |
|---|---|---|
| **Creation** | `src/types/config.ts:477` | `quotaResetNotify?: OcxQuotaResetNotifyConfig;` on `OcxConfig` |
| **Schema / validation** | `src/config.ts:861-869` | `quotaResetNotifySchema` = `{ enabled, kinds, pollSeconds, webhookUrl, allowPrivateNetwork, timeoutMs, command }`, `.strict()` |
| **Registration** | `src/config.ts:921` | `quotaResetNotify: quotaResetNotifySchema.optional().catch(undefined)` |
| **Serialization** | standard config write path | `.strict()` — an unknown key is a rejected write, not a silent drop |
| **Deserialization** | `src/config.ts:1705-1709`, `:2117-2124` | ignore-reason reporter and `quotaResetNotifyError` -> `schema_invalid: quotaResetNotify.<field>` |
| **Resolution** | `src/quota/reset-notify-config.ts:47-102` | `RawNotify` -> frozen resolved shape; `pollSeconds` -> `pollMs`; `positiveInt` clamps with `MIN_POLL_SECONDS=60`, `DEFAULT_POLL_SECONDS=900`, `timeoutMs` bounded `[100, 30 000]` |
| **Consumers** | `isQuotaResetNotificationEnabled()` `:148`; `resolveQuotaResetPollMs()` `:151`; `src/quota/reset-poller.ts:40`; `src/server/background-lifecycle.ts:65`; `src/quota/reset-sinks.ts:175` | |

**Enum chain — `kinds`:** `z.enum(["scheduled", "surprise"])` (`src/config.ts:863`) ->
`ALL_KINDS` default in the resolver -> `Set<QuotaResetKind>` -> filter in `reset-sinks.ts`. **B1-B6
add no enum member.** B2 deliberately reuses the existing `"blocked-destination"` delivery reason
rather than adding `"blocked-redirect"`, so the `QuotaResetDeliveryResult` union is unchanged and
no consumer needs a new case. If a future change does need to distinguish them, the union is the
one place to extend.

**Fields changed by fixes:** `webhookUrl` gains an HTTPS refinement (B1) — same field, narrower
domain, no chain change. `pollSeconds` gains a higher floor (B3) — the clamp lives in the
resolver, so a hand-edited low value degrades to the floor instead of discarding the section.

**Layer 3 (#2973) — new field, but the chain is already merged and reviewed.** `quotaAutoRefresh`
flows `src/types/config.ts` -> `src/config.ts` schema -> `src/server/management/config-routes.ts`
(the conflict file) -> `src/codex/quota-auto-refresh.ts` -> `gui/src/hooks/useCodexAccountPool.ts`
-> `gui/src/components/CodexAccountPool.tsx`. The **absent-field** case (C2) is the one that broke
once and is now covered by `gui/tests/codex-account-pool-toast-tone.test.tsx`. All chain files
except `config-routes.ts` auto-merged.

---

## 5. Risk and rollback

| Layer | Risk | Likelihood | Rollback |
|---|---|---|---|
| 1 | F1 pins the summary request; an operator relying on a proxying `baseUrl` for quota loses it | Low — matches the per-account path already merged, and `fetchAvailableModels` still honours `baseUrl` | `git revert <squash-sha>`; single commit, 3 files |
| 1 | Rename-aware pick recreates a root-level test file | Medium — the trap that made GitHub call this CONFLICTING | Caught pre-push by the `uniq -d` check and by `tests/repo-hygiene.test.ts:269` |
| 2 | Semantic `src/providers/quota.ts` resolution silently drops layer 1's pinning | **Medium — highest risk in the phase** | V1/V2 immediately after resolving; they are layer 1's guard. Escalate rather than improvise |
| 2 | B3's higher floor breaks an operator running a deliberately fast poll | Low — the docstring already claimed this floor; `pollSeconds: 0` still disables | Revert B3+B4 together; they are coupled through the resolver |
| 2 | B2 refuses a legitimately redirecting webhook receiver | Low-Medium — some receivers 302 to a CDN | Documented remedy: configure the final URL. `allowPrivateNetwork` unchanged |
| 2 | 6144 lines, 52 files, 675 commits of drift | Medium, but additive — nine new modules, only four conflicts | Revert the squash; `src/quota/` is new, so removal is clean |
| 3 | GUI merge changes rendering; screenshot goes stale | Low | Re-capture; `enforce-target` blocks a `gui` PR without one |
| 3 | `src/server/index.ts` merge introduces an `await` in the synchronous activation window | Low | `tests/lab/core-lab-boundary.test.ts` fails mechanically; revert the hunk |

**Security-boundary items requiring the `MAINTAINERS.md` explicit-security-review exception:**

| Item | Surface | Exception needed |
|---|---|---|
| Layer 1 F1 | Outbound destination for a credential-bearing request (`src/providers/quota.ts`) | Security review. Note: this **narrows** the surface |
| Layer 2 B1 | Credential-bearing webhook URL scheme (`src/config.ts`) | Security review |
| Layer 2 B2 | SSRF via redirect (`src/quota/reset-sinks.ts`) | Security review |
| Layer 2 quota.ts resolution | Inherits F1's surface | Same review as F1 |
| Layer 3 | `maintainer-sponsored` label **already applied** | Pre-cleared |

No workflow, OAuth, CORS or release-automation file is touched by this phase. No item requires a
`.github/workflows/` change.

**Security-note handling.** Per `AGENTS.md`, pre-disclosure security material does not go in
`devlog/`. Everything in this doc describes weaknesses in **open, public pull requests** whose
diffs are already visible — B2's redirect gap is public in #2783's diff, and F1's is public in
#3447's — so this is not pre-disclosure material. If the work surfaces a defect on **shipped**
`dev` code that is not already public, write it to `.tmp/` or a `mktemp -d` path and say where,
not into this unit.

---

## 6. Out of scope / deferred

| Item | Reason (carried from `003_lane_v2_and_quota.md`) |
|---|---|
| **#2956** usage stats (time ranges, offline reports, GUI picker) | DEFER — 474 commits behind with two **semantic** conflicts (`src/usage/summary.ts`, `src/server/management/logs-usage-routes.ts`), a 217-line `Usage.tsx` rewrite needing visual verification, **zero human review ever**, and no test-matrix CI on any head: a carry would be simultaneously rebasing and first-reviewing 1261 lines across 34 files. Independent of every other item, so deferring costs the campaign nothing. **Re-entry:** ask the author to rebase, split the additive `src/usage/time-range.ts` core from the GUI work into two PRs, move the test files to their `tests/<domain>/` homes, and mark ready. If unresponsive, reimplementing the range-parsing core fresh is cheaper than carrying the diff, with `Co-authored-by: Manson2438`. Not SUPERSEDED — `src/usage/time-range.ts` does not exist on `dev` and `USAGE_RANGES` is still the 4-member union. |
| Pre-existing unpinned bearer in `fetchAvailableModels` (`src/providers/quota.ts:2371-2382` on `dev`) | Real but out of scope — it predates #3447, which only inherits it. Widening the PR past its own delta breaks the RED/GREEN story. Lane doc records it as a separate change. |
| #2956's unbounded offline reader (`readFileSync` with no `managementUsageMaxReadBytes` equivalent) | Medium, not a blocker — a CLI-local path over an operator-supplied file. Rides with #2956's re-entry. |
| #3444 (V2 passthrough) | Belongs to wp3, not this phase. Sequence #2973 after it so `src/config.ts` resolutions stay single-file-at-a-time. |
| CodeRabbit's "duplicate `seen`" Critical on #3447 | Not a fix — a **false positive** to answer in-thread: `:470` and `:506` are separate `test()` scopes, and green `hygiene` on the head proves the file compiles. Recorded so a later pass does not "fix" it into a real bug. |

---

## 7. Stack map (summary)

| Layer | Branch | Targets | PR | Author | Trailer | Conflicts | Gate |
|---|---|---|---|---|---|---|---|
| 1 | `codex/260905-antigravity-ollama-quota` | `dev` | #3447 | `hualiny` | `Co-authored-by: yhualin <hualiny233@gmail.com>` | none (rename-aware) | V1, V2, typecheck |
| 2 | `codex/260905-quota-reset-detection` | layer 1 | #2783 | `lidge-jun` | not required | 4 (1 semantic: `src/providers/quota.ts`) | V1, V3, V4 + 5 quota suites |
| 3 | `codex/260905-quota-window-activation` | `dev` | #2973 | `terrytan95` | `Co-authored-by: Terry Tan <tmy1995hflc@gmail.com>` | 4 mechanical | V3, V4, V5, lint:gui |
