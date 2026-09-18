# 020 — wp2: Stack B, bug PRs by other authors

Work-phase: **wp2**. Source lane: [`002_lane_bug_prs_b.md`](./002_lane_bug_prs_b.md). Dispositions:
[`006_dispositions.md`](./006_dispositions.md) Family 2. Plan: [`000_plan.md`](./000_plan.md).

Author of this doc re-verified every lane-B claim independently in a throwaway scratch worktree
(created from the research worktree, removed and pruned afterwards). Research worktree
`/tmp/ocx-249.xGQnxl/wt` was not modified: `git status --porcelain` empty and HEAD
`7dc7dc99e65268bc8764e19840952256b030bce9` before and after.

## Objective

Land seven other-author bug PRs onto `dev` as squash merges, each independently revertible,
each preserving its contributor in a `Co-authored-by` trailer, and each gated on an exact-head
`ci.yml` run. Three linked issues (#4017, #4007, #3916) close as a consequence. One PR (#4016)
closes as a superseded duplicate with a drafted comment. One PR (#3954) is recorded as
REIMPLEMENT deferred to a later cycle with its defect summary.

Removal count if wp2 completes: **7 PRs merged + 3 issues auto-closed + 1 PR closed = 11 items**,
against the unit target of 25–30 across all work-phases.

## Preconditions

| Fact | Value | How to re-check |
|------|-------|-----------------|
| Base head | `7dc7dc99e65268bc8764e19840952256b030bce9` | `git fetch origin dev && git rev-parse FETCH_HEAD` |
| Base subject | `Merge pull request #4037 from lidge-jun/codex/prs-stack-record` | `git log --oneline -1 origin/dev` |
| dev version line | 2.49.0 | `grep '"version"' package.json` |
| Research worktree | `/tmp/ocx-249.xGQnxl/wt`, detached, clean | `git -C /tmp/ocx-249.xGQnxl/wt status --porcelain` |
| Local tsc | TypeScript `7.0.2` via `bun x tsc` (`package.json:44` → `bun x tsc --noEmit`) | `bun x tsc --version` |
| Bun | 1.4.0 (wp6 moves the pin to 1.4.2; wp2 must land **before** wp6) | `bun --version` |

**`dev` may have advanced.** Every SHA below is the snapshot head. Re-fetch and re-read
`gh pr view <n> --json headRefOid` immediately before each carry; if a head moved, redo that
item's focused test before merging. Do not reuse a stale head SHA in a CI-evidence claim.

### CI approval gate (the load-bearing precondition)

**No PR in this lane has a `ci.yml` run at its head.** Verified at research and re-confirmed:
every green mark on these PRs is a hygiene gate — `enforce-target`, `hygiene`, `label`,
`resolve-pr`, `CodeRabbit`. Product CI (`Cross-platform CI`, `.github/workflows/ci.yml`) sits
in `action_required` because these are fork PRs awaiting maintainer workflow approval.

Two consequences, both mandatory:

1. A green check rollup on the contributor PR is **not** merge evidence. `SUCCESS:13` on #4018
   means thirteen hygiene checks, zero test jobs.
2. `ci.yml` has `pull_request: {}` with no base filter (`.github/workflows/ci.yml:8`), so it
   *will* run on a maintainer carry branch's PR without needing fork approval. That is why the
   carry route below is the default rather than approving fork workflows one by one.

Also note all five of the draft PRs (#4018, #4008, #3981, #3979, #3920) sit at
`mergeStateStatus: BLOCKED` with `reviewDecision: REVIEW_REQUIRED`, and #4018 additionally
carries `intake: hygiene-blocked`. `gh pr merge --admin` on the contributor PR would bypass
the review requirement but would still merge a head with **no product CI at all**. Carry.

### Route decision per item

Direct-merge of a contributor PR is permitted by the task framing only when the head is
*exact-green* on product CI. **No head in this lane is exact-green on product CI**, so all seven
LAND items take the carry route. Do not take the direct-merge branch for any wp2 item unless a
re-check shows a `ci.yml` conclusion `success` at the exact current head SHA.

## Stack order and conflict map

Only one file is shared between two LAND items in this lane.

| # | Order | PR | Author | Files touched | Shared with |
|---|-------|----|--------|---------------|-------------|
| 1 | first | #4018 | cb8010d6 | `src/codex/auth-api.ts`, `src/codex/quota.ts`, `src/types/config.ts`, 2 tests | `quota.ts` ↔ #4008 |
| 2 | | #4008 | cb8010d6 | `src/codex/quota.ts`, 1 test | `quota.ts` ↔ #4018 |
| 3 | | #3981 | yansigit | `src/codex/internal/catalog-writer.ts`, `src/codex/sync.ts`, 1 doc, 1 test | none |
| 4 | | #3979 | yansigit | `src/web-search/progress-stream.ts`, 1 test | none |
| 5 | | #3964 | ildunari | `src/adapters/openai-responses.ts`, 1 test, 1 binary asset | none |
| 6 | | #3863 | x3M3x | `src/codex/catalog/provider-fetch.ts`, `src/storage/cleanup.ts`, `src/server/management/logs-usage-routes.ts`, `gui/src/pages/Storage.tsx`, 9 i18n, 2 tests, 1 asset | 9 `gui/src/i18n/*` ↔ wp3 #3914/#3915 |
| 7 | **last** | #3920 | cb8010d6 | 7 CLI/src files incl. new `src/codex/ocx-compaction-history.ts`, **`scripts/test-layout/layout.json`**, **`tests/fixtures/test-layout-expected.json`**, 8 docs, 4 tests | both layout registries ↔ wp3 #3914/#3915, wp4 new tests |

**The task-assigned order is `#4018 → #4008`**, which inverts lane B's own §"Shared files /
stack order" recommendation (it proposed #4008 first as the smaller change). Both orders were
tested. The assigned order is what this doc executes, and it is verified: applying #4008's diff
then #4018's diff onto `7dc7dc99e` in one tree produced no conflict, and the assigned merge
sequence `#4018 → #4008` as consecutive squash commits also applied cleanly. The hunks are
disjoint — #4018 edits `parseUsageQuota` (`src/codex/quota.ts:796`), #4008 edits
`mergeAccountQuota` (`src/codex/quota.ts:338`), 458 lines apart.

**Why #3920 is last:** it is the only wp2 item editing `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`. Both are sorted single-line-insert lists — the
classic silent-conflict shape. wp3 (#3914/#3915) and any wp4 test addition touch the same two
files. Landing #3920 last means the reconciliation happens once, in whichever work-phase lands
after it, against a settled registry. Never hand-merge those two files; regenerate.

**Why #3863 is second-to-last:** its nine `gui/src/i18n/*.ts` files are also touched by wp3's
sponsor pair. wp2 and wp3 must not run these two items concurrently in separate worktrees.

Items 3, 4, 5 are file-disjoint from everything and from each other; they may be carried in
parallel worktrees and merged in any relative order.

### Full-stack composition proof

All seven merged onto `7dc7dc99e` as seven consecutive squash commits in the order above:

```
OK 4018 / OK 4008 / OK 3981 / OK 3979 / OK 3964 / OK 3863 / OK 3920
```

Zero conflicts. `bun x tsc --noEmit` on the resulting seven-commit tree → **exit 0, 0 lines of
output**. The typechecker was proved live on that same tree by injecting
`const x: number = "boom";` into `src/__wp2_probe.ts`, which produced
`error TS2322: Type 'string' is not assignable to type 'number'`; the probe was then removed.

## Per-item procedure

Conventions used by every block below:

- Branch prefix `codex/260909-` as required.
- Every mutating git command carries `-c core.hooksPath=/dev/null`. The repo's `postmerge`
  hook runs installs and typecheck; this cycle forbids local product suite execution.
- Every push carries `--no-verify`.
- `$OCX` = a fresh worktree path for the item. Create it from the main checkout:
  `git -C /Users/jun/Developer/new/700_projects/opencodex worktree add -b <branch> $OCX dev`
  after `git fetch origin dev` — or reuse one worktree serially for the whole stack.
- `node_modules` in a fresh worktree:
  `ln -s /Users/jun/Developer/new/700_projects/opencodex/node_modules $OCX/node_modules`.
- The PR body file must satisfy `.github/PULL_REQUEST_TEMPLATE.md`: sections `## Summary`,
  `## Verification`, `## Checklist` with the three checkboxes ticked.
- `gh pr create --base dev --draft=false` — a maintainer-authored PR opens ready, not draft.
- Co-author trailers below were read from
  `gh pr view N --json commits --jq '.commits[0].authors[0]'` at snapshot; re-read before use.

Co-author trailers (verified):

| PR | Trailer |
|----|---------|
| #4018, #4008, #3920 | `Co-authored-by: R <53855466+cb8010d6@users.noreply.github.com>` |
| #3981 | `Co-authored-by: SB Yoon <44089734+yansigit@users.noreply.github.com>` |
| #3979 | `Co-authored-by: SB Yoon <44089734+yansigit@users.noreply.github.com>` |
| #3964 | `Co-authored-by: ildunari <95185577+ildunari@users.noreply.github.com>` |
| #3863 | `Co-authored-by: x3M3x <98298256+x3M3x@users.noreply.github.com>` |

**Trailer caveat for #3981 and #3979 (yansigit).** `.commits[0].authors[0]` returns
`{"email":"<automation address, redacted>","login":"","name":"Yumi"}` — an automation identity with an
**empty `login`**, which GitHub cannot attribute to a contributor profile. #3981's commit has a
second author, `SB Yoon <44089734+yansigit@users.noreply.github.com>` (login `yansigit`), and
`gh api users/yansigit` confirms id `44089734`, so the noreply address is the correct
attributable form. #3979's single commit lists **only** the automation identity, so its trailer
must be reconstructed from the PR author rather than copied from `authors[0]`. Use the
`44089734+yansigit` form for both; a trailer with an empty login credits nobody, which is the
exact failure mode `missing_coauthor_credit` and `CREDITS.md` exist to prevent.

---

### 1. PR #4018 — keep Spark five-hour quota model-scoped

Head `d7387478be84e1740fbbca296574187620f86cf1`. Draft, `REVIEW_REQUIRED`, labels `bug`,
`intake: hygiene-blocked`. +50/-22, 5 files. **Closes #4017.**

Defect on dev, `/tmp/ocx-249.xGQnxl/wt/src/codex/quota.ts:796-797`:

```
  const sparkWindows = [spark?.rate_limit?.primary_window, spark?.rate_limit?.secondary_window]
    .filter((window): window is WhamUsageWindow => !!window);
```

Both windows are collected, then only the weekly one is searched for, and only it is written to
`quota.customWindows`. A Pro account whose Spark primary is a five-hour window loses it.

LAND_AS_IS — no fix hunk needed.

```bash
cd /Users/jun/Developer/new/700_projects/opencodex
git fetch origin dev
OCX=$(mktemp -d)/wt
git -c core.hooksPath=/dev/null worktree add -b codex/260909-spark-5h-window "$OCX" origin/dev
ln -s /Users/jun/Developer/new/700_projects/opencodex/node_modules "$OCX/node_modules"
cd "$OCX"

git fetch origin refs/pull/4018/head:refs/wp2/pr4018
git -c core.hooksPath=/dev/null merge --squash refs/wp2/pr4018

bun test tests/codex-integration/codex-spark-visibility.test.ts \
         tests/codex-integration/codex-routing.test.ts \
         tests/codex-integration/codex-quota-parser-parity.test.ts

git -c core.hooksPath=/dev/null commit --no-verify -F - <<'MSG'
fix(codex): keep Spark five-hour quota model-scoped

parseUsageQuota collected both Spark rate-limit windows but only ever
searched for the weekly one, so a Pro account whose Spark primary is a
five-hour window had it silently discarded. Widen the label constant to a
two-label set and iterate the [label, window] pairs; the auth-api
visibility filter moves from equality to set membership, preserving the
load-bearing exact-label match that keeps Cursor, Anthropic, Antigravity
and Kimi meters untouched.

Closes #4017

Co-authored-by: R <53855466+cb8010d6@users.noreply.github.com>
MSG

git push --no-verify -u origin codex/260909-spark-5h-window
```

PR body file:

```bash
cat > /tmp/wp2-4018-body.md <<'BODY'
## Summary

- `parseUsageQuota` collected both Spark rate-limit windows but only searched for the weekly
  one, so a Pro account whose Spark primary is a five-hour window lost it entirely and the
  dashboard showed a generic account window instead of `GPT-5.3-Codex-Spark 5h`.
- Widens the single-label constant to a two-label set and iterates the `[label, window]` pairs.
- The visibility filter in `src/codex/auth-api.ts` moves from label equality to set membership,
  preserving the load-bearing property documented at `src/codex/auth-api.ts:244-249`: matching
  on the exact label rather than on "is a custom window" keeps Cursor, Anthropic, Antigravity
  and Kimi meters out of the Spark path.
- Carries @cb8010d6's work from #4018 onto a maintainer branch so product CI can run.

## Verification

- `bun test tests/codex-integration/codex-spark-visibility.test.ts tests/codex-integration/codex-routing.test.ts tests/codex-integration/codex-quota-parser-parity.test.ts` → 192 pass / 1 skip / 0 fail (with #4008 also applied; 189 pass / 1 skip standalone).
- `bun x tsc --noEmit` → exit 0.
- Cross-platform CI on this branch head.

## Checklist

- [x] Scope stays focused and avoids unrelated cleanup.
- [x] Docs or release notes were updated when needed.
- [x] Security-sensitive changes were reviewed for secrets, auth, and unsafe defaults.

Closes #4017
BODY

gh pr create --repo lidge-jun/opencodex --base dev --draft=false \
  --head codex/260909-spark-5h-window \
  --title "fix(codex): keep Spark five-hour quota model-scoped (carry #4018)" \
  --body-file /tmp/wp2-4018-body.md
```

CI and merge (`<n>` = the new PR number):

```bash
gh pr checks <n> --repo lidge-jun/opencodex --watch
gh pr view <n> --repo lidge-jun/opencodex --json headRefOid --jq .headRefOid   # confirm the SHA CI ran on
gh pr merge <n> --repo lidge-jun/opencodex --squash --admin
```

Expected focused counts: **192 pass / 1 skip / 0 fail, 6699 assertions, 193 tests across 3
files** when #4008 is already in the tree (the stacked case, which is this order). Standalone on
plain `dev` the same three files give 189 pass / 1 skip / 0 fail.

Touches: `src/codex/auth-api.ts`, `src/codex/quota.ts`, `src/types/config.ts`,
`tests/codex-integration/codex-routing.test.ts`,
`tests/codex-integration/codex-spark-visibility.test.ts`.

---

### 2. PR #4008 — retain Spark quota on partial header updates

Head `522e438f5b95fde16fdcf806e02281663d2d1b30`. Draft, `REVIEW_REQUIRED`, label `bug`.
+47/-1, 2 files (3 source lines). **Closes #4007.**

Defect on dev, `/tmp/ocx-249.xGQnxl/wt/src/codex/quota.ts:338`:

```
  if (snapshotHasCustom(quota)) next.customWindows = quota.customWindows;
```

No `else`. Both neighbours have one — `resetCredits` at `:340-341`, `weeklyPercent` at
`:301-304`. An ordinary header update carries no WHAM windows, so the stored Spark window is
erased. LAND_AS_IS.

```bash
cd /Users/jun/Developer/new/700_projects/opencodex && git fetch origin dev
OCX=$(mktemp -d)/wt
git -c core.hooksPath=/dev/null worktree add -b codex/260909-spark-partial-retain "$OCX" origin/dev
ln -s /Users/jun/Developer/new/700_projects/opencodex/node_modules "$OCX/node_modules"
cd "$OCX"
git fetch origin refs/pull/4008/head:refs/wp2/pr4008
git -c core.hooksPath=/dev/null merge --squash refs/wp2/pr4008

bun test tests/codex-integration/codex-quota-parser-parity.test.ts

git -c core.hooksPath=/dev/null commit --no-verify -F - <<'MSG'
fix(codex): retain Spark quota on partial header updates

mergeAccountQuota retained every other partial field but replaced
customWindows unconditionally, with no else branch — unlike resetCredits
and weeklyPercent in the same function. An ordinary response-header update
carries no model-specific WHAM windows, so the stored Spark window was
erased. Add the retention branch that matches the file's existing idiom.

Closes #4007

Co-authored-by: R <53855466+cb8010d6@users.noreply.github.com>
MSG

git push --no-verify -u origin codex/260909-spark-partial-retain
```

Base this PR on `dev` if #4018 has already merged. If #4018 is still open, either wait, or open
it as a stacked child with `--base codex/260909-spark-5h-window` and retarget to `dev` after
the parent lands (`gh pr edit <n> --base dev`); `enforce-target` exempts stacked children.

Body: same three-section shape, Summary describing the missing `else` branch and the three
pinned edges (retain on omission, replace on explicit supply including `[]`, do not survive
`clearAccountQuota`), Verification naming the test below, `Closes #4007` at the end.

Expected focused counts: **11 pass / 0 fail** standalone;
`bun test tests/codex-integration/codex-quota-parser-parity.test.ts tests/codex-integration/codex-spark-visibility.test.ts`
→ **17 pass / 0 fail** stacked with #4018.

Touches: `src/codex/quota.ts`, `tests/codex-integration/codex-quota-parser-parity.test.ts`.

---

### 3. PR #3981 — invalidate app-server observations at catalog boundaries

Head `9f666b33a5070f37f80108d45a9563e13dd3bff2`. Draft, `REVIEW_REQUIRED`, label `bug`.
+70/-2, 4 files. No linked issue.

Defect on dev: `resetCodexAppServerCatalogStateCache` exists
(`src/codex/app-server-processes.ts:1061`) and is documented at `:954`, but neither catalog
writer calls it — `grep -n resetCodexAppServerCatalogStateCache src/codex/internal/catalog-writer.ts src/codex/sync.ts`
returns nothing. So `replaceActiveCodexCatalog` and `replaceCodexModelsCache` publish new bytes
behind a stale "not running" observation. LAND_AS_IS.

Branch: `codex/260909-catalog-observation-invalidate`. Same command shape as item 2, with
`refs/pull/3981/head`.

Commit message trailer: `Co-authored-by: SB Yoon <44089734+yansigit@users.noreply.github.com>`
— see the trailer caveat above; do not copy the empty-login automation identity.

Focused test: `bun test tests/codex-integration/codex-models-cache-invalidate.test.ts` →
**11 pass / 0 fail, 42 assertions**, including "sync invalidates a cached not-running
observation before a catalog write" and "sync invalidates cached process state even when catalog
refresh is a no-op".

Touches: `src/codex/internal/catalog-writer.ts`, `src/codex/sync.ts`,
`docs-site/src/content/docs/guides/codex-app-models.md`,
`tests/codex-integration/codex-models-cache-invalidate.test.ts`.

Note the docs file: this is a user-facing behaviour change with its doc update already included,
which satisfies the `AGENTS.md` docs-sync review rule.

---

### 4. PR #3979 — stop inactivity timing after terminal events

Head `b8c92f2e58774603ef0b9e2c108da8efd684507c`. Draft, `REVIEW_REQUIRED`, label `bug`.
+9/-2, one source line. No linked issue.

Defect on dev, `/tmp/ocx-249.xGQnxl/wt/src/web-search/progress-stream.ts:303-306`:

```
        if (event.type === "done" || event.type === "incomplete") {
          heldTerminal = event;
          continue;
        }
```

The terminal event is held without disarming the inactivity timer armed at `:205-206`, so it
races the bounded drain guard at `:262-265`. After a terminal event there are legitimately no
more response bytes, so a slow adapter iterator surfaces `RoutedModelInactivityError` instead
of the drain error that actually describes the condition. `clearInactivity()` is only called on
the success path at `:282`. LAND_AS_IS — one `clearInactivity()` at the hold point.

Branch: `codex/260909-websearch-terminal-inactivity`, `refs/pull/3979/head`.

Trailer: `Co-authored-by: SB Yoon <44089734+yansigit@users.noreply.github.com>`. **This is the
item where `.commits[0].authors[0]` gives only the empty-login automation identity** — the
trailer must be reconstructed from the PR author.

Focused test: `bun test tests/web-search/web-search-progress-stream.test.ts` →
**21 pass / 0 fail, 51 assertions**. Both neighbouring guards stay green: "done followed by an
iterator that never returns hits the separate drain guard" and "continuous raw-byte silence
raises the exact typed inactivity error".

Touches: `src/web-search/progress-stream.ts`,
`tests/web-search/web-search-progress-stream.test.ts`.

---

### 5. PR #3964 — strip Muse web_search fields on direct Meta

Head `8488a47c862047cb3077b6183bafbf7bdeef5867`. **Not draft**, `REVIEW_REQUIRED`, labels
`bug`, `review-ready`. +45/-9, 3 files. No linked issue.

Defect on dev, `/tmp/ocx-249.xGQnxl/wt/src/adapters/openai-responses.ts:2134-2137`:

```
const MUSE_SPARK_WEB_SEARCH_STRICT_RESPONSE_URLS = new Set([
  "https://opencode.ai/zen/v1/responses",
  "https://opencode.ai/zen/go/v1/responses",
]);
```

Direct Meta is absent, so `stripMuseSparkUnsupportedWebSearchFields` returns the body unchanged
(`:2168`) while the model-id set at `:2127-2132` already contains
`muse-spark-1.3-contributor`. Same model, same wire, 400 on `search_content_types` when
reached at `api.meta.ai`. LAND_AS_IS — one URL added to the existing set.

**This item requires the ref-fetch route, not `gh pr diff | git apply`.** The PR includes a
binary asset (`.github/pr-assets/muse-spark-meta-search-content-types-400.jpg`) and
`git apply` fails on it:

```
error: cannot apply binary patch to '.github/pr-assets/muse-spark-meta-search-content-types-400.jpg' without full index line
error: .github/pr-assets/muse-spark-meta-search-content-types-400.jpg: patch does not apply
```

`git fetch origin refs/pull/3964/head` + `merge --squash` handles it correctly (verified:
the asset lands as `A` in `git status --porcelain`). Every block in this doc already uses that
route; this is the item that proves why.

Branch: `codex/260909-muse-meta-websearch-strip`, `refs/pull/3964/head`.
Trailer: `Co-authored-by: ildunari <95185577+ildunari@users.noreply.github.com>`.

Focused test: `bun test tests/providers/muse-spark-web-search-compat.test.ts` →
**16 pass / 0 fail, 65 assertions**.

Touches: `src/adapters/openai-responses.ts`,
`tests/providers/muse-spark-web-search-compat.test.ts`,
`.github/pr-assets/muse-spark-meta-search-content-types-400.jpg`.

The PR also inverts a prior test that asserted the opposite ("direct Meta preserves its
web_search fields") and documents #3456 as the origin of the wrong assumption. That is a correct
retirement of a stale assertion, and the PR description should carry that sentence forward so a
reviewer does not read the inversion as a regression.

Since #3964 is already `review-ready` and not a draft, it is the one item where merging the
contributor PR directly is tempting. It still has **no product CI at head**, so it takes the
carry route like the rest — unless a re-check shows a `ci.yml` success at
`8488a47c862047cb3077b6183bafbf7bdeef5867`, in which case
`gh pr merge 3964 --repo lidge-jun/opencodex --squash --admin` is permitted directly.

---

### 6. PR #3863 — preserve combo capabilities and skip referenced archives

Head `51e544ad9452d56d9d0fd21c187a3efdae4c46cf`. Not draft, `REVIEW_REQUIRED`, labels `bug`,
`review-ready`, **`landed-via-maintainer`**. +208/-64, 16 files. No linked issue.

**Do not close this PR on the strength of its label.** Only a path-filtered slice landed, as
carry commit `9d8d11abd fix(service): carry startup-health cache portion of #3863 [skip ci]`
(two files: `src/server/startup-health-cache.ts`, `tests/service/autostart-health.test.ts`),
merged via `686cb127c`. The PR touches sixteen. Two fixes remain absent from dev:

1. Combo capability fallback — `vendorMetadataComboFallback` still returns `undefined` for a
   provider with no metadata alias at
   `/tmp/ocx-249.xGQnxl/wt/src/codex/catalog/provider-fetch.ts:956-958`.
2. Storage cleanup skip-referenced — `grep -n 'skippedReferenced' src/storage/cleanup.ts src/server/management/logs-usage-routes.ts gui/src/i18n/en.ts`
   returns nothing on dev; the i18n key exists in none of the nine locale files.

LAND_AS_IS. **Before merging, remove the misleading label:**

```bash
gh pr edit 3863 --repo lidge-jun/opencodex --remove-label landed-via-maintainer
```

Branch: `codex/260909-combo-caps-storage-skip`, `refs/pull/3863/head`.
Trailer: `Co-authored-by: x3M3x <98298256+x3M3x@users.noreply.github.com>`.

Focused tests:
`bun test tests/storage/storage-cleanup.test.ts tests/codex-integration/codex-catalog.test.ts`
→ **384 pass / 0 fail, 1959 assertions across 2 files**.

Touches: `src/codex/catalog/provider-fetch.ts`, `src/storage/cleanup.ts`,
`src/server/management/logs-usage-routes.ts`, `gui/src/pages/Storage.tsx`, nine
`gui/src/i18n/*.ts`, `tests/storage/storage-cleanup.test.ts`,
`tests/codex-integration/codex-catalog.test.ts`,
`.github/pr-assets/3863-storage-skip-referenced.png`.

**GUI screenshot requirement.** `enforce-target` requires a screenshot in the description for
any PR whose title or description mentions `gui`. The carry PR touches `gui/`, so its body
must embed the asset the PR already carries:
`![storage skip-referenced](https://github.com/lidge-jun/opencodex/blob/codex/260909-combo-caps-storage-skip/.github/pr-assets/3863-storage-skip-referenced.png?raw=true)`
— or re-upload via the web UI. Do not open this PR without it; the gate will reject the body.

**Optional split.** The two remaining fixes share no files and could be two independent carries
under the one-bug-per-PR convention: combo capabilities
(`src/codex/catalog/provider-fetch.ts` + `tests/codex-integration/codex-catalog.test.ts`) and
storage skip-referenced (the rest). Splitting costs a second CI cycle and a second body with the
screenshot; landing as one carry keeps the contributor's PR as the revert unit. Either is
defensible — the one-carry route is what this doc's commands execute.

---

### 7. PR #3920 — recover ocx1-compacted threads for native replay

Head `3c3ca0aaccd7f4a12b586df25c1e402e433b5773`. Draft, `REVIEW_REQUIRED`, label `bug`.
+459/-9, 21 files (334 lines are the new module plus its new test). **Closes #3916.** Lands
**last** in wp2.

Defect on dev: after a routed remote-compaction V2 item is written, the persisted
`encrypted_content` begins with `ocx1:`, and `ocx restore` returns Codex to native ChatGPT
while leaving the thread unreplayable (HTTP 400 `invalid_encrypted_content`). The CLI offers
only the legacy-OpenAI mode, `/tmp/ocx-249.xGQnxl/wt/src/cli/registry.ts:38-40`:

```
    name: "recover-history",
    usage: "ocx recover-history --legacy-openai --yes",
    summary: "Force all user-message opencodex rows to OpenAI for legacy recovery.",
```

The PR adds `ocx recover-history --ocx-compaction <thread-id> --yes`: a new module
`src/codex/ocx-compaction-history.ts` that lowers only proxy-owned compactions inside
`compacted.payload.replacement_history`, requires explicit confirmation, backs up before
writing, and repairs one named thread rather than sweeping the database. LAND_AS_IS.

Branch: `codex/260909-ocx1-history-recovery`, `refs/pull/3920/head`.
Trailer: `Co-authored-by: R <53855466+cb8010d6@users.noreply.github.com>`.

Focused tests — this item needs the guard suites, not just its own:

```bash
bun test tests/codex-integration/history-ocx-compaction-recovery.test.ts \
         tests/cli/cli-help.test.ts \
         tests/test-layout.test.ts \
         tests/test-layout-tooling.test.ts \
         tests/ci-workflows/skill-ocx.test.ts
```

→ **53 pass / 0 fail, 982 assertions across 5 files.** That covers the two layout registries
(the PR correctly adds its new test to both `scripts/test-layout/layout.json` and
`tests/fixtures/test-layout-expected.json`, as `AGENTS.md` requires) and the skill-surface
guard including "destructive verbs are documented as requiring `--yes`".

Also run `bun test tests/cli/cli-restore-back.test.ts` and
`tests/codex-integration/codex-composed-acceptance.test.ts` if either was touched by a
concurrently landing work-phase.

Touches: `src/cli/dispatch.ts`, `src/cli/help.ts`, `src/cli/index.ts`, `src/cli/registry.ts`,
`src/codex/ocx-compaction-history.ts` (new), `src/responses/compaction.ts`,
`src/server/management/native-integration-routes.ts`, `scripts/test-layout/layout.json`,
`tests/fixtures/test-layout-expected.json`, four tests, eight
`docs-site/**/reference/cli/lifecycle.md` locales.

**Review-depth note, not a defect.** This is a history-mutating CLI command. It is gated behind
an explicit thread id plus `--yes` and backs up first, which is the right shape, but
`src/codex/ocx-compaction-history.ts` deserves a real human read before merge rather than trust
in green tests. Budget that read into the merge step.

**Issue #3916 judgment call.** #3920 supplies a *recovery command*, not an automatic migration
inside `ocx restore`. Lane B reads #3916's expected-behaviour clause as admitting either, so
`Closes #3916` is defensible. If the maintainer reads #3916 as requiring the restore path
itself to migrate or warn, drop the `Closes` line from the carry body and leave #3916 open with
a narrowed scope. Decide this before writing the body, since the trailer is what closes it.

---

## CLOSE — PR #4016

`fix: route muse-spark free models to Responses API`, author omarjson, head
`3cd59118a35455952f45a4f0075559a5464031b4`, draft, `CHANGES_REQUESTED`, label `bug`,
+46/-9 across `src/providers/registry.ts` and
`tests/providers/opencode-free-provider.test.ts`.

Near-duplicate of #3954 by the same author on the same file, opened twelve hours later: identical
`OPENCODE_SESSION_ID` block, identical `X-Session-ID` static header, identical Nous
`262_144` reversion, identical `statelessResponses` deletion. #4016 fills in the
model-metadata maps #3954 left empty — while still declaring them twice.

Evidence re-verified independently for this doc, by merging `refs/pull/4016/head` onto
`7dc7dc99e` and running `bun x tsc --noEmit --pretty false`:

```
src/providers/registry.ts(3048,5): error TS1117: An object literal cannot have multiple properties with the same name.
src/providers/registry.ts(3051,5): error TS1117: An object literal cannot have multiple properties with the same name.
```

That is exactly the CodeRabbit finding of 2026-09-08, unaddressed. Both reversions confirmed
against dev: `maxResponseBytes: 1_048_576` at `src/providers/registry.ts:1560` (from
`5cd71ec91 fix(providers): admit larger Nous catalogs within native limits`) and
`statelessResponses: true` at `:1696` (from
`89b69a00a fix(opencode-go): normalize tool catalogs and stateless continuation`).

Procedure:

```bash
cat > /tmp/wp2-4016-close.md <<'BODY'
Closing as a duplicate of #3954, which carries the same `X-Session-ID` mechanism on the same file and has the active review thread.

Two blockers apply to both and are worth carrying forward to whichever branch continues:

1. The new `modelContextWindows` and `modelInputModalities` keys duplicate declarations that already exist later in the same `opencode-free` object literal, so `bun run typecheck` fails with `TS1117` at `src/providers/registry.ts:3048` and `:3051`. This is the CodeRabbit finding from 2026-09-08.
2. The branch is based on an older `dev` and reverts two landed fixes: the Nous catalog bound from `5cd71ec91` (`maxResponseBytes` back to `262_144`; `dev` has `1_048_576` at `src/providers/registry.ts:1560`) and the OpenCode Go `statelessResponses: true` policy from `89b69a00a` (`dev` has it at `src/providers/registry.ts:1696`, added for #3838). Git merges both cleanly because the branch is simply stale, so the reversion is silent.

Please rebase onto current `dev` before continuing on #3954. Thanks for the report — the underlying `MissingSessionID` behaviour is worth fixing.
BODY

gh pr comment 4016 --repo lidge-jun/opencodex --body-file /tmp/wp2-4016-close.md
gh pr close 4016 --repo lidge-jun/opencodex
```

Comment before closing, in that order, so the explanation is visible above the close event.

## REIMPLEMENT deferred — PR #3954

`fix: add X-Session-ID header for OpenCode free-tier models`, author omarjson, head
`8b90fbfbb957b42a04747d15137c54f2568e2770`, **not draft**, `CHANGES_REQUESTED`, labels `bug`,
`review-ready`, +128/-8 across the same two files.

**Not in this cycle. Leave open. Do not carry, do not close.** Recorded here so the next cycle
does not re-derive the analysis.

Defect summary — what is real and what blocks it:

- *Plausible underlying report.* Zen returns 400 `MissingSessionID` for keyless access, and the
  Responses-wire routing for the free Muse models is a plausible companion fix. The narrow
  change — a single `X-Session-ID` static header on the `opencode-free` entry — is likely
  correct.
- *Blocker 1, unresolved review question.* Reviewer Ingwannu's `CHANGES_REQUESTED` had two
  parts. The empty-`Authorization` regression **is** fixed at the current head. The
  provider-policy question is not: the reviewer asked for authoritative provider documentation or
  explicit authorization for third-party keyless use, plus the intended session lifetime. The
  PR's in-code comment cites "community reports… (see PR #3954 discussion)" — it cites its own
  thread as its authority. That is a policy question about third-party keyless use, not a code
  question, and it is the reason this is deferred rather than reimplemented now.
- *Blocker 2, fails typecheck.* Merged onto `7dc7dc99e`,
  `src/providers/registry.ts(3044,5)` and `(3047,5)` → `TS1117`. The PR adds empty
  `modelContextWindows: {}` and `modelInputModalities: {}` while dev already declares both at
  `:3018` and `:3021` in the same literal. `bun run typecheck` is a required PR-ready gate.
- *Blocker 3, silently reverts two landed commits.* Same pair as #4016 — `5cd71ec91` (Nous
  `maxResponseBytes` `1_048_576` → `262_144`) and `89b69a00a` (`statelessResponses: true`
  deleted from `opencode-go`, added for #3838). Merge-tree exits 0 because the branch is merely
  stale, so the reversion is invisible to the conflict check.
- *Blocker 4, its own tests fail.* `bun test tests/providers/opencode-free-provider.test.ts` on
  the merged tree → 22 pass / **6 fail**. The six are three distinct tests each declared twice
  with identical bodies; they fail because the duplicate keys mean the later empty literal wins
  at runtime, so `modelContextWindows` is empty.

Shape of the eventual reimplementation, when the policy question is answered: a maintainer branch
on current dev adding **only** the `X-Session-ID` static header (plus the wire defaults if
wanted), touching nothing else in `registry.ts`, with
`Co-authored-by: Omar <37685981+omarjson@users.noreply.github.com>`. Gate it on Ingwannu's
authorization question first — that answer is a prerequisite, not a review comment.

## Verification gates

Per item, in order, all of which must hold before `gh pr merge --squash --admin`:

1. **Head freshness.** `gh pr view <n> --json headRefOid` matches the SHA the focused tests and
   CI ran against. A push after CI invalidates the evidence.
2. **Focused tests green** at the counts named in the item's block, run in the carry worktree.
3. **`bun x tsc --noEmit` exit 0** in the carry worktree. Confirmed exit 0 on the full
   seven-item stack.
4. **Exact-head `ci.yml` success.** `gh pr checks <n> --watch`, then read the conclusion for
   `Cross-platform CI` and confirm it ran on the current head SHA. Skipped or cancelled is not
   a pass. If a lane is missing, dispatch explicitly:
   `gh workflow run ci.yml --repo lidge-jun/opencodex --ref <branch> -f lane=all`, then
   `gh run list --workflow=ci.yml --branch <branch> --limit 1` and
   `gh run view <run-id> --json jobs --jq '[.jobs[]|{name,conclusion}]'`.
5. **Landing proof**, after merge:
   `git fetch origin dev && git merge-base --is-ancestor <squash-sha> FETCH_HEAD && echo LANDED`.
6. **Linked issue closed manually.** PRs target `dev`, and GitHub auto-closes only on merge to
   `main`. After #4018, #4008, #3920 land:
   `gh issue close 4017 --repo lidge-jun/opencodex --comment "Fixed on dev by <PR>."`
   and the same for #4007 and #3916.
7. **`bun run privacy:scan`** exit 0 on any devlog commit in this unit.

### What was NOT RUN

Stated explicitly per the unit's evidence rules:

- **`bun run test` (full suite, ~850 files) — NOT RUN.** Forbidden by this task's scope and by
  the unit's no-local-suite constraint. Only the named focused files were executed.
- **`bun run test:changed` — NOT RUN.**
- **`bun run lint:gui` — NOT RUN**, including for #3863, which touches
  `gui/src/pages/Storage.tsx` and nine i18n files. Hosted CI must cover it.
- **`bun run build:gui` — NOT RUN.**
- **`bun run privacy:scan` — NOT RUN.**
- **Hosted `ci.yml` — NOT RUN at any head in this lane.** No product CI evidence exists for any
  wp2 item. Every LAND row is conditional on a dispatch that has not happened.
- **No push, comment, merge, close, label edit, or branch creation was performed.** All commands
  in this doc are prescriptions.
- **`bun x tsc --noEmit` WAS run** on the composed seven-item stack (exit 0, zero output) and on
  the #4016 merge (two `TS1117` errors), in a scratch worktree that has been removed.
- **#3954's 22 pass / 6 fail figure is carried from the lane doc**, not re-executed here; its
  `TS1117` mechanism was re-confirmed through the identical #4016 failure.

## Ledger rows

`070_wp7_closeout_ledger.md` is the append-only ledger and owns a fixed nine-column schema;
`060_wp6_bun_142.md` is the wp6 Bun execution doc, not a general ledger, so wp2 rows go to
`070` only. Append one row per item as it lands, in the exact column order `070` already
uses, and update `070`'s removal counter row `wp2 PR merges | 7 | <landed> | —` and
`wp5 closes` / `issues auto-closed by merges` as the closes post.

Row template, matching `070`'s header verbatim:

```
| WP | Item | Disposition | Carry branch / PR | Head SHA | CI run id | Landing SHA | Ancestry proof (cmd + exit) | Original closed (comment URL) |
```

Ancestry proof is literally
`git fetch origin dev && git merge-base --is-ancestor <landing-sha> FETCH_HEAD` → exit 0.
Closure proof is the comment URL from `gh pr close` / `gh issue close` plus
`gh issue view N --json state` = `CLOSED`.

Pre-filled with everything known before execution; head SHA, CI run id, landing SHA, ancestry,
and closure are the blanks:

| WP | Item | Disposition | Carry branch / PR | Head SHA | CI run id | Landing SHA | Ancestry proof | Original closed |
|----|------|-------------|-------------------|----------|-----------|-------------|----------------|-----------------|
| wp2 | PR #4018 | LAND_AS_IS | `codex/260909-spark-5h-window` / #____ | _pending_ | _pending_ | _pending_ | _pending_ | #4018 + issue #4017 |
| wp2 | PR #4008 | LAND_AS_IS | `codex/260909-spark-partial-retain` / #____ | _pending_ | _pending_ | _pending_ | _pending_ | #4008 + issue #4007 |
| wp2 | PR #3981 | LAND_AS_IS | `codex/260909-catalog-observation-invalidate` / #____ | _pending_ | _pending_ | _pending_ | _pending_ | #3981 |
| wp2 | PR #3979 | LAND_AS_IS | `codex/260909-websearch-terminal-inactivity` / #____ | _pending_ | _pending_ | _pending_ | _pending_ | #3979 |
| wp2 | PR #3964 | LAND_AS_IS | `codex/260909-muse-meta-websearch-strip` / #____ | _pending_ | _pending_ | _pending_ | _pending_ | #3964 |
| wp2 | PR #3863 | LAND_AS_IS | `codex/260909-combo-caps-storage-skip` / #____ | _pending_ | _pending_ | _pending_ | _pending_ | #3863 (drop `landed-via-maintainer` first) |
| wp2 | PR #3920 | LAND_AS_IS | `codex/260909-ocx1-history-recovery` / #____ | _pending_ | _pending_ | _pending_ | _pending_ | #3920 + issue #3916 |
| wp2 | PR #4016 | CLOSE | — | `3cd59118a` | n/a | n/a | n/a | _comment URL pending_ |
| wp2 | PR #3954 | REIMPLEMENT (deferred) | — | `8b90fbfbb` | n/a | n/a | n/a | stays OPEN — not a removal |

Focused-test counts belong in the wp2 D note rather than in `070`'s columns, since `070` has
no test column. Record them as: #4018 192p/1s/0f (stacked, 3 files) · #4008 11p/0f · #3981
11p/0f · #3979 21p/0f · #3964 16p/0f · #3863 384p/0f · #3920 53p/0f · composed-stack
`bun x tsc --noEmit` exit 0.

Coverage contribution: **7 PR merges + 3 auto-closed issues + 1 PR close = 11 removals**, which
is `070`'s `wp2 PR merges` row (7), three of the seven `issues auto-closed by merges`, and
one of the four PR entries in `wp5 closes`. #3954 stays open and counts as zero.

## Rollback

Each item is one squash commit on `dev`, which is the unit of revert. Nothing in wp2 depends on
another wp2 item at the source level except the `quota.ts` pair, and even those are disjoint
hunks 458 lines apart, so either can be reverted alone.

```bash
cd /Users/jun/Developer/new/700_projects/opencodex && git fetch origin dev
OCX=$(mktemp -d)/wt
git -c core.hooksPath=/dev/null worktree add -b codex/260909-revert-<item> "$OCX" origin/dev
cd "$OCX"
git -c core.hooksPath=/dev/null revert --no-edit <squash-sha>
bun test <the item's focused tests>          # must go back to the pre-landing baseline
git push --no-verify -u origin codex/260909-revert-<item>
gh pr create --repo lidge-jun/opencodex --base dev --draft=false \
  --title "revert: <subject> (<squash-sha>)" --body-file /tmp/wp2-revert-body.md
```

`dev` is branch-protected against direct pushes and force-pushes regardless of `--no-verify`,
so a revert is always a PR. Reopen the linked issue if the reverted item carried a `Closes`:
`gh issue reopen <n> --repo lidge-jun/opencodex`.

Item-specific notes:

- **#3920** — reverting removes rows from `scripts/test-layout/layout.json` and
  `tests/fixtures/test-layout-expected.json`. If a later work-phase added rows to either file
  after #3920 landed, the revert will conflict there. Regenerate both rather than hand-merging,
  then run `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts`.
- **#3863** — touches nine i18n locales. If wp3's sponsor pair landed after it, expect conflicts
  in the same files; take the revert's deletions only for the `storage.cleanup.skippedReferenced`
  key and leave sponsor keys intact.
- **#4018 + #4008** — if both need reverting, revert in reverse landing order (#4008 then #4018)
  so the `quota.ts` hunks unwind in the order they were applied.
- **#4016** — a close is reversible with `gh pr reopen 4016 --repo lidge-jun/opencodex`; the
  comment stays as the record.

## Method and limits

Every `path:line` citation resolves in `/tmp/ocx-249.xGQnxl/wt` at
`7dc7dc99e65268bc8764e19840952256b030bce9`. Live PR state (heads, draft flags, mergeability,
review decisions, file lists, commit authors) was re-read from `gh` while writing this doc, and
matches the lane doc's snapshot for all nine items.

Verification for this doc ran in a scratch worktree created with
`git -C /tmp/ocx-249.xGQnxl/wt worktree add --detach $(mktemp -d)/wt 7dc7dc99e`, with
`node_modules` symlinked from the main checkout. It was removed with
`git worktree remove --force` and `git worktree prune`, and the eight `refs/wp2/pr*` refs it
created were deleted (`git for-each-ref refs/wp2` → 0). The research worktree was never
modified: `git status --porcelain` empty, HEAD unchanged, before and after.

Independently re-verified rather than accepted from the lane doc: the seven-item merge
composition, the `tsc` result on the composed stack, all six focused-test count claims, the
`git apply` failure on #3964's binary asset, the #4016 `TS1117` line numbers, and the two
reverted-commit line numbers on dev. The co-author trailers were read fresh from
`gh pr view --json commits`, which is how the empty-login automation identity on #3981/#3979
was found — the lane doc did not flag it.

