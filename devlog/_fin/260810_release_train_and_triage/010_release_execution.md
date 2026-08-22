# 010 — WP1: release execution

Diff-level runbook for publishing `2.12.0-preview.20260810` and `2.12.0`.

> Revised after the round-1 audit FAIL (`001_audit_round1.md`). The promotion
> model, the recovery path, and the RC rule all changed. Live-head selection is
> recorded in `011_rc_selection.md`; the mandatory security gate is `012`.

## Branch state, pinned from `git ls-remote` (not tracking refs)

| Ref | SHA at plan time |
|-----|------------------|
| `refs/heads/dev` | `0a76ee854a7605b9fed6c7dcc3844c0455425dc2` |
| `refs/heads/preview` | `4d1b1a4676a1dac045161cda0159594cf4e3dbda` |
| `refs/heads/main` | `121f1ad929dc6da3356c06f5192f2f97f7a5dde5` |

Blocker 1 of the audit: `git rev-parse origin/dev` was two commits stale
against the live remote. Every check below re-reads `ls-remote`, and the
promotion step re-reads it again immediately before merging.

## Release-candidate rule

The RC is **the newest `dev` commit that holds a completed successful
Cross-platform CI run on its exact SHA.** Preferring the live head is not
optional politeness: `dc4dd45b0` omits #1398 (bounded live-sideband websocket
frames) and #1396 (bounded reset-credit lookup responses), both
resource-exhaustion hardening rather than cosmetic changes.

Candidates, newest first:

