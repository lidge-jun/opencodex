# 010 — Phase 1: reconcile + promote + publish

## Step map

### Step 1 — Cherry-pick main's real content onto dev

NEW (32 files, all under `devlog/_plan/800_agent-fabric/`): cherry-pick
`ce6e44182^..ec866465a` (9 docs(fab00) commits) onto up-to-date local dev
(origin/dev tip, currently `637711b3e` after PR #1109 landed mid-audit —
re-fetch first). Zero path overlap with dev => zero conflict risk.

Commit style: keep the 9 commits as individual cherry-picks (preserves
authorship/attribution) unless any pick conflicts, in which case squash into
one `docs(fab00): port agent-fabric plan set from main` commit naming the
source range.

NOT ported (with rationale): `12de87905`, `e3b2d6eb9` (version bumps, reverted
at main tip, superseded by dev's 2.10.2 line), `0478256df`/`726e1c7ca`
(self-canceling noop pair), `57140d6f0`/`ac2c446a9` (PR #1265 hotfix — dev
carries the evolved 1,330-line version of `enforce-pr-target.yml` via
`0993c53ae`/`a0740f7f1`/`f7448e7f2`), `36c17d06e`/`8a9c0efa7` (canceling
merge/revert pair).

Verification:

```sh
git fetch origin
git diff origin/main HEAD -- devlog/_plan/800_agent-fabric   # MUST be empty
bun run typecheck   # exit 0
bun run test        # exit 0
bun run privacy:scan # exit 0
```

### Step 2 — Push dev, confirm gates

`git push origin dev` (re-fetch + re-apply immediately before pushing; dev
moved twice during planning). Audit amendment (blocker 1): the cherry-pick
push is docs-only and ci.yml/service-lifecycle.yml push.paths exclude
`devlog/**`, so NO CI run fires on the cherry-pick SHA — green is inherited
from the base SHA `637711b3e` (await in-flight run 31287648122 before
pushing). The binding exact-SHA gates fire on the release SHAs, which touch
package.json, a trigger path for both workflows (scripts/release.ts:323-329).

### Step 3 — preview release

```sh
git checkout preview && git reset --hard origin/preview   # local only; remote untouched
git merge --no-ff origin/dev   # audit amendment (blocker 3): merge-tree dry-run
                               # exits 0 with ZERO conflicts — dev never touched
                               # package.json since merge-base; the merge cleanly
                               # keeps preview's 2.11.0-preview.20260808 line and
                               # release.ts overwrites it. No manual resolution.
bun scripts/release.ts 2.11.1-preview.20260809 --tag preview --publish
```

The helper runs preflight (clean tree + audit + typecheck + tests + privacy
scan), bumps package.json, commits `release: v2.11.1-preview.20260809`, pushes,
waits for ci.yml + service-lifecycle.yml on the exact SHA, dispatches
release.yml with `expected-sha`, watches it.

### Step 4 — main reconciliation + stable release

Main's tree is regressed to v2.10.0-era + fab00 docs by the `8a9c0efa7`
revert-of-merge. A normal `git merge preview` into main would conflict on
~hundreds of files whose "main side" is the regressed tree. Deterministic
alternative (chosen): a merge commit whose tree is exactly preview's release
tree, with both branches as parents:

```sh
tree=$(git rev-parse origin/preview^{tree})   # AFTER step 3's release commit
c=$(git commit-tree "$tree" -p origin/main -p origin/preview \
     -m "Merge branch 'preview' into main: promote v2.11.1 line; reconciles the tree regression from 8a9c0efa7 (revert-of-merge had reset main's tree to the v2.10.0-era); main's tree is now exactly the released preview tree")
git push origin "$c":refs/heads/main
git checkout main && git reset --hard "$c"   # local alignment only
bun scripts/release.ts 2.11.1 --publish
```

This keeps full history on both sides (no force-push), makes `main` contain
`preview` (and therefore `dev`) in ancestry, and sets the tree to the exact
released content. Fallback if the push is rejected (branch protection):
revert-the-revert (`git revert --no-edit 8a9c0efa7` on main) then a normal
merge of preview with conflicts resolved toward preview.

### Step 5 — Final verification + record

```sh
npm view @bitkyc08/opencodex dist-tags --json
# expect: preview = 2.11.1-preview.20260809, latest = 2.11.1
gh release view v2.11.1 --json tagName,isDraft   # exists, not draft
gh release view v2.11.1-preview.20260809         # exists
git fetch origin
git merge-base --is-ancestor origin/dev origin/preview && echo preview-contains-dev
git merge-base --is-ancestor origin/preview origin/main && echo main-contains-preview
git diff origin/main origin/preview --stat       # only the stable version bump delta
```

Then write this unit's closing record (outcome, run IDs, SHAs, dist-tags) and
mark goalplan criteria with capturedEvidence.

## MODIFY / NEW / DELETE map

- NEW: `devlog/_plan/800_agent-fabric/**` (32 files, via cherry-pick — content
  identical to origin/main's copies; byte-verify with the Step-1 diff).
- MODIFY: `package.json` version bumps (2.11.1-preview.20260809 on preview,
  2.11.1 on main) — performed by scripts/release.ts, not by hand.
- NEW: `devlog/_fin/260809_260809-release-train-main-reconcile/020_record.md`
  (closing record, Step 5).
- DELETE: none.
- No `src/`, `gui/`, `tests/`, or workflow changes in this unit.

## TESTS

No new tests (docs + release ops only). Existing gates: `bun run typecheck`,
`bun run test`, `bun run privacy:scan` at Step 1; the release helper re-runs
its own preflight at Steps 3-4.

## Verification (C)

Exact commands per step above; expected exit code 0 for each, plus the named
`gh`/`npm` outputs. Adversarial C check: independently re-fetch and re-run the
ancestry + tree-equality assertions rather than trusting earlier output.
