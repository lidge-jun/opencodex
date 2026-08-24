---
name: opencodex-fork-sync
description: Use when performing an opencodex public-fork sync, updating vendor/main or vendor/dev, merging upstream/main into origin/main, rebuilding run/main then merging into main, or resolving fork-sync conflicts.
---

# opencodex fork sync

Read `docs/fork/OWNED.md` before resolving any conflict. The GitHub Action
owns detection, ref-only pinning, and the ordinary daily merge through a
mergeable draft PR. Cursor Automation owns only shared-hotspot handoff and
disconnected-history recovery; agents analyze, recommend, and test; a human
confirms and lands `origin/main`.

## Roles

| Role | Does | Must not |
|---|---|---|
| Coordinator | Reviews hotspot or emergency handoffs, assembles the decision table, and leaves the draft PR mergeable | Resolve Action-owned daily hunks itself or use whole-tree `-X ours` |
| File worker | Owns one conflict domain and reports 3-way intent, options, recommendation, and tests | Touch another domain or commit `main` |
| Test worker | Runs named tests; runs typecheck/full suite for shared runtime, routing, config, or server changes | Claim green without command output |
| Absorbed-patch worker | Compares `fork:` commits on `origin/main` with upstream and identifies duplicates to drop | Keep a patch merely because the fork wrote it first |

Parallelize independent domains. Serialize `src/adapters/google.ts` and `src/server/responses/core.ts`.
Workers must be **Composer 2.5** or **GPT 5.6 Luna**.

## Action stages 1–5

The fork workflow polls released `v*` tags on `lidge-jun/opencodex`. It checks
out the repository default branch, fetches `upstream/main`, `upstream/dev`,
and tags, then pins refs without moving `HEAD`, prepares daily merges, and
opens or updates a draft PR:

```bash
bun scripts/fork/sync/cli.ts pin > "$RUNNER_TEMP/fork-sync-event.json"
bun scripts/fork/sync/cli.ts prepare < "$RUNNER_TEMP/fork-sync-event.json"
bun scripts/fork/sync/cli.ts draft-pr < "$RUNNER_TEMP/fork-sync-draft-pr.json"
```

Only `vendor/main` and `vendor/dev` are allowlisted, and both updates use
fast-forward-only fetch refspecs. `vendor/dev` moves only when a new main tag
is pinned. The Action has `contents: write`, `issues: write`, and
`pull-requests: write`, and never merges or force-pushes `origin/main`.
`already-current` is silent only
when `vendor/main` is already contained in `main`; otherwise lane annotation
emits `main-behind` or `history-diverged`.
`pin-diverged` creates the tracking issue but does not start the webhook.

## Manual sync commands

```bash
git fetch upstream origin --prune
git fetch . upstream/main:refs/heads/vendor/main
git fetch . upstream/dev:refs/heads/vendor/dev
# PR-base only; do not merge vendor/dev into origin/main
git switch -c sync/upstream-YYYYMMDD origin/main
git merge --no-ff vendor/main
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
gh pr create --base main --head sync/upstream-YYYYMMDD --title "sync: upstream YYYYMMDD" --body "<summary and verification>"
```

Open the sync PR as a draft and stop only when
`gh pr view <number> --json mergeable -q .mergeable` reports `MERGEABLE`.
Never ping the human before that gate is true. The human performs the merge
commit; never squash or rebase these sync PRs. `vendor/main` remains an exact
fast-forward of `upstream/main`; `vendor/dev` remains an exact fast-forward of
`upstream/dev` for PR bases only. Do not commit `fork:` work on either vendor
branch. The issue notifier is selected by `FORK_SYNC_NOTIFIERS=github-issue`;
the Cursor coordinator is selected by `FORK_SYNC_COORDINATORS=cursor-webhook`.

Cursor is the first coordinator, not the only supported integration. The
registry accepts comma-separated IDs and can run multiple coordinators, for
example `FORK_SYNC_COORDINATORS=cursor-webhook,http`.

## Other agent coordinators

Use the generic HTTP coordinator for an agent with an inbound HTTP endpoint:

```text
FORK_SYNC_COORDINATORS=http
FORK_SYNC_HTTP_URL=https://agent.example/hooks/fork-sync
FORK_SYNC_HTTP_SECRET=<optional HMAC secret>
FORK_SYNC_HTTP_SIGNATURE_HEADER=<optional target header>
FORK_SYNC_HTTP_SIGNATURE_PREFIX=<optional prefix, default sha256=>
FORK_SYNC_HTTP_AUTH_HEADER=<optional complete Authorization value>
```

It sends JSON `POST` requests only for `pin-updated`, `main-behind`, and
`history-diverged`. A configured secret adds an HMAC-SHA256 signature; an auth
header supports bearer-token endpoints. It does not print any of these values.

Use the generic CLI coordinator for a local agent process that accepts a
message on stdin:

```text
FORK_SYNC_COORDINATORS=cli
FORK_SYNC_CLI_COMMAND=nanobot trigger <trigger-id>
FORK_SYNC_CLI_INPUT=summary
```

