# Public fork operator guide

Fork-owned. Do not open this tree as an upstream PR to `lidge-jun/opencodex`.

## Remotes

| Remote | URL | Use |
|---|---|---|
| `upstream` | `https://github.com/lidge-jun/opencodex.git` | Integration source (`dev`) |
| `origin` | `https://github.com/yansigit/opencodex.git` | Public fork |

Track **`upstream/dev`**, not `upstream/main` (release-only on upstream).

## Branch lanes

| Branch | Role | Rewritten? | Public default? |
|---|---|---|---|
| `vendor/dev` | Fast-forward copy of `upstream/dev` | No (FF only) | No |
| `main` | Daily driver: `vendor/dev` + curated overlay | No | Yes |
| `overlay` | Optional linear local-forever stack | Yes | No |
| `feat/…` | One topic; upstream PRs from `vendor/dev` | Yes until landed | No |
| `run/dev` | Disposable run branch (see below) | Yes (rebuilt) | No |
| `sync/upstream-YYYYMMDD` | Throwaway merge + CI, then merge to `main` | Discarded | No |
| `archive/mixed-dev-YYYYMMDD` | Frozen pre-split snapshot | Frozen | No |

Rules:

- Never commit overlay work on `vendor/dev`.
- Never open an upstream PR from `main`, `overlay`, or `run/dev`.
- After upstream absorbs a patch, drop it from the overlay.
- **Never force-push `main`.**

Path ownership and conflict defaults: [`OWNED.md`](./OWNED.md).

## Rerere (operator only)

Repeat conflict resolutions replay automatically when enabled:

```bash
git config rerere.enabled true
```

Run that yourself in this repo. Agents must not run `git config`.

## Sync `main` with upstream

Cadence: fetch daily; merge at least weekly; immediately for security/auth/CI; keep drift under ~7–10 days.

```bash
git fetch upstream --prune
git checkout vendor/dev
git merge --ff-only upstream/dev
git checkout -b sync/upstream-$(date +%Y%m%d) main
git merge --no-ff vendor/dev
```

Resolve conflicts using [`OWNED.md`](./OWNED.md). Run focused tests (see spec). Open a sync PR on the fork into `main`. Drop overlay commits already on upstream.

Never `git merge -X ours` across the tree. If the merge is a disaster: abort, shrink overlay, retry.

## Rebuild `run/dev`

Disposable branch: vendor + selected unmerged `feat/*` + overlay. Rebuilt, not merged long-term.

```bash
git fetch upstream --prune
git checkout vendor/dev
git merge --ff-only upstream/dev
git checkout -B run/dev vendor/dev
# cherry-pick or merge selected feat/* not yet in vendor/dev
git cherry-pick <commits from vendor/dev..main>   # overlay delta
git push --force-with-lease origin run/dev
```

Stop including a `feat/*` once it is in `vendor/dev`. Force-push `run/dev` only—not `main`.

## One-time split (mixed `dev`)

1. `git branch archive/mixed-dev-2026-08-21` at pre-split HEAD.
2. `git branch vendor/dev upstream/dev` (FF-only after).
3. Classify `upstream/dev..archive/mixed-dev-*`: drop duplicates, keep open PRs on `feat/*`, cherry-pick local-forever as small `fork:` commits onto `main`.
4. Rebuild public `main` from `vendor/dev` + overlay only—not the old mixed `dev`.

Full design: `docs/superpowers/specs/2026-08-21-fork-sync-design.md`.
