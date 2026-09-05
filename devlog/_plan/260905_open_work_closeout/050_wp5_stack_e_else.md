> **Amended by 008 (audit round 1):** E0 anchors re-locate to `tests/routing/anthropic-quorum-cache.test.ts:144`; all Co-authored-by trailers use the ID-prefixed noreply form; #3329 is appended as layer E7 (LAND_WITH_FIX, `core.ts` hand-resolution + lab-boundary verifier).

# 050 — wp5 / Stack E: remaining ready PRs and implementable bug issues

Unit: `devlog/_plan/260905_open_work_closeout`. Work-phase **wp5**, one PABCD cycle.
Worktree: `/private/tmp/ocx-closeout.xomWAA/wt` (detached).
Sources: `004_lane_else_prs.md` (#3530 #3487 #3508 #3383 #3329 #3421 #2716 #2432 #3531 #3528),
`005_lane_bug_issues.md` (#3464, #3425).

## 0. Drift since lane research — READ THIS FIRST

Lane research ran at `origin/dev` = `0f27bbeb3`. The brief said dev had moved to `6580694c7`.
**It has moved twice more since.** Verified at plan time:

```
$ git fetch origin dev && git log --oneline 0f27bbeb3..origin/dev
79e03643d test(layout): move server, storage, ci-workflows into tests/<domain>/ (#3497) (#3518)
bdafc5191 test(oauth): prove the unobservable quorum staleness window is harmless (#3533)
6580694c7 test(oauth): restore a deleted contract test, and fail when one disappears (#3530)
```

**Plan-time dev tip: `79e03643d`.** Four consequences, each of which changes the lane's instructions:

| # | Drift | Consequence for this work-phase |
|---|---|---|
| D1 | **#3530 is MERGED** as `6580694c7` | It is no longer a landing in this stack. Its `LAND_WITH_FIX` item — the removal test that does not remove — **merged unfixed** and is carried here as **E0**, a new maintainer-authored follow-up. |
| D2 | **A third reorg wave landed** (#3518: `server`, `storage`, `ci-workflows`) | `tests/repo-hygiene.test.ts` -> `tests/ci-workflows/repo-hygiene.test.ts`; `tests/management-route-registry.test.ts` -> `tests/server/`; `tests/server-combo-failover-e2e.test.ts` -> `tests/server/`. Every path below is re-verified against `79e03643d`, not against the lane docs. |
| D3 | **#3531's head moved** `f486b5d60` -> `e5137f6f2` | The lane's headline blocker (**#2960 regression RED**) **is already fixed by the author.** Reproduced and disproved below — the fix list changes materially. |
| D4 | **#3528's head moved** `735e3f5c5` -> `f9f5f836d` and **dropped its alias half entirely** | The lane's `SUPERSEDED` reasoning (byte-identical src diffs) no longer describes the current head. Disposition stays SUPERSEDED-for-alias, but the evidence is now "alias half removed by author", and the residual `ocx effort` half is a stale pre-#3518 test-layout rewrite. Do **not** close it citing byte-identity. |

**Standing instruction for the implementer:** re-run the D-block `git log --oneline <plan-sha>..origin/dev` and
`gh pr view <n> --json headRefOid,mergeable,reviewDecision` immediately before each layer. This unit has observed
**three** dev moves and **two** PR head moves inside ~24h. Treat every SHA below as a checkpoint, not a fact.

---

## 1. Loop-spec header

**Archetype:** spec-satisfaction repair. Every item below has a written contract (a regression test, an
`AGENTS.md` invariant, a doc-comment, or an issue-reported behavior) that the tree currently fails to satisfy.
No item invents new product surface.

**Trigger:** wp1–wp4 complete or independently landed; this work-phase owns the residue of lane 004 plus the two
IMPLEMENT issues from lane 005.

**Goal:** land E0–E6 into `dev`, and close/defer the rest of the family with recorded evidence.

**Non-goals (do not do these in wp5):**

- No `main`/`preview` promotion, no release, no version bump.
- No repository-wide suite: **never** run bare `bun test` or `bun run test` for a scoped change.
- No `src/lab/` reachability from `src/router.ts`, `src/server/lifecycle.ts`, `src/server/responses/core.ts`.
- No auto-restart of a running service (E5 explicitly chooses the actionable-error route).
- No loosening of the Codex entitlement fail-closed gate (that is #3352, DEFER).
- Do not rewrite the #2960 regression test (E4) or the #3029 freshness assertions (E6).

**Verifier commands.** Each was executed against a `git archive origin/dev` export at `79e03643d`
(`/private/tmp/ocx-wp5-dev`, `node_modules` symlinked). All exist and are green **before** any change:

| Command | Exit | Result at `79e03643d` | Reads which change target |
|---|---|---|---|
| `bun test tests/routing/anthropic-quorum-cache.test.ts` | 0 | 6 pass / 0 fail | E0 removal test |
| `bun test tests/providers/kiro/kiro-stream.test.ts` | 0 | 113 pass / 0 fail | E1 fallback guard |
| `bun test tests/codex-integration/codex-catalog.test.ts` | 0 | 268 pass / 0 fail | E4 #2960 contract |
| `bun test tests/providers/provider-model-aliases.test.ts` | 0 | 7 pass / 0 fail | E4 alias routing |
| `bun test tests/codex-integration/codex-routing.test.ts` | 0 | 168 pass / 0 fail | E6 usage score / #3029 |
| `bun test tests/service/service.test.ts` | 0 | 193 pass / 0 fail | E5 launchd plist |
| `bun test tests/test-layout.test.ts` | 0 | 2 pass / 0 fail | **every new test file** (see 1.1) |
| `bun run typecheck` | 0 | strict `tsc --noEmit` | all `src/` layers |
| `bun run test:changed` | 0 | import-graph vs `dev` merge base | all layers |
| `bun run privacy:scan` | 0 | credential/privacy gate | E5, E6 (log lines) |
| `gh pr checks <n>` filtered to exact head | — | hosted cross-platform CI | every PR |

Existence proof for the two paths the lane docs cite at **stale** locations (both moved by #3518):

```
$ ls tests/ci-workflows/repo-hygiene.test.ts tests/server/management-route-registry.test.ts
tests/ci-workflows/repo-hygiene.test.ts
tests/server/management-route-registry.test.ts
```

### 1.1 The layout gate is a landmine for every new test file

`tests/test-layout.test.ts:20` fails when a `*.test.ts` file does not resolve to a domain. This is exactly what
made #3530's `test 1/4` go red. Resolution was probed through the repo's own resolver
(`scripts/test-layout/schema.ts` -> `resolveTarget`) for every filename this plan proposes:

```
codex-pool-502-exhaustion.test.ts        -> null      # WOULD FAIL CI
service-launchd-stable-launcher.test.ts  -> service   # ok
container-bootstrap.test.ts              -> null      # WOULD FAIL CI  (#3421 adds this name)
codex-catalog-antigravity-alias.test.ts  -> null      # WOULD FAIL CI
combos-cooldown.test.ts                  -> null      # WOULD FAIL CI
```

**Rule for this work-phase:** prefer extending an existing, already-mapped test file. When a new file is
unavoidable, add its basename to the `"explicit"` map in `scripts/test-layout/layout.json` **in the same commit**,
and place the file in the mapped directory. `resolveTarget` consults `explicit` first (`schema.ts:47`), so an
explicit entry always wins over the name-pattern fallbacks.

**Stop condition.** E0–E4 merged into `dev` with exact-head CI green and ancestry proven; E5 and E6 either merged
or, if security review is unavailable, left as open PRs with green CI and the review request recorded; every
DEFER/SUPERSEDED item has its comment posted. Ancestry proof per landing:

```
git fetch origin dev && git merge-base --is-ancestor <merge-sha> FETCH_HEAD
```

**Memory artifact.** This document plus the merge ledger in `060_closeout.md`. Every landing appends one row:
item, branch, PR, merge SHA, ancestry check exit, CI conclusion at exact head.

**Expected terminal outcomes.** 7 landings (E0–E6, of which E1–E4 carry contributor work and E5/E6 are new
maintainer implementations), 1 supersession closure (#3528), 4 deferrals (#3508, #3383, #2716, #3329) with
reasons recorded.

**Escalation.** Stop and report, do not improvise, when: (a) E6 or E3 needs a `MAINTAINERS.md` security review
that is not available; (b) any exact-head CI failure is not reproducible locally with a focused verifier; (c) a
contributor rebases a head mid-flight (already happened twice — D3, D4); (d) resolving #3329's
`src/server/responses/core.ts` conflict would require touching the `src/lab/` boundary.

---

## 2. Stack map (DEV-STACK-01..03)

The governing question is **shared files**, not thematic similarity. Measured overlap across the seven landings:

| File | E0 | E1 | E2 | E3 | E4 | E5 | E6 |
|---|---|---|---|---|---|---|---|
| `tests/routing/anthropic-quorum-cache.test.ts` | X | | | | | | |
| `tests/providers/kiro/kiro-stream.test.ts` | | X | | | | | |
| `docs-site/.../providers.md` (+7 locales) | | | X | | | | |
| `src/types/provider.ts` | | | X | | | | |
| `Dockerfile`, `compose.yaml`, `docker/` | | | | X | | | |
| `src/codex/catalog/sync.ts`, `src/router.ts`, `src/providers/{derive,registry}.ts` | | | | | X | | |
| `src/service.ts` | | | | | | X | |
| `src/codex/routing.ts`, `src/codex/quota.ts` | | | | | | | X |

**No file is shared by any two landings.** Therefore Stack E is not a stack: it is **seven independent PRs, all
targeting `dev` directly**, mergeable in any order and reviewable in parallel. Forcing them into a
`DEV-STACK-01..03` chain would create artificial rebase coupling with no shared-file justification, which is
precisely the failure mode `DEV-STACK` exists to avoid.

The one true ordering constraint is **E0 before E4**, and it is a review-semantics constraint rather than a file
one: both concern "a test that asserts less than its name claims", and landing E0 first makes the deletion story
of the #3516/#3518 reorg family coherent before E4 touches the #2960 contract. It costs nothing to honor.

### 2.1 Branch table

| Layer | Branch (`codex/260905-` prefix) | Base | Item | What it proves alone |
|---|---|---|---|---|
| E0 | `codex/260905-quorum-removal-contract` | `dev` | #3530 follow-up | The DELETE route's removal path is actually exercised, not just its cache invalidation. |
| E1 | `codex/260905-kiro-fallback-guard` | `dev` | #3487 REIMPLEMENT | The Kiro bounded completion fallback demonstrably fires, closing a false-confidence hole. |
| E2 | `codex/260905-omit-sentinel-docs` | `dev` | #2432 carry | `__omit__` is discoverable from the docs; no runtime change. |
| E3 | `codex/260905-docker-compose` | `dev` | #3421 carry | A container runtime-identical to the packaged artifact that binds loopback by default. |
| E4 | `codex/260905-antigravity-agy-alias` | `dev` | #3531 carry | `agy/` routes and relabels **without** displacing the #2960 effective-alias label. |
| E5 | `codex/260905-launchd-stable-launcher` | `dev` | #3464 IMPLEMENT | A launchd plist that survives a version-manager package swap. |
| E6 | `codex/260905-codex-pool-502-wedge` | `dev` | #3425 IMPLEMENT | A fresh 100% burst reading excludes an account without stranding a recovered one. |

### 2.2 Already-open PRs: merge directly, do not restack

**None of the wp5 items is LAND_AS_IS.** The lane's only LAND_AS_IS (#3323) belongs to another work-phase. Every
open PR here is LAND_WITH_FIX or REIMPLEMENT, so each needs a maintainer-authored commit and therefore a carried
branch. For completeness, the pre-merge sequence when a PR does reach as-is quality:

1. `gh pr view <n> --json headRefOid,mergeable,mergeStateStatus,reviewDecision` — confirm the head has not moved.
2. `gh pr ready <n>` if it is a draft.
3. Dismiss the stale review only when the finding is demonstrably addressed:
   `gh pr review <n> --dismiss -m "<reason>"` (a `CHANGES_REQUESTED` from a fixed finding otherwise blocks).
4. `gh pr checks <n>` — every required check green **on the exact head SHA**, not a previous run.
5. `gh pr merge <n> --squash --admin`, then the ancestry proof from section 1.

### 2.3 Carried contributor work — `Co-authored-by` is mandatory

`AGENTS.md` "Landing another author's work": a prose mention is read by nothing; the trailer is what GitHub reads.
`missing_coauthor_credit` in `.github/scripts/pr-carry-attribution.cjs` enforces it. Emails read from
`gh pr view <n> --json commits` at plan time:

| Layer | PR | Author login | Trailer to place in a branch commit (survives squash) |
|---|---|---|---|
| E1 | #3487 | `Ingwannu` | `Co-authored-by: Ingwannu <ingwannu@users.noreply.github.com>` |
| E2 | #2432 | `mdwsk88` | `Co-authored-by: mdwsk88 <924038395@qq.com>` |
| E3 | #3421 | `Skyline-23` | `Co-authored-by: Skyline-23 <flight@skyline23.com>` |
| E4 | #3531 | `benedictusrey` | `Co-authored-by: benedictusrey888 <hartanto.benedictus.reynaldo.w0@s.mail.nagoya-u.ac.jp>` |

Note for E4: the PR author is displayed as `benedictusrey` but the **commit** author is `benedictusrey888` with the
Nagoya University address. Use the commit identity — that is what the contributor graph keys on.

For #3329 (deferred in section 6, not landed here) the commit authorship is `" " <wj@nas-backup>` plus
`claude <noreply@anthropic.com>` — an empty display name and a machine address. If it is ever carried, resolve the
human identity with the author first; do not invent one.

Branch creation for a carry:

```bash
git fetch origin pull/<n>/head:pr-<n>
git checkout -b codex/260905-<slug> origin/dev
git cherry-pick <sha>          # or apply the hunks by hand when the path moved
# then the maintainer fix commit, carrying the trailer
```

Push with `--no-verify` (the pre-push hook runs the forbidden repository-wide suite).

---

## 3. Per-item plans

### E0 — #3530 follow-up: the removal test that never removes

**Disposition:** new maintainer PR. #3530 **merged** as `6580694c7` with this High finding unaddressed; verified by
reading the merged file on `dev`, not the PR diff.

**File change map.**

`tests/routing/anthropic-quorum-cache.test.ts:122-134` — current code on `dev`:

```ts
  test("removing an account invalidates immediately, not after the TTL", async () => {
    // The management DELETE route calls clearAnthropicSessionAffinityForAccount for Anthropic.
    // Without invalidation there, deleting the second account would leave quorum true for up to
    // 2s -- long enough for a request to record an id whose credential is already gone.
    const start = Date.now();
    const ids = await seed(2);
    expect(hasAnthropicFailoverQuorum(start)).toBe(true);
    clearAnthropicSessionAffinityForAccount(ids[1]!);
    markStoreUnread();
    hasAnthropicFailoverQuorum(start + 1);
    expect(storeWasRead()).toBe(true);
  });
```

Target code:

```ts
  test("removing an account invalidates immediately, not after the TTL", async () => {
    // Mirror the real DELETE route: src/server/management/oauth-account-routes.ts removes the
    // credential FIRST (:550, removeAccount) and only then clears routing state (:553-554).
    // Clearing affinity alone leaves the roster at 2, so the predicate cannot observe the
    // transition this test is named for -- it could only ever assert that the store was re-read.
    const start = Date.now();
    const ids = await seed(2);
    expect(hasAnthropicFailoverQuorum(start)).toBe(true);
    expect(await removeAccount("anthropic", ids[1]!)).toBe(true);
    clearAnthropicSessionAffinityForAccount(ids[1]!);
    markStoreUnread();
    expect(hasAnthropicFailoverQuorum(start + 1)).toBe(false);
    expect(storeWasRead()).toBe(true);
  });
```

Import change at `tests/routing/anthropic-quorum-cache.test.ts:27`:

```ts
-import { getAccountSet, saveCredential } from "../../src/oauth/store";
+import { getAccountSet, removeAccount, saveCredential } from "../../src/oauth/store";
```

Signature verified: `src/oauth/store.ts:899` — `export async function removeAccount(provider: string, accountId: string): Promise<boolean>`.
Route order verified: `oauth-account-routes.ts:550` `removeAccount(provider, id)`, then `:553-554`
`clearAnthropicAccountCooldown` / `clearAnthropicSessionAffinityForAccount`.

**Conflict recipe:** none. `dev` owns this file as of `6580694c7`; nothing else in wp5 touches it.

**Regression test.** The changed test *is* the regression. RED-on-dev demonstration: with the current body,
deleting the `removeAccount` call from the route would leave the test green — that is the defect. After the change,
the added `expect(hasAnthropicFailoverQuorum(start + 1)).toBe(false)` fails if the roster is not actually reduced.
Drive it red once by commenting out the `removeAccount` line and confirming the new assertion fails; that proof is
required before commit, the same discipline #3530's own hygiene guard used.

**Focused verifier:** `bun test tests/routing/anthropic-quorum-cache.test.ts` — 6 pass / 0 fail on dev today;
must stay 6 pass after the change.

**Accept criteria (C-ACTIVATION-GROUNDING-01).** Two paths, both grounded in a scenario:

- *Removal path active*: 2 accounts seeded -> `removeAccount` returns `true` -> roster is 1 -> quorum `false`,
  store re-read `true`.
- *Removal path inactive* (unchanged-behavior guard): the sibling test "a manual account selection invalidates
  immediately" (`:136-147`) still passes with 2 accounts intact, proving the new assertion did not simply make
  every path return `false`.

**Docs-site sync:** none — test-only.

**PR skeleton.**

```
title: test(oauth): exercise the account-removal path the quorum test is named for

## Summary
#3530 restored the quorum cache contract test, and its removal case asserts the store was
re-read but never removes the credential -- so the roster is unchanged and the transition the
test is named for cannot be observed. Mirror the DELETE route: removeAccount first, then the
routing cleanup, and assert quorum actually drops.

## Verification
- bun test tests/routing/anthropic-quorum-cache.test.ts (6 pass / 0 fail)
- Driven red by removing the removeAccount call before committing.
- bun run typecheck

## Checklist
- [x] Focused tests pass
- [x] No repository-wide suite run
- [x] No docs-site change needed (test-only)

Follows up #3530.
```

---

### E1 — #3487 REIMPLEMENT: prove the Kiro bounded fallback runs

**Disposition:** REIMPLEMENT. The PR is `CONFLICTING`/`DIRTY` only because it names `tests/kiro-stream.test.ts`,
a path deleted by the reorg. Applying it as-is would resurrect a deleted file and fail `tests/test-layout.test.ts`.

**File change map.** Target is `tests/providers/kiro/kiro-stream.test.ts:1723` (line re-verified at `79e03643d`;
the same string also occurs at `:313` and `:333` — **do not** patch those, they belong to a different test).

Current code, inside `test("an attempt that falls back to the completion retry does not calibrate")`:

```ts
    resetKiroCalibration();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(streamOf(eventFrame({ content: "Final from fallback." })))) as typeof fetch;
    try {
```

Target code:

```ts
    resetKiroCalibration();
    const originalFetch = globalThis.fetch;
    // Observe the stub, do not merely install it. The assertion below is that the estimate did
    // not move -- which stays true if the bounded fallback silently stopped firing at all. The
    // counter is what separates "did not calibrate" from "did not run".
    let fallbackCalls = 0;
    globalThis.fetch = (async () => {
      fallbackCalls += 1;
      return new Response(streamOf(eventFrame({ content: "Final from fallback." })));
    }) as typeof fetch;
    try {
```

and after the `finally` block restores `globalThis.fetch` (before the `after` adapter is constructed):

```ts
    expect(fallbackCalls).toBe(1);
```

**Conflict recipe:** mechanical, path-only. Do **not** `git cherry-pick` — the source path does not exist. Apply
the hunk by hand to the new path, then commit with the `Ingwannu` trailer.

**Regression test.** Honestly characterized: this is **not** RED on dev, because the fallback does fire today. It
is a guard against silent regression, the correct shape for a REVIEW-REGRESS-01 defect. Proof that the guard has
teeth: stub the Kiro completion path to a no-op and confirm `expect(fallbackCalls).toBe(1)` fails while the
pre-existing `expect(afterEstimate).toBe(baseline)` still passes — that divergence is the whole argument for the
change and belongs in the PR body.

**Focused verifier:** `bun test tests/providers/kiro/kiro-stream.test.ts` — 113 pass / 0 fail on dev; must stay
113 pass with one added `expect()` call.

**Accept criteria (C-ACTIVATION-GROUNDING-01).**

- *Fallback active*: tool-carrying request with a context percentage and no private completion call ->
  `fallbackCalls === 1` and calibration unchanged.
- *Fallback inactive*: the sibling non-fallback calibration tests in the same describe block are untouched and
  still pass, proving the counter did not leak into the ordinary path.

**Docs-site sync:** none.

**PR skeleton.**

```
title: test(kiro): prove the bounded completion fallback actually runs

## Summary
The fallback test asserts only that the calibration estimate did not move, which stays true if
the bounded fallback stopped firing entirely -- a false-confidence hole. Count the stubbed
fetch and assert it ran exactly once. Reimplementation of #3487 at the post-reorg path: the
original patch targets tests/kiro-stream.test.ts, deleted by #3516/#3518.

## Verification
- bun test tests/providers/kiro/kiro-stream.test.ts (113 pass / 0 fail)
- bun run typecheck

## Checklist
- [x] Focused tests pass
- [x] Original authorship preserved via trailer

Closes #3487.

Co-authored-by: Ingwannu <ingwannu@users.noreply.github.com>
```

---

### E2 — #2432 carry: document the `__omit__` sentinel

**Disposition:** LAND_WITH_FIX, carried (88+ commits behind, mechanical locale conflicts).

**File change map.**

1. `docs-site/src/content/docs/reference/configuration/providers.md:114` — current row:

```md
| `reasoningEffortMap?` | `Record<string, string>` | Provider-wide wire aliases for reasoning labels. |
```

   Target: extend that row (and the `modelReasoningEffortMap?` row at `:115`) to name the sentinel and say
   **which wire field** it suppresses:

```md
| `reasoningEffortMap?` | `Record<string, string>` | Provider-wide wire aliases for reasoning labels. The reserved value `__omit__` drops the field from the upstream request entirely — `reasoning_effort` on an OpenAI-compatible wire, and Ollama's native `think` field on the Ollama native adapter (#2356). |
```

2. Mirror into the seven locales, all verified present:
   `docs-site/src/content/docs/{fr,ja,ko,ru,tr,zh-cn,zh-tw}/reference/configuration/providers.md`.
   Per the lane's CodeRabbit finding, ja/ko/ru/tr must carry the OpenAI-vs-Ollama wire distinction, not a generic
   "omit" verb.

3. `src/types/provider.ts` doc-comment — **apply the lane's fix**: the PR's comment references
   `REASONING_EFFORT_OMIT_SENTINEL`, which this file does not import. Verified: no such import exists in
   `src/types/provider.ts`, and the constant lives at `src/reasoning-effort.ts:21`. Use the literal plus a file
   reference. Current line `src/types/provider.ts:174` area carries `alias?: string;` and its neighbors; the
   sentinel comment attaches to the `reasoningEffortMap` declaration:

```ts
  /** Provider-wide wire aliases for reasoning labels. The reserved value `"__omit__"` drops the
   *  field from the upstream request (see `REASONING_EFFORT_OMIT_SENTINEL` in src/reasoning-effort.ts). */
```

**Conflict recipe:** mechanical. Every hunk is a two-line table-row replacement across eight files. Do not
cherry-pick the stale branch; re-apply the eight rows onto current `dev`, which is faster and avoids resurrecting
pre-reorg context.

**Regression test:** none warranted, and that is the correct call — docs plus two doc-comments, zero runtime
change. The behavior is already covered by the adapter tests for #2356. Do not manufacture a test to satisfy a
checklist.

**Focused verifier:** `bun run typecheck` (it is still a `.ts` edit) plus an exact-head `docs-site` build. The lane
records an isolated docs build passing at 393 pages; re-run it on the rebased head.

**Accept criteria (C-ACTIVATION-GROUNDING-01).** The conditional path here is the sentinel itself:

- *Sentinel active*: `reasoningEffortMap = { high: "__omit__" }` -> field absent from the upstream body
  (`isReasoningEffortOmitted`, `src/reasoning-effort.ts:23-25`).
- *Sentinel inactive*: any other string maps normally.
  Both must be readable from the documentation row alone — that is the acceptance bar for a docs change.

**Docs-site sync:** this item *is* the docs sync. English is the source; the seven locales must not contradict it.

**PR skeleton.**

```
title: docs: document the `__omit__` reasoning-effort wire sentinel

## Summary
REASONING_EFFORT_OMIT_SENTINEL (src/reasoning-effort.ts:21) is load-bearing and undiscoverable:
the providers reference described reasoningEffortMap only as "wire aliases for reasoning
labels". Document the sentinel in English and seven locales, naming which wire field it
suppresses on each adapter.

## Verification
- Exact-head docs-site build
- bun run typecheck

## Checklist
- [x] Docs updated (English source + 7 locales)
- [x] No runtime change, so no regression test

Closes #2432.

Co-authored-by: mdwsk88 <924038395@qq.com>
```

---

### E3 — #3421 carry: Docker Compose, made runtime-identical and loopback by default

**Disposition:** LAND_WITH_FIX, carried. `MERGEABLE` today (no file overlap with `dev` churn), but it carries a
routing-behavior regression and a security-boundary default.

**File change map.**

1. **Runtime identity [High].** `.dockerignore:9` excludes `src/generated/compatibility-version.json`, and the
   Dockerfile copies `src` without running the package generator. The runtime is documented fail-closed at
   `src/routing/compatibility/version.ts:80` — "There is intentionally no runtime-only fallback" —
   `readOpenCodexCompatibilityVersion()` returns `null` (`:91`) and `src/routing/compatibility/subject.ts:96` then
   returns early with bare `subjectIds`. **This is a routing difference, not missing metadata.**
   Fix: run the package-owned generator during the image build (`scripts/prepare-package.ts:4` imports
   `generateCompatibilityVersionManifest`) and copy the result into the runtime stage. **Do not commit a generated
   file** — a stale manifest is worse than an absent one.

2. **Bind default [High, security boundary].** `compose.yaml:13`:

```yaml
-      - "${OPENCODEX_PORT:-10100}:10100"
+      - "${OPENCODEX_BIND_ADDRESS:-127.0.0.1}:${OPENCODEX_PORT:-10100}:10100"
```

   `"${PORT}:10100"` publishes on `0.0.0.0` of the Docker host. Loopback is the correct default for a local Docker
   Desktop deployment; document the opt-in to `0.0.0.0` or a LAN/Tailscale address for remote-hub use.

3. **Docs token path [Medium].** `docs-site/src/content/docs/guides/remote-hub.md:175` reads the token from
   `/run/secrets/ocx_api_token` while the bootstrap step uses the canonical `ocx-state` volume path. Fix the
   English source and the six mirrored locales in the PR's file list (`fr,ja,ko,ru,tr,zh-cn,zh-tw`).

**Conflict recipe:** none textually — `git merge-tree` reports only `added in remote`. Rebase onto current `dev`
and re-run CI; the conflict risk is zero and the CI risk is total (intake-only checks so far).

**Regression tests.**

- Existing: `tests/container-bootstrap.test.ts` (+32) covers `docker/bootstrap-token.ts` — chunked input, exact
  4096-byte maximum, rejection of empty/multiline/oversized input. RED on dev only in the new-file sense.
  **Layout gate:** `resolveTarget(layout, "container-bootstrap.test.ts")` returns **`null`** (probed). This file
  **will fail `tests/test-layout.test.ts`** unless its basename is added to the `"explicit"` map in
  `scripts/test-layout/layout.json` in the same commit. Suggested mapping:
  `"container-bootstrap.test.ts": "service"`, matching the existing `tests/service/service-probe-docker.test.ts`
  neighbor; place the file at `tests/service/container-bootstrap.test.ts`.
- **Missing, must be added:** nothing asserts container runtime identity. Add a runtime-stage assertion that
  `readOpenCodexCompatibilityVersion()` returns a valid SHA-256 value, so a future Dockerfile edit that drops the
  generator fails the build rather than silently changing routing.

**Focused verifier:** `bun test tests/service/container-bootstrap.test.ts`, `bun test tests/test-layout.test.ts`,
`bun run typecheck`, plus an exact-head container build and full cross-platform CI.

**Accept criteria (C-ACTIVATION-GROUNDING-01).** Three conditional paths, each with a stated scenario:

- *Manifest present* (fixed build): `readOpenCodexCompatibilityVersion()` non-null -> `subject.ts` resolves the
  full subject -> container routes identically to an npm install.
- *Manifest absent* (today's build): returns `null` -> bare `subjectIds` -> unknown-evidence policy. The new
  build-stage assertion must make this state unreachable in a shipped image.
- *Bind override*: unset `OPENCODEX_BIND_ADDRESS` -> `127.0.0.1`; explicitly set to `0.0.0.0` -> published on all
  interfaces, which the remote-hub guide must describe as a deliberate opt-in.

**Docs-site sync:** `guides/remote-hub.md` English + 6 locales (token path, and the new bind-address opt-in).

**Security boundary:** **yes.** Deployment surface and token handling -> `AGENTS.md`/`MAINTAINERS.md` explicit
security review required before merge. Flag in the PR body; do not self-approve.

**PR skeleton.**

```
title: feat(docker): Compose deployment with runtime-identical image and loopback default

## Summary
Carries #3421 with two fixes. The image excluded src/generated/compatibility-version.json and
never ran the package generator, so readOpenCodexCompatibilityVersion() returned null and
live-route subject resolution fell back to bare subjectIds -- a routing difference from every
other install, not merely absent metadata. Compose also published the data port on all host
interfaces; the default is now loopback with a documented opt-in.

## Verification
- bun test tests/service/container-bootstrap.test.ts
- bun test tests/test-layout.test.ts
- Exact-head container build + cross-platform CI

## Checklist
- [x] Security review requested (deployment + token handling)
- [x] Docs updated (remote-hub token path, bind opt-in)
- [x] New test basename registered in scripts/test-layout/layout.json

Closes #3421.

Co-authored-by: Skyline-23 <flight@skyline23.com>
```

---

### E4 — #3531 carry: `agy` alias without displacing the #2960 label

**This item changed materially since the lane doc (D3). Read this section, not the lane's fix list.**

**Disposition:** LAND_WITH_FIX, carried — but the headline blocker is already resolved by the author.

**What I verified, by execution rather than reading.** The lane reports the PR breaking
`codex-catalog.test.ts:2286` ("the issue reproduction uses the effective model alias for the picker label", added
by `0892b99d7` for #2960). I reproduced both heads against `origin/dev` exports:

| Head | `src/providers/derive.ts` content | `bun test ... -t "effective model alias"` |
|---|---|---|
| `f486b5d60` (lane's head) | seed **+ `enrichProviderFromRegistry` backfill** of `prov.alias` | **1 fail** — `Expected "google-antigravity/gemini-3.7", Received "agy/gemini-3.7"` |
| `e5137f6f2` (current head) | seed **only** | **2 pass / 0 fail** |

Full current-head diff applied to a `79e03643d` export:
`bun test tests/codex-integration/codex-catalog.test.ts tests/providers/provider-model-aliases.test.ts`
-> **279 pass / 0 fail**.

**The mechanism, which the lane doc did not isolate.** The `sync.ts` early return is *not* what broke #2960. I
applied that hunk alone to a clean dev export: **268 pass / 0 fail**. The breakage came from the extra line the
author has since removed:

```ts
  // f486b5d60 only, inside enrichProviderFromRegistry:
  if (prov.alias === undefined && seed.alias !== undefined) prov.alias = seed.alias;
```

That backfill made the registry alias visible to the **#2960 display path**, which composes the label as
`${provider.alias || name}/${alias}` (`src/codex/catalog/provider-fetch.ts:2444`). With `prov.alias === "agy"` the
effective-alias label became `agy/gemini-3.7` instead of `google-antigravity/gemini-3.7`. So the label
contradiction the brief asks me to resolve **is exactly the "route through model-alias display" question**, and
the current head resolves it by *not* letting the registry alias reach that path.

**Remaining blockers (both still live at `e5137f6f2`).**

1. **[Medium] The two display paths now disagree by construction.** `routedDisplayName` returns `agy/<model>`
   (`sync.ts:277-279`), while the #2960 alias path still emits `google-antigravity/<alias>` because
   `provider.alias` is unset there. A user with `modelAliases` configured sees the long prefix; a user without
   sees `agy/`. That is defensible (configured aliases win) but it is **undocumented and untested**. Add the
   regression the lane asked for: Antigravity **with** a `modelAliases` entry, pinning
   `google-antigravity/gemini-3.7`, adjacent to the existing #2960 test at `:2286` so the coupling is visible to
   the next editor.
2. **[Medium] The doc-comment contract is now false.** `src/codex/catalog/sync.ts:265-271` states "All other
   providers keep the raw slug exactly as before." The change adds a second provider-specific rule without
   updating that sentence. Current text to replace:

```ts
 * The model-id portion also carries a redundant `<vendor>-` prefix (`deepseek-deepseek-v4-flash`)
 * that is dropped for display. All other providers keep the raw slug exactly as before.
```

   Target:

```ts
 * The model-id portion also carries a redundant `<vendor>-` prefix (`deepseek-deepseek-v4-flash`)
 * that is dropped for display. Google Antigravity is relabeled to the compact `agy/` prefix for the
 * same reason: `google-antigravity/` alone consumes most of the picker row. This is the raw-slug
 * path only -- a configured `modelAliases` entry is labeled by the effective-alias path in
 * catalog/provider-fetch.ts (#2960) and keeps the canonical provider name. All other providers
 * keep the raw slug exactly as before.
```

3. **[Low] The early return still bypasses later display rules.** Harmless today (the only later rule is the
   Command Code branch, which cannot match `google-antigravity`), so this is a readability preference, not a
   correctness blocker. Optional: convert to `if (provider === "google-antigravity") model = ...` composition.
   **Do not** treat this as required — the lane's High rating was driven by the #2960 failure, which is gone.

**Field/enum chain — `ProviderRegistryEntry.alias`.** See section 4; this is the only new config field in wp5 and
its chain is deliberately truncated.

**Conflict recipe:** none. Merge-base is `0f27bbeb3`; a rebase onto `79e03643d` is clean (no wp5-adjacent file
moved). Verified by applying the head diff to a `79e03643d` export with `git apply` — clean, tests green.

**Regression tests.** Existing on the head: `tests/providers/provider-model-aliases.test.ts` (+105) — `agy/`
resolution, case-insensitivity (`AGY/`), canonical name preserved, user-defined alias overriding the built-in, and
**ambiguity across insertion order in both directions** (the strongest assertion in the change). RED on dev: no
`alias: "agy"` in the registry. Plus `codex-catalog.test.ts` (+15) for the compact label.
**To add:** the `modelAliases`-present case from blocker 1.

**Focused verifier:**
`bun test tests/codex-integration/codex-catalog.test.ts tests/providers/provider-model-aliases.test.ts`
— 279 pass / 0 fail on the current head; must stay green with the added case.

**Accept criteria (C-ACTIVATION-GROUNDING-01).** Four conditional paths, each with a scenario:

- *Registry alias active, no user alias*: `agy/gemini-3.8-flash` routes to `google-antigravity`; picker shows
  `agy/gemini-3.8-flash`.
- *User alias configured*: `alias: "antigrav"` -> **both** `antigrav/` and `agy/` route (additive fallback).
- *Ambiguous alias*: a second provider explicitly configured with `alias: "agy"` wins over the registry fallback,
  **independent of object insertion order** — both orders asserted.
- *`modelAliases` configured* (the #2960 path): label stays `google-antigravity/gemini-3.7`. This is the case that
  broke on the previous head and the one the new test must pin.

**Docs-site sync:** if any locale documents provider namespaces for Antigravity, add `agy`. Check
`rg -n "google-antigravity" docs-site/` before opening; do not assume.

**PR skeleton.**

```
title: feat(catalog,providers): compact `agy` alias for google-antigravity

## Summary
Adds a built-in `agy` namespace for google-antigravity: routing accepts `agy/<model>`
case-insensitively, and the Codex picker relabels raw routed slugs. Configured provider
aliases still win, and the registry fallback applies only when unambiguous.

The label question is settled explicitly: a provider with a configured `modelAliases` entry
keeps the canonical `google-antigravity/<alias>` label from #2960, because the registry alias
is deliberately NOT backfilled onto the runtime provider row. A regression test pins that.

## Verification
- bun test tests/codex-integration/codex-catalog.test.ts tests/providers/provider-model-aliases.test.ts (279 pass / 0 fail)
- bun run typecheck

## Checklist
- [x] Focused tests pass
- [x] #2960 regression test unchanged and still green

Closes #3531. Supersedes the alias half of #3528.

Co-authored-by: benedictusrey888 <hartanto.benedictus.reynaldo.w0@s.mail.nagoya-u.ac.jp>
```

---

### E5 — #3464 IMPLEMENT: launchd survives a mise package swap

**Disposition:** IMPLEMENT. No open PR. macOS counterpart to the resolved Linux/mise issue #2898.

**Defect, re-verified on `79e03643d`.** `cliEntry()` (`src/service.ts:66-73`) resolves both the Bun runtime and the
CLI entry from `import.meta.dir` — i.e. **inside the installed package tree**. `buildPlist()` (`:489-490`) calls it
and bakes the pair into the plist via `buildServiceShellCommand(bun, cli)` (`:556-559`).

The repair already exists **for systemd only**. `stableLauncherEntry()` (`:95-117`) finds an absolute `ocx` on
`PATH` lexically, and its doc-comment (`:77-94`) describes this exact failure: "Under a version manager that tree
is a versioned directory ... An upgrade installs 2.36.0 and deletes 2.35.0". `buildServiceLauncherShellCommand()`
(`:567-570`) already builds the launcher-shaped command. `installSystemd()` (`:3361`) uses both. Verified by
`rg -n "stableLauncherEntry" src/`: exactly two hits, the definition and the systemd caller.
**`buildPlist` and `installLaunchd` never call it.** That asymmetry is the whole bug.

**File change map (`src/service.ts`).**

1. `buildPlist()` at `:489` — accept an injected launcher exactly as `buildUnit()` does (`:3268-3271`):

```ts
-export function buildPlist(proxyEnv: { name: string; value: string }[] = resolvedProxyEnv()): string {
-  const { bun, bunRuntimeSource, cli } = cliEntry();
+export function buildPlist(
+  proxyEnv: { name: string; value: string }[] = resolvedProxyEnv(),
+  deps: { launcher?: string | null } = {},
+): string {
+  const { bun, bunRuntimeSource, cli } = cliEntry();
+  const launcher = deps.launcher ?? null;
```

   and at `:511`:

```ts
-  const command = buildServiceShellCommand(bun, cli);
+  const command = launcher
+    ? buildServiceLauncherShellCommand(launcher)
+    : buildServiceShellCommand(bun, cli);
```

   When `launcher` is set, omit the two Bun-runtime env keys, mirroring `buildUnit`'s `...(launcher ? [] : [...])`
   at `:3285-3288` — a baked `OCX_BUN_RUNTIME_PATH` pointing into the deleted versioned tree is the same stale-path
   bug in a different key.

2. `installLaunchd()` at `:2244` — resolve **once** and pass the same value to both the plist and install state,
   exactly as `installSystemd()` does (`:3358-3366`), so the staleness check cannot validate a path the job does
   not run:

```ts
-  writeServiceDefinitionFile(p, buildPlist(), "utf8");
+  const launcher = stableLauncherEntry();
+  writeServiceDefinitionFile(p, buildPlist(resolvedProxyEnv(), { launcher }), "utf8");
```

   and the matching `writeServiceInstallState("scheduler", launcher)` (the parameter already exists at `:238` and
   is recorded as `launcherPath` at `:246`).

3. **Skew becomes actionable, not auto-repairing.** Per the lane's explicit recommendation and the non-goals in
   section 1: on detected skew, surface an actionable error naming `opencodex service restart` — the reporter
   confirmed that single command fully repaired the state. **Do not auto-restart**: restarting a service
   mid-request is a larger behavioral change than this issue authorizes.

**Conflict recipe:** none — new work on a file untouched by `0f27bbeb3..79e03643d` (verified by path-filtered
`git log`, empty output). Semantic care only: `src/service.ts` is also implicated by #3320 (DEFER), so nothing
competes for it in this work-phase.

**Regression tests.** Extend `tests/service/service.test.ts` — it already imports `stableLauncherEntry`,
`buildPlist`, and `buildUnit` (`:10`), and already has a shim-resolution case at `:1211`. **Prefer this over a new
file**: a new basename such as `service-launchd-stable-launcher.test.ts` does resolve (`-> service`, probed) but
adds layout surface for no benefit.

- `"the launchd plist runs the stable launcher when one is on PATH"` — RED on dev: `buildPlist` takes no launcher
  argument, so the test cannot compile against `dev`; after the change it asserts the plist `ProgramArguments`
  string contains the launcher and **not** the versioned `import.meta.dir` CLI path.
- `"a launchd install with no stable launcher keeps the Bun + CLI pair"` — the inactive branch.
- Mirror the systemd single-resolution assertion at `:387-391`
  (`expect(installLaunchd.match(/stableLauncherEntry\(\)/g)).toHaveLength(1)`) so the plist and the install state
  can never disagree.

**Focused verifier:** `bun test tests/service/service.test.ts` — 193 pass / 0 fail on dev; plus `bun run typecheck`
and `bun run privacy:scan` (the new error message must name a command, never a token or account id).

**Accept criteria (C-ACTIVATION-GROUNDING-01).**

- *Launcher found*: `PATH` contains an absolute executable `ocx` -> plist execs the launcher; Bun-runtime env keys
  omitted; install state records `launcherPath`.
- *Launcher absent*: no `ocx` on `PATH` -> unchanged Bun + CLI pair, both env keys present. The existing 193 tests
  cover this and must stay green.
- *Relative `PATH` entry*: rejected — `stableLauncherEntry` accepts only absolute paths (`:112`), because a bare
  `ocx` re-resolved on every restart turns a service definition into a PATH-hijacking surface. Assert this
  explicitly; it is a security property, not a detail.
- *Skew detected*: actionable error naming `opencodex service restart`; **no** automatic restart.

**Docs-site sync:** if a macOS service guide documents the baked plist command, note the launcher indirection.
Run `rg -n "LaunchAgents|com.opencodex.proxy" docs-site/` before opening.

**Security boundary:** partial. Not auth/OAuth/CORS/workflows, but `stableLauncherEntry`'s absolute-path rule is a
PATH-hijacking guard. Call it out in the PR body so a reviewer checks it deliberately rather than as a diff detail.

**PR skeleton.**

```
title: fix(service): bake the stable ocx launcher into the launchd plist

## Summary
cliEntry() resolves Bun and the CLI from import.meta.dir, so the launchd plist names paths
inside the versioned package tree. Under mise/asdf an upgrade replaces that tree; the old
proxy keeps serving from the retained old package (#3464), which is how a stale 2.10.1
proxy kept answering for a 2.42.0 CLI. systemd already avoids this via stableLauncherEntry();
launchd never called it. Resolve once in installLaunchd and pass the same value to both the
plist and the install state, so the staleness check cannot validate a path the job does not run.

## Verification
- bun test tests/service/service.test.ts
- bun run typecheck
- bun run privacy:scan

## Checklist
- [x] Focused tests pass
- [x] No auto-restart of a running service
- [x] Launcher must be an absolute path (PATH-hijacking guard asserted)

Closes #3464.
```

---

### E6 — #3425 IMPLEMENT: a fresh 100% burst window must exclude the account

**Disposition:** IMPLEMENT. No open PR owns this path — #3502 is Anthropic OAuth, #3529 is API-key failover;
neither touches the Codex ChatGPT account pool.

**Defect, re-verified on `79e03643d`. Two reinforcing mechanisms.**

*Mechanism 1.* `isTerminalShortWindow()` (`src/codex/routing.ts:408-422`) returns `false` unless `shortResetAt` is
finite, positive, and still in the future (`:415-421`). A snapshot with `shortPercent: 100` and a missing
`shortResetAt` therefore scores `CODEX_UNKNOWN_USAGE_SCORE` (`= 101`, `src/codex/quota.ts:112`) at `:387`, and
admission predicates treat `>= 101` as selectable (`src/codex/auth-context.ts:70`).

*Mechanism 2.* `502` is in `TRANSIENT_SERVER_STATUSES` (`src/codex/quota-rejection.ts:101`) and returns
`transient-server-error` at `:283` — **before** the 429/402 quota branch at `:284`. A quota exhaustion wrapped in a
bare 502 produces no quota signal at all, matching the reporter's `sendCount: 1` and empty `recoveryKinds`.

Together: the snapshot says 100% but cannot exclude, the 502s say nothing, and the pool wedges — 118 consecutive
502s over 23 minutes while account B sat at 3%.

**The constraint that makes this hard, and must not be broken.** `tests/codex-integration/codex-routing.test.ts:143`
("a full burst window scores terminal while it is still in force (#3029)") pins the **opposite** direction at
`:159`:

```ts
    // No resetAt at all cannot be aged, so it stays unknown: a wrongly-selected account
    // fails one request, a wrongly-excluded one is invisible until someone reads the pool.
    expect(computeCodexUsageScore({ shortPercent: 100 }, undefined, now)).toBe(CODEX_UNKNOWN_USAGE_SCORE);
```

This is a deliberate trade documented at `routing.ts:395-407`, and #3425 is what it looks like when it goes wrong.

**File change map — resolve the contradiction with freshness, not by inverting the rule.**

The missing input is *age*, and it already exists: `StoredAccountQuota.updatedAt` (`src/codex/quota.ts:36`, set to
`Date.now()` at `:281` and `:456`), with disk hydration already rejecting rows older than
`QUOTA_DISK_MAX_AGE_MS = 6h` (`:42`, `:491`). The reason `:159` says "cannot be aged" is that
`computeCodexUsageScore`'s parameter type (`routing.ts:363-368`) simply does not carry `updatedAt`.

1. Widen the accepted shape at `routing.ts:363-368` with an **optional** `updatedAt?: number`.
2. Extend `isTerminalShortWindow` (`:408-422`) with a second admission route:

```ts
  const resetAt = quota.shortResetAt;
  if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= 0) {
    // #3425: a reading with no reset timestamp cannot be aged BY ITS RESET -- but it can be
    // aged by its observation time. A 100% window observed seconds ago is a measured refusal,
    // and leaving it selectable wedges the pool on it (118 consecutive 502s over 23 minutes).
    // Freshness, not reset presence, is what keeps #3029 safe in both directions: a stale
    // reading still falls back to unknown and a recovered account is never stranded.
    const observedAt = quota.updatedAt;
    if (typeof observedAt !== "number" || !Number.isFinite(observedAt)) return false;
    return now - observedAt <= TERMINAL_SHORT_WINDOW_FRESHNESS_MS;
  }
```

   with `TERMINAL_SHORT_WINDOW_FRESHNESS_MS` a new exported constant, deliberately **much** tighter than the 6h
   disk horizon. Recommend `5 * 60_000`: shorter than any plausible 5h burst window, long enough that a snapshot
   taken at admission is still fresh at selection.

   **This keeps `:159` green unchanged**, because that call passes no `updatedAt` — a bare `{ shortPercent: 100 }`
   literal still returns unknown. That is the property that makes the contradiction resolvable without rewriting a
   #3029 assertion.

3. **Affinity release [second half].** Clear or re-evaluate sticky affinity after a bounded run of consecutive
   failures on one account, so a 502 storm cannot pin the pool even when no quota signal is produced. Keep
   post-200 `streamAborted` terminal as today.

**Explicitly not doing:** reclassifying 502 out of `TRANSIENT_SERVER_STATUSES`. A 502 genuinely is transient in the
general case; demoting every one would strand accounts on ordinary gateway blips. The bounded-consecutive-failure
release in (3) addresses the storm without that collateral.

**Conflict recipe:** none — `src/codex/routing.ts` and `src/codex/quota.ts` are untouched in
`0f27bbeb3..79e03643d` (verified, empty path-filtered log).

**Regression tests.** Extend `tests/codex-integration/codex-routing.test.ts` — it already owns the #3029 block
(`:143-173`) and the live-selection cases (`:176-232`) with `setAccountQuotaFromParsed` helpers.

- `"a fresh full burst window with no reset timestamp still excludes the account (#3425)"` — RED on dev: today
  `{ shortPercent: 100, updatedAt: now }` scores `101`; after the change it scores `100`.
- `"a stale full burst window with no reset timestamp stays unknown (#3029)"` — the opposite-direction guard:
  `updatedAt: now - 6 * 60_000` -> `CODEX_UNKNOWN_USAGE_SCORE`. **This test is what proves the fix did not invert
  #3029**, and it is non-negotiable.
- `"a 502 storm does not pin the pool to an exhausted account (#3425)"` — account A `shortPercent: 100` with a
  fresh `updatedAt` and no `shortResetAt`, account B healthy, threshold 80, multiple admissions -> new admissions
  select B.
- `"a bare 502 does not override a fresh snapshot"` — asserts the 502 classification is unchanged and the
  exclusion comes from the snapshot, not from reclassifying the status.

**Focused verifier:** `bun test tests/codex-integration/codex-routing.test.ts` — 168 pass / 0 fail on dev; must
stay green with ~4 added cases, **including the untouched `:143` #3029 block**. Also
`bun test tests/codex-integration/codex-quota-rejection.test.ts` (proves 502 classification is unchanged) and
`bun run test:changed` (`src/codex/routing.ts` has many importers).

**Accept criteria (C-ACTIVATION-GROUNDING-01).** Four conditional paths:

- *Future reset present*: unchanged — terminal (`:149` still green).
- *Past reset present*: unchanged — unknown (`:155` still green).
- *No reset, fresh observation* **(new)**: terminal -> account excluded, `applyQuotaAutoSwitch` fires.
- *No reset, stale or absent observation*: unknown -> account stays selectable (`:159` still green).

**Docs-site sync:** if account-pool selection is documented, note that a fresh 100% burst reading excludes an
account even without a reset timestamp. Run `rg -n "shortResetAt|burst window" docs-site/` before opening.

**Security boundary:** **yes, adjacent.** Account-pool and quota logic. `MAINTAINERS.md` security review requested;
the over-eager-exclusion direction (#3029) is a real regression risk and the stale-reading test is the evidence
that it is handled. `privacy:scan` must stay green — no account identifiers in any new log line.

**PR skeleton.**

```
title: fix(codex): exclude a freshly-observed 100% burst window without a reset timestamp

## Summary
An exhausted Codex account kept serving 118 consecutive 502s over 23 minutes while a healthy
account sat at 3% (#3425). Two mechanisms reinforce: isTerminalShortWindow requires a FUTURE
shortResetAt (src/codex/routing.ts:415-421), so a 100% snapshot with no timestamp scores
unknown and stays selectable; and 502 is transient (quota-rejection.ts:101), so the failures
produce no quota signal to correct it.

Gate on snapshot FRESHNESS instead of reset presence. StoredAccountQuota.updatedAt already
exists; a 100% window observed seconds ago is a measured refusal, while a stale one still
falls back to unknown. That preserves #3029 in both directions, and the existing assertion
that a bare {shortPercent: 100} stays unknown is untouched and still green.

502 stays classified transient: demoting every gateway blip would strand accounts. The storm
is addressed by releasing sticky affinity after a bounded run of consecutive failures.

## Verification
- bun test tests/codex-integration/codex-routing.test.ts
- bun test tests/codex-integration/codex-quota-rejection.test.ts
- bun run test:changed / typecheck / privacy:scan

## Checklist
- [x] Security review requested (account-pool selection)
- [x] Both directions tested: fresh excludes, stale does not
- [x] #3029 assertions unchanged

Closes #3425.
```

---

## 4. Field/enum chains for new config fields

Exactly one new field is introduced across wp5. E0/E1/E2 add none (test and docs only); E3 adds environment
variables, not config fields; E5 adds no persisted field (`launcherPath` already exists at `service.ts:246`);
E6 adds a module constant, not a config field.

### `ProviderRegistryEntry.alias` (E4) — deliberately truncated chain

| Stage | Location | Behavior |
|---|---|---|
| **Declaration** | `src/providers/registry.ts:130` — `alias?: string;` | New optional field on the registry entry interface. |
| **Creation** | `src/providers/registry.ts:1902` — `{ id: "google-antigravity", alias: "agy", ... }` | The only populated instance. |
| **Serialization (seed)** | `src/providers/derive.ts:221` — `...(entry.alias ? { alias: entry.alias } : {})` | Reaches `providerConfigSeed`, so `ocx provider add` (`src/cli/provider.ts:174`) writes `alias = "agy"` into the user's config as an editable value. |
| **Deserialization** | `OcxProviderConfig.alias`, `src/types/provider.ts:174` | Pre-existing field. `src/config.ts:2178-2183` already validates and can `delete provider.alias` on collision — no new validation needed. |
| **Consumer (routing)** | `src/router.ts:679-708` | Two passes: configured aliases first, then the registry fallback, each rejecting ambiguity with a thrown error. |
| **Consumer (display)** | `src/codex/catalog/sync.ts:277-279` | Raw-slug picker label only. |
| **NOT a consumer — the load-bearing gap** | `src/providers/derive.ts` `enrichProviderFromRegistry` (`:451-570`) | The registry alias is **not** backfilled onto the runtime provider row. |

**Why the chain stops there, and why it must.** `src/codex/catalog/provider-fetch.ts:2444` composes the #2960
effective-alias label as `${provider.alias || name}/${alias}`. Adding a one-line backfill in
`enrichProviderFromRegistry` makes `provider.alias === "agy"` visible there and rewrites the #2960 label from
`google-antigravity/gemini-3.7` to `agy/gemini-3.7` — reproduced as a hard test failure on head `f486b5d60`.

**Implementer instruction:** do **not** "complete" this chain by adding the enrich backfill. The truncation is the
fix. If a future change needs the alias on the runtime row, it must simultaneously decide what the #2960 label
should be and update that test with an explicit rationale. Record this in the PR body so the next editor does not
read the gap as an oversight.

---

## 5. Risk and rollback per layer

| Layer | Risk | Likelihood | Rollback |
|---|---|---|---|
| E0 | Removal assertion is over-strict if `seed()` semantics differ from the route | Low | Revert one test file; no runtime impact. |
| E1 | None beyond a stricter test | Very low | Revert one test file. |
| E2 | A locale mistranslates the wire distinction | Low | Revert docs; no runtime impact. |
| E3 | Build-stage generator changes image build time or fails in CI; the loopback default breaks an existing remote-hub user | Medium | Revert the PR. **Announce the bind change in release notes** — it is a behavior change for anyone relying on the all-interfaces default. |
| E4 | Compact label surprises users expecting the full provider name; alias ambiguity throws where it previously fell through | Low–Medium | Revert; `alias` is additive and unset elsewhere, so the blast radius is one provider. |
| E5 | A launchd plist naming a launcher later removed from `PATH` | Low | Revert; `launcher === null` restores today's exact behavior. Mitigation: absolute-path validation at install time. |
| E6 | **Over-eager exclusion strands a recovered account (#3029 inverted)** | Medium — the real risk of this work-phase | Revert. Mitigations: the 5-minute freshness bound, the mandatory stale-reading test, and no change to 502 classification. |

**Security-boundary items requiring the `MAINTAINERS.md` review exception:**

- **E3 (#3421)** — deployment surface and token handling: `compose.yaml` publish address, `docker/bootstrap-token.ts`,
  documented token paths. Explicit security review before merge.
- **E6 (#3425)** — account-pool selection and quota logic, auth-adjacent. Explicit security review; both regression
  directions must be demonstrated in the PR body.
- **E5 (#3464)** — partial: the absolute-path requirement in `stableLauncherEntry` is a PATH-hijacking guard. Not a
  full security review, but call it out so the reviewer checks it deliberately.

None of E0–E2, E4 touches auth, OAuth, CORS, or workflows.

---

## 6. Out-of-scope / deferred items of this family

| Item | Disposition | Evidence-backed reason (carried from the lane docs, re-verified where cheap) |
|---|---|---|
| #3528 | **SUPERSEDED (alias half)** | Head moved `735e3f5c5` -> `f9f5f836d` and the alias half is **gone**: `git show tmp-pr-3528-new:src/codex/catalog/sync.ts \| rg agy` returns nothing and the registry `alias: "agy"` is absent. The residual `ocx effort` CLI half (+575) is unrelated scope on a stale pre-#3518 layout (179 files, mostly test moves it would revert). Close the alias half in favor of E4; ask for `ocx effort` as its own PR against current `dev`. Same author, so no `Co-authored-by` needed. **Do not cite byte-identity — that evidence is stale.** |
| #3508 | **DEFER** | `gui/src/pages/logs-filter.ts` is imported by exactly one file, its own test; `Logs.tsx` still filters inline at `:516`. Green, approved, `CLEAN` — and still 175 lines of unreachable source plus a second divergent definition of "how a log row is filtered". Flips to LAND_AS_IS the moment the `Logs.tsx` call-site migration is open. |
| #3383 | **DEFER** | 121 commits behind; `CONFLICTING` across 15 files including `Models.tsx`, nine locales, and `src/server/index.ts` (a composition root under the no-`await` invariant, so hand resolution only); no cross-platform CI ever run on the head; and an unvalidated management request body at `agent-settings-routes.ts:674`. |
| #2716 | **DEFER** | 118 commits behind; `changed in both` on 12 files (`Models.tsx` + nine locales + the providers reference); zero exact-head CI for a +1325-line GUI change with a 433-line test file; and 391 lines of out-of-scope `docs/superpowers/` planning artifacts that `AGENTS.md` places in `devlog/`. |
| #3329 | **DEFER from wp5** (was LAND_WITH_FIX) | Real feature with the lane's strongest test evidence, but 138 commits behind with a **semantic** conflict in `src/server/responses/core.ts` — one of the three files `AGENTS.md` forbids from reaching `src/lab/` — plus a verified High correctness bug (reset metadata dropped for body-confirmed quota inside 5xx at `:1645-1647`) and a Korean doc contradicting the runtime. It is the only wp5 item whose fix list requires re-reasoning a protected core path; carrying it alongside six other landings would put the riskiest change behind the weakest review attention. Its commit authorship is also unresolved (`" " <wj@nas-backup>` + `claude <noreply@anthropic.com>`), which must be settled with the author before any carry. Recommend its own work-phase. |

---

## 7. Execution order summary

1. **Re-verify drift** (section 0) — `git fetch origin dev`, re-read every PR head. Three dev moves and two head
   moves have already occurred.
2. **E0** -> merge. Coherence for the reorg-deletion family.
3. **E1, E2, E4** -> open in parallel; independent files, mergeable in any order.
4. **E5, E6** -> open with security-review requests; E6 must show both regression directions.
5. **E3** -> open with security review; needs a container build in CI.
6. **Closures**: #3528 (alias half, citing E4 and the current head state), then #3508 / #3383 / #2716 / #3329
   deferral comments with the section 6 reasons.
7. **Ledger**: append every landing to `060_closeout.md` with merge SHA and ancestry exit code.

---

## E7 — #3329 per-combo `cooldownMs` / `waitForCooldownMs` (LAND_WITH_FIX, appended by 008 round 2)

Supersedes the DEFER mentions of #3329 elsewhere in this doc. Single disposition: **LAND_WITH_FIX**.

**Why it is its own layer.** Shares no source file with E0-E6; shares `src/types/config.ts` with
the DEFERRED #3383 only. Lands last in wp5 because it is the only wp5 item that touches
`src/server/responses/core.ts` (lab-boundary-protected) and needs a full cross-platform matrix.

**Mergeability.** `git merge-tree --write-tree origin/dev refs/tmp/pr-3329` → CLEAN at
`79e03643d` (008 table). The "semantic core.ts conflict" premise from lane 004 is a GitHub-probe
artifact; the carry is `git merge origin/dev` onto the PR head, not a hand re-resolution.
Post-merge, run `bun test tests/lab/core-lab-boundary.test.ts` (exists; the lane's
`tests/core-lab-boundary.test.ts` path was wrong) to prove `core.ts` still does not reach `src/lab/`.

**Branch.** `codex/260905-combo-cooldown-knobs` from `refs/tmp/pr-3329` merged with `origin/dev`;
trailer `Co-authored-by: Veritas-7 <234569343+Veritas-7@users.noreply.github.com>`.

**File change map.**

| Path | Change |
|------|--------|
| `src/combos/{types,resolve,failover,index}.ts`, `src/types/config.ts`, management route | carried from PR (feature) |
| `src/server/responses/core.ts` (PR hunk near dev `:1645-1647`) | **fix 1**: keep `resetAt` when the *effective* classification is quota (402/429 OR body-confirmed quota inside a 5xx as normalized by `shouldRetryCodexPoolAccountQuota`), not when the raw status is 402/429; keep the `cyberFailure` exclusion |
| `tests/codex-integration/combos.test.ts` (+302), `tests/routing/combo-management-api.test.ts` (+130), `tests/server/server-combo-failover-e2e.test.ts` (+98), `tests/providers/cyber-policy-error-fidelity.test.ts` (+15) | PR tests relocated by the merge (rename-aware) |
| new test in `tests/server/server-combo-failover-e2e.test.ts` | **fix 2**: "body-confirmed quota inside HTTP 503 with no alternate account retains x-codex-*-reset-at on the combo target" — RED on PR head (target re-eligible immediately), GREEN after fix 1 |
| `docs-site/src/content/docs/ko/guides/combos.md:130` | **fix 3**: bound the immediate-503 claim to `waitForCooldownMs: 0` or earliest-cooldown > budget |
| `docs-site/.../{en,ja,ko,ru,zh-cn}/guides/combos.md` | **fix 4**: state that `Retry-After` and Codex reset signals take precedence over configured `cooldownMs` |
| `tests/routing/combo-management-api.test.ts` | **fix 5**: assert `explicitDefault` persistence around combo update (CodeRabbit) |

**Field chain (PLAN-FIELD-CHAIN-01)** for `cooldownMs`, `waitForCooldownMs`:
creation `src/types/config.ts` (optional numbers on combo config) → serialization: config persist
via management route (`src/server/management/...` combo update) → deserialization: config load +
`src/combos/resolve.ts` defaults → consumer: `src/combos/failover.ts` cooldown/wait budget.
Reviewer checks names match across the four files.

**Activation scenarios (C-ACTIVATION-GROUNDING-01).**

- Cooldown path: combo with `cooldownMs: 60000`; first target fails 500 → e2e test asserts second
  target selected and first target's cooldown expiry ≈ now+60s.
- Wait budget path: all targets cooling, `waitForCooldownMs: 200`, earliest expiry in 100ms →
  request waits and succeeds; with expiry in 5s → 503 immediately.
- Fix 1 path: 503 whose body is the Codex quota-exhausted shape, single-account pool → reset
  metadata retained (the new test).

**Verifiers (run at P of wp5; all exist and read the targets):**
`bun test tests/codex-integration/combos.test.ts`, `bun test tests/routing/combo-management-api.test.ts`
(sandbox: EADDRINUSE → hosted-CI-only), `bun test tests/server/server-combo-failover-e2e.test.ts`
(same), `bun test tests/lab/core-lab-boundary.test.ts`, `bun run typecheck`, exact-head full matrix.

**Risk/rollback.** Feature is opt-in (fields absent → prior behavior); rollback is a revert of the
squash. Fix 1 narrows an over-eager cooldown reset; regression test guards it.

**PR skeleton.** Title `feat(combos): per-combo cooldownMs and waitForCooldownMs (carry of #3329)`;
body: Summary, Verification (the five verifiers + CI run), Checklist, stack table
(E7 independent, base `dev`), `Co-authored-by` trailer, "Supersedes #3329".