The CLI defaults to JSON stdin; `summary` sends a readable,
credential-free event summary. The command is whitespace-separated executable
and arguments, runs for `pin-updated`, `main-behind`, and `history-diverged`,
and must exit successfully.

The mapping for currently researched open-source agents is:

- **Hermes:** use `http` for its HMAC-protected gateway webhook route.
- **ZeroClaw:** use `http` for its webhook channel, or its bearer-authenticated
  gateway endpoint.
- **Nanobot:** use `cli` with a local trigger and a running `nanobot gateway`;
  Nanobot's documented external-webhook path invokes `nanobot trigger`.

To support an agent that does not fit either adapter, add one coordinator
module implementing `ForkSyncCoordinator`, register it in
`registerBuiltins` in `scripts/fork/sync/cli.ts`, select its stable ID in
`FORK_SYNC_COORDINATORS`, and add a focused test and documentation. This is
the complete extension recipe; do not rewrite detection, pinning, issue
notification, or workflow stages. The Action still never merges
`origin/main`, and every coordinator must stop at a draft PR or
recommendation, just like Cursor.

## Cursor Automation stages 3–8

The webhook-triggered Cursor Automation starts only for `hotspot-handoff` or
`history-diverged`. The Action already creates `sync/upstream-YYYYMMDD` from
the checked-out default branch, merges `vendor/main`, resolves fork-owned and
upstream-owned files, applies recipes, pushes the sync branch, and opens or
updates a draft PR.

For a hotspot handoff, recreate the sync branch from current `origin/main`,
merge `origin/vendor/main`, and read `docs/fork/OWNED.md` before resolving
conflicts. The Action never pushes a conflicted branch. For
`history-diverged`, use the disconnected `run/main` rebuild only.
Replay `fork:` commits on `origin/main` or feature patches only when they are not already contained,
using `scripts/fork/sync/contained.ts` or
`git merge-base --is-ancestor`; do not rely on patch-id alone. Run the exact
focused tests for changed domains, assemble the required conflict decision
table, and open or update a draft PR into `main`. Confirm
`gh pr view --json mergeable` is `MERGEABLE` before stopping or pinging the
human. The human then performs the merge commit. Do not merge it from the
automation.

If histories diverge again, a disconnected `run/main` rebuild is an emergency
recipe only. After reviewing that rebuild, check out `run/main` first and use
the catch-up `git merge --no-ff -s ours origin/main` to record the old parent
without changing the rebuilt tree. This is the only documented `-s ours`
exception. Never use whole-tree `git merge -X ours` or `git merge -X theirs`,
and never recursively merge old `main` into a rebuild.

Never run `git switch -C run/main vendor/main` on the daily path. If histories
diverge, use that disconnected `run/main` rebuild only for
`history-diverged`, then apply the documented catch-up merge. Never squash or
rebase these fork sync PRs. Do not retarget upstream PRs to upstream `main`,
and stop replaying a `feat/*` once it is contained in the sync branch or
`vendor/main`. A timeout-only `macos-launchd` check flake may be retried with
`gh run rerun`; do not edit the upstream lifecycle workflow.

## Conflict report (required for every conflict)

```text
file/hunk:
upstream intent:
overlay intent:
classification: upstream-owned | fork-owned | shared-hotspot
options: theirs+reapply | ours | true merge | drop absorbed | extract to src/fork/
recommendation: (correctness, then features, then fewer future conflicts)
exact test commands:
```

| Classification | Default |
|---|---|
| `upstream-owned` | Take theirs; re-apply still-needed fork intent as a small new commit |
| `fork-owned` | Take ours |
| `shared-hotspot` | Manual/agent report; preserve upstream control flow and re-fit fork behavior |
| Lockfile | Take theirs; regenerate if the fork added dependencies |
| Absorbed idea | Drop ours |

## Decision policy

| Mode | Cases |
|---|---|
| Auto-propose (still show) | Whitespace, comments, locale-only, lockfile theirs + reinstall |
| Always wait | Auth, OAuth, adapters, `src/server/responses/core.ts`, workflows, behavior changes |
| Never | Skip failing tests; force-push `main`; delete a fork feature just to clean the merge without an explicit drop decision |

Tests:

```bash
bun test tests/<matching>.test.ts
bun run typecheck
bun run test
bun run privacy:scan
```

Use the focused matching adapter test for provider changes (for example `bun test tests/google-hardening.test.ts`). Use typecheck and the full suite for shared runtime/routing/config/server changes; use privacy scanning for logging or credential changes. Do not claim completion without output.

Never run `git config`; never use whole-tree `git merge -X ours` or `-X theirs`; never force-push `main`; never skip a failing test. Never open upstream PRs from `main`, leftover `overlay`, `run/main`, `run/dev`, or `dev`. Upstream PRs come from isolated `feat/*` branches based on `vendor/dev`. The `overlay` git branch is retired. Overlay patches are `fork:` commits on `origin/main`.
