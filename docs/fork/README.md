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
| `overlay` | **Retired.** Former linear fork stack; do not check out or merge | — | No |
| `origin/main` | Daily driver: released `vendor/main` + `fork:` deltas + selected `feat/*` | No | Yes |
| `feat/…` | One topic; upstream PRs from `vendor/dev` | Yes until landed | No |
| `run/main` | Disposable rebuild workspace; merge into `main`, never force-push `main` | Yes (rebuilt) | No |
| `run/dev` | Retired as the daily checkout | Yes (if used) | No |
| `sync/upstream-YYYYMMDD` | Throwaway merge + CI, then merge to `origin/main` | Discarded | No |
| `archive/mixed-dev-YYYYMMDD` | Frozen pre-split snapshot | Frozen | No |

Rules:

- Never commit `fork:` work on `vendor/main` or `vendor/dev`.
- Never open an upstream PR from `origin/main` or `run/main` (leftover `overlay` is the same ban). Daily checkout is **`main`**.
- After upstream absorbs a patch, drop the matching `fork:` commit from `main` on the next sync.
- **Never force-push `origin/main` (or public `main`).**
- The normal coordinator lane is a merge from the current `origin/main`.
  Never run `git switch -C run/main vendor/main` for a daily release; that
  disconnected rebuild is permitted only for `history-diverged`.

Path ownership and conflict defaults: [`OWNED.md`](./OWNED.md).

## Rerere (operator only)

Repeat conflict resolutions replay automatically when enabled:

```bash
git config rerere.enabled true
```

Run that yourself in this repo. Agents must not run `git config`.

## Sync `origin/main` with an upstream release

The daily path is this merge-from-`main` flow. Fetch when working and merge
when **`upstream/main` moves** (a release), with security/auth changes on that
branch handled immediately. Do not chase daily `upstream/dev` movement into
`origin/main`.

```bash
git fetch upstream origin --prune
git switch vendor/main
git merge --ff-only upstream/main
git switch vendor/dev
git merge --ff-only upstream/dev
git switch -c sync/upstream-$(date +%Y%m%d) origin/main
git merge --no-ff origin/vendor/main
```

Resolve conflicts using [`OWNED.md`](./OWNED.md). Run focused tests for every
changed domain. Open or update a draft PR on the fork from
`sync/upstream-YYYYMMDD` into `main`, and check
`gh pr view <number> --json mergeable -q .mergeable` until it reports
`MERGEABLE`. The human creates the **merge commit** / **Merge pull request**.
Never squash or rebase these sync PRs.

If a disconnected rebuild is ever required for `history-diverged`, keep it as
the emergency/catch-up recipe only. After the rebuild is reviewed, check out
`run/main` first and
record the old `main` parent with an ours merge, leaving the rebuild tree
unchanged:

```bash
git switch run/main
git merge --no-ff -s ours origin/main -m "Merge origin/main into run/main, keep rebuilt tree"
git push origin run/main
```

This catch-up `-s ours` is the documented exception to the no-whole-tree-ours
rule, and is valid only while `run/main` is checked out. Do not recursively
merge old `main` into the rebuild: that would reintroduce dropped commits
(for example `macos-app`). Never force-push `main`.

## One-time split (mixed `dev`)

1. `git branch archive/mixed-dev-2026-08-21` at pre-split HEAD.
2. `git branch vendor/main upstream/main` and `git branch vendor/dev upstream/dev` (FF-only after).
3. Classify `upstream/dev..archive/mixed-dev-*`: drop duplicates, keep open PRs on `feat/*`, cherry-pick local-forever as small `fork:` commits onto `origin/main`.
4. Point public `origin/main` at the daily tree (`vendor/main` + `fork:` deltas + selected `feat/*`)—not the old mixed `dev`.

Classification of the 2026-08-21 mixed snapshot: [`MIXED-SPLIT.md`](./MIXED-SPLIT.md).

Historical design (the `overlay` git branch is retired): [`2026-08-21-fork-daily-main-pin-design.md`](../superpowers/specs/2026-08-21-fork-daily-main-pin-design.md), [`2026-08-21-fork-sync-design.md`](../superpowers/specs/2026-08-21-fork-sync-design.md).

Fork-owned Jules dispatch, exact-head Cursor Bugbot review, and the staged
maintenance rollout are documented in [`AGENT-MAINTENANCE.md`](./AGENT-MAINTENANCE.md).

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
coordinator, `cursor-webhook`, sends `pin-updated`, `main-behind`, and
`history-diverged` events. A diverged vendor ref creates an issue but does not
start the coordinator; an `already-current` poll is silent apart from the
workflow summary only when `vendor/main` is already contained in `main`.

The Action needs repository secrets `FORK_SYNC_CURSOR_WEBHOOK_URL` and
`FORK_SYNC_CURSOR_WEBHOOK_SECRET`. Plugin IDs are selected with
`FORK_SYNC_NOTIFIERS` and `FORK_SYNC_COORDINATORS`. The webhook starts the
Cursor Automation described in the fork-sync skill; that agent creates the
merge-from-`main` sync branch, opens or updates a draft PR and decision table,
and waits until `gh pr view --json mergeable` reports `MERGEABLE` before
stopping. A human reviews and creates the merge commit for `origin/main`;
never squash or rebase these sync PRs. A timeout-only `macos-launchd` check
flake may be retried with `gh run rerun`; do not edit the upstream lifecycle
workflow for that flake.

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
arguments. Both generic coordinators send `pin-updated`, `main-behind`, and
`history-diverged`, and are silent when their required URL or command is absent.

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
