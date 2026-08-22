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
| `origin/main` | Daily driver: release + overlay + selected `feat/*` | No | Yes |
| `feat/…` | One topic; upstream PRs from `vendor/dev` | Yes until landed | No |
| `run/main` | Disposable rebuild workspace; merge into `main`, never force-push `main` | Yes (rebuilt) | No |
| `run/dev` | Retired as the daily checkout | Yes (if used) | No |
| `sync/upstream-YYYYMMDD` | Throwaway merge + CI, then merge to `origin/main` | Discarded | No |
| `archive/mixed-dev-YYYYMMDD` | Frozen pre-split snapshot | Frozen | No |

Rules:

- Never commit overlay work on `vendor/main` or `vendor/dev`.
- Never open an upstream PR from `origin/main`, `overlay`, or `run/main`. Daily checkout is **`main`**.
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
`upstream/dev` movement into `origin/main`. When `main` already carries
replayed `feat/*` patches, rebuild `run/main` and merge that into `main`
instead of merging `vendor/main` directly onto the PR stack.

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

## Rebuild daily `main`

Do not force-push `main`. Rebuild on disposable `run/main`, then merge that
into `main` (first landing may be a fast-forward).

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
git checkout main
git merge --no-ff origin/run/main
git push origin main
```

Stop including a `feat/*` once it is in `vendor/main`, not merely when it is
in `vendor/dev`. Force-push `run/main` only—not `origin/main`.

## One-time split (mixed `dev`)

1. `git branch archive/mixed-dev-2026-08-21` at pre-split HEAD.
2. `git branch vendor/main upstream/main` and `git branch vendor/dev upstream/dev` (FF-only after).
3. Classify `upstream/dev..archive/mixed-dev-*`: drop duplicates, keep open PRs on `feat/*`, cherry-pick local-forever as small `fork:` commits onto `overlay`.
4. Point public `origin/main` at the daily tree (`vendor/main` + overlay + selected `feat/*`)—not the old mixed `dev`.

Classification of the 2026-08-21 mixed snapshot: [`MIXED-SPLIT.md`](./MIXED-SPLIT.md).

Daily pin design: [`2026-08-21-fork-daily-main-pin-design.md`](../superpowers/specs/2026-08-21-fork-daily-main-pin-design.md).

Overlay/seam design: [`2026-08-21-fork-sync-design.md`](../superpowers/specs/2026-08-21-fork-sync-design.md).

## Automated release sync

`.github/workflows/fork-upstream-sync.yml` is a fork-owned poller. It runs on a
schedule or manual dispatch from the trusted default branch, fetches released
`v*` tags from `upstream`, and invokes
`bun scripts/fork/sync/cli.ts pin`. The Action fast-forwards only
`vendor/main` to the newest tag that is on `upstream/main`, and
`vendor/dev` to `upstream/dev` in that same new-tag cycle. It never merges or
force-pushes `origin/main`.

The CLI emits a `SyncEvent` to the enabled plugins. The first notifier,
`github-issue`, upserts a `fork-sync` issue for non-no-op events. The first
coordinator, `cursor-webhook`, sends only `pin-updated` events. A diverged
vendor ref creates an issue but does not start the coordinator; an
`already-current` poll is silent apart from the workflow summary.

The Action needs repository secrets `FORK_SYNC_CURSOR_WEBHOOK_URL` and
`FORK_SYNC_CURSOR_WEBHOOK_SECRET`. Plugin IDs are selected with
`FORK_SYNC_NOTIFIERS` and `FORK_SYNC_COORDINATORS`. The webhook starts the
Cursor Automation described in the fork-sync skill; that agent rebuilds
disposable `run/main`, opens a draft PR and decision table, then stops. A
human reviews and merges `origin/main`.

### Adding another coordinator

Cursor is the first coordinator, not a hard-coded pipeline stage. The registry
accepts multiple comma-separated coordinator IDs, so an operator can run
`FORK_SYNC_COORDINATORS=cursor-webhook,http` or select `cli` without changing
the sync or pin commands.

Use the generic HTTP coordinator for agents that expose an inbound HTTP
endpoint:

```text
FORK_SYNC_COORDINATORS=http
FORK_SYNC_HTTP_URL=https://agent.example/hooks/fork-sync
FORK_SYNC_HTTP_SECRET=<optional HMAC secret>
FORK_SYNC_HTTP_SIGNATURE_HEADER=<optional target header>
FORK_SYNC_HTTP_SIGNATURE_PREFIX=<optional prefix, default sha256=>
FORK_SYNC_HTTP_AUTH_HEADER=<optional complete Authorization value>
```

Use the generic CLI coordinator for a local process that accepts one message
on stdin:

```text
FORK_SYNC_COORDINATORS=cli
FORK_SYNC_CLI_COMMAND=nanobot trigger <trigger-id>
FORK_SYNC_CLI_INPUT=summary
```

The default CLI input is the full event JSON; `summary` is a readable,
credential-free message. Commands are whitespace-separated executable and
arguments. Both generic coordinators send only `pin-updated` and are silent
when their required URL or command is absent.

The current agent mappings are:

- **Hermes:** configure `http` for its gateway webhook route and match its
  route HMAC header and prefix.
- **ZeroClaw:** configure `http` for its webhook channel, or its gateway with
  `FORK_SYNC_HTTP_AUTH_HEADER=Bearer ...`.
- **Nanobot:** create a local trigger, keep `nanobot gateway` running, and
  configure `cli` with `nanobot trigger <trigger-id>`; use `summary` unless
  the target workflow specifically consumes JSON.

If an agent needs a protocol not covered by HTTP or stdin CLI, add one module
under `scripts/fork/sync/coordinators/` implementing `ForkSyncCoordinator`,
register it in `scripts/fork/sync/cli.ts`, add its ID to
`FORK_SYNC_COORDINATORS`, and add a focused test under `tests/fork/`. Update
this section and the design spec with the new environment values. No pipeline
rewrite is needed. Every coordinator must stop at a draft PR or
recommendation; the Action never merges `origin/main`, and a new agent must
preserve that boundary.
