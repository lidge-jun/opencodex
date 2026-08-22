# Public fork operator guide

Fork-owned. Do not open this tree as an upstream PR to `lidge-jun/opencodex`.

## Remotes

| Remote | URL | Use |
|---|---|---|
| `upstream` | `https://github.com/lidge-jun/opencodex.git` | Integration source (`dev`) and released daily pin (`main`) |
| `origin` | `https://github.com/yansigit/opencodex.git` | Public fork |

The daily pin is **`upstream/main`**. Keep **`upstream/dev`** as the integration
base for upstream PRs.

## Branch lanes

| Branch | Role | Rewritten? | Public default? |
|---|---|---|---|
| `vendor/main` | Fast-forward copy of `upstream/main` | No (FF only) | No |
| `vendor/dev` | Fast-forward copy of `upstream/dev`; `feat/*` PR base only | No (FF only) | No |
| `overlay` | Linear fork stack on `vendor/main` | Yes | No |
| `origin/main` | Released `vendor/main` plus overlay via merge PR | No | Yes |
| `feat/…` | One topic; upstream PRs from `vendor/dev` | Yes until landed | No |
| `run/main` | Disposable daily driver: release + overlay + selected `feat/*` | Yes (rebuilt) | No |
| `run/dev` | Retired as the daily checkout | Yes (if used) | No |
| `sync/upstream-YYYYMMDD` | Throwaway merge + CI, then merge to `origin/main` | Discarded | No |
| `archive/mixed-dev-YYYYMMDD` | Frozen pre-split snapshot | Frozen | No |

Rules:

- Never commit overlay work on `vendor/main` or `vendor/dev`.
- Never open an upstream PR from `origin/main`, `overlay`, or `run/main`.
- After upstream absorbs a patch, drop it from the overlay.
- **Never force-push `origin/main` (or public `main`).**

Path ownership and conflict defaults: [`OWNED.md`](./OWNED.md).

## Rerere (operator only)

Repeat conflict resolutions replay automatically when enabled:

```bash
git config rerere.enabled true
```

Run that yourself in this repo. Agents must not run `git config`.

## Sync `origin/main` with an upstream release

Fetch when working. Merge when **`upstream/main` moves** (a release), and
immediately for security/auth changes on that branch. Do not chase daily
`upstream/dev` movement into `origin/main`.

```bash
git fetch upstream origin --prune
git checkout vendor/main
git merge --ff-only upstream/main
git checkout vendor/dev
git merge --ff-only upstream/dev
git checkout -b sync/upstream-$(date +%Y%m%d) origin/main
git merge --no-ff vendor/main
```

Resolve conflicts using [`OWNED.md`](./OWNED.md). Run focused tests (see the
[daily pin design](../superpowers/specs/2026-08-21-fork-daily-main-pin-design.md)).
Open a sync PR on the fork into `origin/main`. Drop overlay commits already on
upstream.

Never `git merge -X ours` across the tree. If the merge is a disaster: abort, shrink overlay, retry.

## Rebuild `run/main`

Disposable branch: `vendor/main` + overlay + selected unmerged `feat/*`.
Rebuilt, not merged long-term.

```bash
git fetch upstream origin --prune
git checkout vendor/main
git merge --ff-only upstream/main
git checkout -B run/main vendor/main
# apply the overlay commits, in order:
git cherry-pick $(git rev-list --reverse vendor/main..overlay)
# merge selected feat/* PR heads, in order:
git merge origin/feat/antigravity-quota-geoblock
git merge origin/feat/antigravity-cca-wire
git merge origin/feat/antigravity-host-failover
git merge origin/feat/antigravity-account-cooldown
git merge origin/feat/subagent-roles-config
git merge origin/feat/subagent-roles-gui
git merge origin/feat/subagent-roles-sync
git push --force-with-lease origin run/main
```

Stop including a `feat/*` once it is in `vendor/main`, not merely when it is
in `vendor/dev`. Force-push `run/main` only—not `origin/main`.

## One-time split (mixed `dev`)

1. `git branch archive/mixed-dev-2026-08-21` at pre-split HEAD.
2. `git branch vendor/main upstream/main` and `git branch vendor/dev upstream/dev` (FF-only after).
3. Classify `upstream/dev..archive/mixed-dev-*`: drop duplicates, keep open PRs on `feat/*`, cherry-pick local-forever as small `fork:` commits onto `overlay`.
4. Rebuild public `origin/main` from `vendor/main` + overlay only—not the old mixed `dev`.

Classification of the 2026-08-21 mixed snapshot: [`MIXED-SPLIT.md`](./MIXED-SPLIT.md).

Daily pin design: [`2026-08-21-fork-daily-main-pin-design.md`](../superpowers/specs/2026-08-21-fork-daily-main-pin-design.md).

Overlay/seam design: [`2026-08-21-fork-sync-design.md`](../superpowers/specs/2026-08-21-fork-sync-design.md).