| Candidate | Exact-SHA Cross-platform CI | Status |
|-----------|------------------------------|--------|
| `0a76ee854` (#1396) | run 31355442090 — macOS-only failure, rerun authorized and in flight | preferred if the rerun goes green |
| `277354073` (#1398) | run 31354347276 — macOS-only failure | fallback |
| `dc4dd45b0` (#1368) | run **31352564082 success** (4/4 Linux shards + macOS `10526 pass / 0 fail`) | guaranteed-green floor |

The macOS failures on both newer heads are the same pre-existing Bun 1.3.14
crash, not a product regression:

```
panic: Segmentation fault at address 0xFFFFFFFFFFFFFFF8
oh no: Bun has crashed. This indicates a bug in Bun, not your code.
```

It fires while `server background lifecycle > last-server stop aborts and
drains a startup policy Worker` is in flight — a test neither PR touches — and
the identical signature appears on ancestors `fb2d2e681c` (job `93334694027`)
and `a52238429e` (job `93324406287`).

A correct diagnosis still does not substitute for a green gate: `release.ts`
refuses to dispatch without one, and so does this plan. One `gh run rerun
--failed` is authorized per head. The outcome and the final RC are recorded in
`011_rc_selection.md` before any promotion begins.

## Mandatory gate before promotion

`012_security_gate_record.md` must record a non-`BLOCK` verdict from an independent,
non-author security review of the credential surface on the exact RC. Audit
blocker 4: four of the six credential-boundary PRs in this delta carry no
`APPROVED` review, and #1352 — the CL-03 live credential-lease subsystem — was
authored and merged by the same maintainer. `AGENTS.md` makes that a release
blocker until reviewed.

## Version

- preview: `2.12.0-preview.20260810`
- stable: `2.12.0`

Minor rather than patch because the delta ships user-facing features: the
Compatibility Lab GUI tab and `ocx lab` CLI, and the Turkish locale. This
matches how the repository has actually versioned (`v2.11.0` when features
landed; `v2.10.1`/`v2.10.2` for fix trains).

## Preconditions

| Check | Command | Result |
|-------|---------|--------|
| Typecheck | `bun run typecheck` | exit 0 |
| Full suite | `bun run test` | 10,526 pass / 7 skip / 0 fail (651 files, 344s) |
| Privacy | `bun run privacy:scan` | passed |
| RC↔preview merge | `git merge-tree --write-tree <preview-sha> <RC>` | no conflict |
| RC↔main merge | `git merge-tree --write-tree <main-sha> <RC>` | no conflict |
| main content gap | `git diff --diff-filter=A --name-only <RC> <main-sha>` | **0 files** |

That last row is why this train is simpler than 2026-08-09's: `main` holds no
content the RC lacks, so no cherry-pick reconciliation is needed. Its 21 unique
commits are release bumps plus the fab00 docs already ported into `dev`.

**Clean-tree requirement (audit blocker 6).** `release.ts:297` aborts on any
dirty tree, and this checkout is untracked-dirty with `.dirfd-probe-29692.ok`
(pre-existing, belongs to the user) and this devlog unit. Promotions therefore
run from dedicated clean checkouts:

- `preview`: `/Users/jun/.codex/worktrees/260728-preview/opencodex`
- `main`: `/tmp/ocx-main-release-p8K6ss` — created for this train with
  `git worktree add`, checked out at `main` (`121f1ad92`), `git status
  --porcelain` empty. An earlier revision of this file claimed a main worktree
  existed while step 3 still read `<clean main worktree>`; the audit caught the
  gap and the path above is the real one.

Nothing in the primary checkout is stashed, reset, or deleted.

## Promotion model: sibling merges, not a chain

Audit blocker 3. The RC is merged **independently** into `preview` and into
`main`; the preview release commit is never merged into `main`. That keeps the
prerelease version bump out of the stable line, avoids a manufactured
`package.json` conflict, and matches `MAINTAINERS.md:22` ("promotion to `main`
happens only from `dev`").

```
          ┌── merge RC ──> preview ──> release: v2.12.0-preview.20260810
RC (dev) ─┤
          └── merge RC ──> main ─────> release: v2.12.0
```

Convergence is proven as `RC ⊆ preview` **and** `RC ⊆ main`. It is *not* proven
as `preview ⊆ main`, and requiring that would be the bug.

## Step 1 — promote the RC onto `preview`

```bash
git ls-remote origin refs/heads/preview refs/heads/dev   # re-pin, must match 011
cd /Users/jun/.codex/worktrees/260728-preview/opencodex
git status --porcelain                                    # must be empty
git pull --ff-only origin preview
git merge --no-ff <RC> -m "Merge dev RC <short> into preview: v2.12.0 release candidate"
```

No push here — `release.ts` pushes the branch itself in step 2.

## Step 2 — publish the preview

```bash
bun scripts/release.ts 2.12.0-preview.20260810 --publish
```

What the helper does, in order (`scripts/release.ts`):

1. Guards: branch must be `preview` or `main` (`:281`); `preview` requires the
   `-preview.` suffix (`:288`); tree must be clean; the npm version, git tag,
   and GitHub Release must not already exist.
2. Preflight: `audit:high`, typecheck, full isolated tests, privacy scan.
3. Bumps `package.json`, commits `release: v2.12.0-preview.20260810`, pushes
   `preview`.
4. Waits up to 20 minutes each for exact-SHA `ci.yml` and
   `service-lifecycle.yml` to go green.
5. Re-reads the live remote head (`:335`) and aborts if `preview` moved.
6. Dispatches `release.yml` with `expected-sha` and `dry-run=false`, then
   watches it.

### Recovery when a gate goes red (audit blocker 5)

`waitForSuccessfulCi` (`release.ts:217-228`) calls `process.exit(1)` the moment
it sees a *completed failed* run — and by then the version bump is already
committed and pushed. Re-running the helper then dies at `npm version`, because
the version is already current and `allow-same-version` is false. "Just rerun
it" is not a recovery path.

The real continuation, keyed to the release-bump SHA the helper already pushed:

```bash
RELEASE_SHA=$(git rev-parse HEAD)                       # the release: vX commit
gh run rerun --failed <failed-run-id>                    # once only
gh run list --commit "$RELEASE_SHA" --json workflowName,status,conclusion
# require BOTH Cross-platform CI and Service lifecycle = success, then:
git ls-remote origin refs/heads/<branch>                 # must equal RELEASE_SHA
gh workflow run release.yml --ref <branch> \
  -f version=<version> -f tag=<latest|preview> \
  -f expected-sha="$RELEASE_SHA" -f dry-run=false
gh run watch <dispatched-run-id> --exit-status
```

This mirrors `release.ts:335-346` exactly, including the live-remote head
re-check, and is the same recovery the 2026-08-09 train used.

**Flake budget:** #1302 is open and reproduced after its mitigation. One
`gh run rerun --failed` per gate. A second failure on the same release SHA
stops the train as `BUDGET_EXHAUSTED` rather than being retried again.

## Step 3 — promote the RC onto `main`

The **same RC**, not the preview release commit:

```bash
git ls-remote origin refs/heads/main                      # re-pin
cd /tmp/ocx-main-release-p8K6ss                            # the clean main worktree
git status --porcelain                                     # must be empty
git pull --ff-only origin main
git merge --no-ff 9c051342d -m "Merge dev RC 9c051342d into main: promote the v2.12.0 line"
```

The 2026-08-09 train needed a `commit-tree` merge because `main`'s tree had
regressed to the v2.10.0 era. That is no longer true, and the `merge-tree` dry
run against the RC is clean.

## Step 4 — publish the stable release

```bash
bun scripts/release.ts 2.12.0 --publish
```

Same machinery, npm tag `latest`; `release.ts:292` rejects any prerelease
suffix on `main`.

## Step 5 — verification (all must pass before D)

```bash
npm view @bitkyc08/opencodex dist-tags --json          # latest=2.12.0, preview=2.12.0-preview.20260810
gh release view v2.12.0                                 # draft=false
gh release view v2.12.0-preview.20260810                # prerelease=true
git merge-base --is-ancestor <RC> origin/preview        # exit 0
git merge-base --is-ancestor <RC> origin/main           # exit 0
```

Note the last two: sibling containment of the RC. `preview ⊆ main` is
deliberately **not** asserted — under the sibling model the two release commits
are siblings, and requiring an ancestry between them would be the bug blocker 3
identified.

## Rollback

npm publishes are not revocable in place. If a defect surfaces after publish,
the recovery is a forward patch release, plus `npm dist-tag add
@bitkyc08/opencodex 2.11.1 latest` to point users back at the previous stable
while the fix is prepared. Branch state needs no rollback: every promotion is a
normal merge commit and no history is rewritten.

## Out of scope

Fixing #1302, resolving the Bun macOS segfault, and touching any contributor PR.

"Merging #1398 into this train" was listed here while the RC was `dc4dd45b0`.
It is stale: the re-picked RC `9c051342d` already contains #1398, #1396, and
#1010 (see `011` §"Re-pick after remediation"). Nothing is deferred out of this
train on RC grounds.
