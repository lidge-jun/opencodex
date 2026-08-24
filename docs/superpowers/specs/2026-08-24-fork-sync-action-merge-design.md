# Fork Sync Action Daily-Merge Addendum

Date: 2026-08-24
Status: approved implementation addendum
Parent design: `docs/superpowers/specs/2026-08-22-fork-sync-automation-design.md`

This addendum changes the fork sync boundary after the Action was observed
pinning a vendor tree by checking out `vendor/dev` and then losing the trusted
fork scripts. It keeps detection and fast-forward pinning in the Action, moves
the ordinary daily merge into a testable Action command, and reserves Cursor
for unresolved shared hotspots or disconnected history.

## Goal and non-goals

The scheduled workflow must pin exact upstream release refs without moving
`HEAD`, prepare a merge branch from the checked-out default branch, resolve
only policy-approved conflicts, and open or update a mergeable draft PR. A
human still performs the merge commit into `main`.

This addendum does not auto-merge, force-push, squash, or rebase sync PRs. It
does not rebuild `run/main` for the Action, translate locales, fix product
bugs, or run the full monorepo suite in the workflow. The Action never pushes
`main`, `origin/main`, or a conflicted branch.

## Locked interfaces

```ts
export type PathClass =
  | "fork-owned"
  | "upstream-owned"
  | "shared-hotspot"
  | "recipe";

export interface PrepareResult {
  status: "merged" | "hotspot-handoff" | "history-diverged" | "skipped";
  branch?: string;
  resolutions: Array<{
    path: string;
    classification: PathClass;
    action: string;
  }>;
  unresolved: string[];
  pullRequestNumber?: number;
}

export function pinVendorRef(
  ref: string,
  target: string,
  runner: CommandRunner,
): Promise<void>;
```

`pinVendorRef` accepts only `vendor/main` and `vendor/dev`. It updates a local
branch ref without checking it out:

```text
git fetch . <target>:refs/heads/<ref>
```

The fetch must be fast-forward-only. A rejected non-fast-forward update is
reported as `pin-diverged`. The caller's `HEAD` remains the default-branch
commit captured before pinning.

## Ownership and recipes

The Action and human coordinators share `docs/fork/OWNED.md`. The classifier
uses the same ordered policy:

1. `shared-hotspot` for `src/adapters/google*.ts`,
   `src/server/responses/core.ts`, `src/providers/antigravity-quota.ts`, and
   the Antigravity path in `src/providers/quota.ts`;
2. `fork-owned` for the documented fork-only prefixes;
3. `recipe` for `package.json`;
4. `upstream-owned` for every unknown path.

The `package.json` recipe is the named exception: preserve our package
identity (`name: "@yansigit/opencodex"`), take `version` and every remaining
field from upstream, and write valid JSON. It is not a whole-file
`checkout --ours` or `checkout --theirs` decision.

## Prepare command

`bun scripts/fork/sync/cli.ts prepare` reads one `SyncEvent` JSON object from
stdin and uses only an injected `CommandRunner` in tests. It handles
`pin-updated` and `main-behind` events whose `recommendedLane` is
`"daily-merge"`:

1. create `sync/upstream-YYYYMMDD` from the current default-branch `HEAD`;
2. run `git merge --no-ff vendor/main`;
3. preserve Git's merge commit when there are no conflicts;
4. for conflicts, classify each path, take ours for `fork-owned`, theirs for
   `upstream-owned`, run the package recipe, and stage resolved paths;
5. if any conflict is a `shared-hotspot`, abort the merge and return
   `hotspot-handoff` without pushing;
6. return `merged` with a resolution record only after all conflicts are
   staged and the merge commit succeeds.

`history-diverged`, `pin-diverged`, `detect-failed`, unsupported lanes, and
already-current no-ops do not merge. A disconnected history returns
`history-diverged`; other inapplicable events return `skipped`.

## Draft pull-request client

The injected-fetch GitHub client creates or updates one open draft PR with
base `main` and head `sync/upstream-YYYYMMDD`. The body contains the public
tag SHA and resolution table, but never tokens, webhook secrets, request
bodies, or account identifiers. Idempotency is keyed by the same tag and
head; an existing open sync PR is patched, otherwise one is created. The
client has no merge operation and never calls a merge endpoint.

## Workflow contract

The workflow grants `contents: write`, `issues: write`, and the explicitly
required `pull-requests: write`. It asserts that `HEAD` remains the default
branch after pinning. It invokes `prepare` only for the daily lane; a merged
result pushes only `sync/upstream-*` and then creates or updates the draft PR.
It always emits a GitHub issue for non-noop events. It starts
`cursor-webhook` only when prepare returns `hotspot-handoff` or the event is
`history-diverged`. The workflow and tests continue to forbid `gh pr merge`,
`--force`, `git merge -X`, and `git push origin main`.

## Verification

Every code unit has a failing focused Bun test before implementation. The
pin, ownership/recipe, prepare, PR client, CLI, and workflow suites run after
their respective units. The final implementation runs `bun run typecheck`,
`bun run privacy:scan`, and the focused `bun test tests/fork/...` suites; it
does not run the full monorepo test suite per this task's constraint.
