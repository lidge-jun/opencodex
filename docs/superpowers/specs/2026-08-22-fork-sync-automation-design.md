# Fork Sync Automation Design

Date: 2026-08-22  
Status: approved implementation design  
Scope: fork-owned automation for polling released upstream tags, maintaining
the two vendor refs, and notifying a Cursor Automation that prepares a human
reviewable `origin/main` rebuild.

This is a fork-owned document. It must not be opened as a pull request to
`lidge-jun/opencodex`.

## Goal

Keep `origin/main` on released upstream code plus the fork overlay without
auto-merging or force-pushing the public default branch. A GitHub Action polls
`lidge-jun/opencodex` for the newest `v*` tag, fast-forwards the vendor refs,
upserts one tracking issue, and starts a Cursor Automation only after a
successful pin update. The Cursor agent rebuilds disposable `run/main` and
opens a draft PR; a human merges `origin/main`.

## Non-goals and safety rules

- Never auto-merge `origin/main`.
- Never force-push `main` or `origin/main`.
- Never use whole-tree `git merge -X ours` or `git merge -X theirs`.
- Only `vendor/main` and `vendor/dev` may be changed by the pin command.
- `vendor/main` receives the SHA of the latest upstream `v*` tag only when that
  tag is an ancestor of `upstream/main`.
- `vendor/dev` receives `upstream/dev` only in the same cycle as a new main tag.
  A no-op poll never chases `upstream/dev`.
- A diverged vendor ref produces `pin-diverged`, creates an issue, and never
  calls a coordinator.
- `already-current` is a silent no-op apart from the workflow summary.
- Scripts live under `scripts/fork/sync/` and tests under `tests/fork/`. Nothing
  in this feature is imported by `src/router.ts`, `src/server/lifecycle.ts`, or
  `src/server/responses/core.ts`.

## Runtime data contract

`SyncEvent` is the JSON boundary between Action steps, plugins, and the Cursor
Automation:

```ts
export type SyncEventKind =
  | "already-current"
  | "pin-updated"
  | "pin-diverged"
  | "detect-failed";

export interface SyncEvent {
  kind: SyncEventKind;
  upstreamRepo: string;
  latestTag: string;
  latestTagSha: string;
  vendorMainSha: string;
  vendorDevSha: string;
  detectedAt: string;
  error?: string;
}
```

`detectedAt` is an ISO-8601 UTC string. SHA values are full hexadecimal commit
IDs. Errors are short, sanitized operational messages and must never include
webhook URLs, webhook secrets, GitHub tokens, or request bodies.

## Command boundary

The scripts use an injected runner so unit tests never require a live network
or mutate a repository:

```ts
export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner =
  (args: readonly string[]) => Promise<CommandResult>;

export interface DetectOptions {
  upstreamRepo: string;
  runner: CommandRunner;
  now?: () => Date;
}

export function detectLatestVTag(options: DetectOptions): Promise<SyncEvent>;
```

Detection runs `git ls-remote --tags --refs <upstreamRepo> v*`, chooses the
highest version-like `v<major>.<minor>.<patch>` tag (with deterministic
lexical fallback), reads `refs/heads/vendor/main` and
`refs/heads/vendor/dev`, verifies the tag is an ancestor of
`refs/remotes/upstream/main`, then compares it to `vendor/main`. A command
failure returns `detect-failed`. Equal SHAs return `already-current`; a
non-ancestor vendor main returns `pin-diverged`; an ancestor vendor main
returns a candidate event that the pin operation turns into `pin-updated`.

The pin boundary is deliberately narrow:

```ts
export const ALLOWED_VENDOR_REFS: readonly ["vendor/main", "vendor/dev"];
export type AllowedVendorRef = (typeof ALLOWED_VENDOR_REFS)[number];

export function isAllowedVendorRef(ref: string): ref is AllowedVendorRef;

export interface PinOptions {
  runner: CommandRunner;
  upstreamDevRef?: string;
}

export function pinVendorRefs(
  event: SyncEvent,
  options: PinOptions,
): Promise<SyncEvent>;
```

`pinVendorRefs` rejects an unallowlisted ref before invoking git. It executes
`git switch vendor/main`, `git merge --ff-only <latestTagSha>`,
`git switch vendor/dev`, and `git merge --ff-only <upstreamDevRef>`. It does
not run the dev merge for `already-current`, `pin-diverged`, or
`detect-failed`. Any merge failure returns `pin-diverged`; no force operation
is permitted.

## Plugin contracts

```ts
export interface ForkSyncNotifier {
  id: string;
  notify(event: SyncEvent): Promise<void>;
}

export interface ForkSyncCoordinator {
  id: string;
  start(event: SyncEvent): Promise<void>;
}

export function registerNotifier(notifier: ForkSyncNotifier): void;
export function registerCoordinator(coordinator: ForkSyncCoordinator): void;
export function enabledNotifiers(
  env?: Record<string, string | undefined>,
): ForkSyncNotifier[];
export function enabledCoordinators(
  env?: Record<string, string | undefined>,
): ForkSyncCoordinator[];
```

`FORK_SYNC_NOTIFIERS` and `FORK_SYNC_COORDINATORS` are comma-separated IDs.
Whitespace and empty entries are ignored. An unknown ID is an error. Built-ins
are registered by the CLI: `github-issue` and `cursor-webhook`. Registries
remain extensible so a future notifier or coordinator is one module plus an
environment ID.

The GitHub issue notifier uses an injected REST client:

```ts
export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: Array<{ name?: string } | string>;
}

export interface GitHubIssuesClient {
  listOpen(options: { label: string }): Promise<GitHubIssue[]>;
  create(options: {
    title: string;
    body: string;
    labels: string[];
  }): Promise<void>;
  update(options: {
    issueNumber: number;
    title: string;
    body: string;
    labels: string[];
  }): Promise<void>;
}

export interface GitHubIssueNotifierOptions {
  client: GitHubIssuesClient;
  upstreamRepo: string;
}

export function createGitHubIssueNotifier(
  options: GitHubIssueNotifierOptions,
): ForkSyncNotifier;
```

It lists open issues with the `fork-sync` label, finds the issue whose body or
title contains the current tag, and updates it; otherwise it creates one.
`already-current` is ignored. Issue text contains only the public upstream
repo, tag, SHAs, event kind, and remediation guidance.

The Cursor coordinator uses an injected fetch implementation:

```ts
export interface CursorWebhookOptions {
  url?: string;
  secret?: string;
  fetchImpl?: typeof fetch;
}

export function createCursorWebhookCoordinator(
  options: CursorWebhookOptions,
): ForkSyncCoordinator;
```

It posts only `pin-updated` events. The body is `JSON.stringify(event)` and the
request has `content-type: application/json` and
`x-fork-sync-signature: sha256=<hex HMAC-SHA256>`. Missing URL or secret is a
silent no-op. Non-2xx responses throw without logging credentials.

## CLI and workflow boundary

`bun scripts/fork/sync/cli.ts detect|pin|emit` is the only executable entry
point. `detect` prints a `SyncEvent`; `pin` detects, pins, and prints its final
event; `emit` reads one event JSON object from stdin, calls enabled notifiers,
then calls enabled coordinators. The CLI obtains `GITHUB_REPOSITORY`,
`GITHUB_TOKEN`, `FORK_SYNC_CURSOR_WEBHOOK_URL`, and
`FORK_SYNC_CURSOR_WEBHOOK_SECRET` from the environment. Secrets are never
printed.

The workflow `.github/workflows/fork-upstream-sync.yml`:

- runs on a schedule and `workflow_dispatch`;
- checks out `${{ github.event.repository.default_branch }}` with
  `actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2`;
- grants `contents: write` and `issues: write`, with no
  `pull-requests: write`;
- fetches upstream tags/main/dev;
- runs `pin`, writes the event to an ignored temporary file, and runs `emit`;
- exposes only the two named webhook secrets to `emit`;
- has a concurrency group with `cancel-in-progress: false`;
- contains no merge, pull-request, or force-push step.

## Tests

The focused suites are:

- `tests/fork/sync-detect.test.ts`: version selection, ancestor validation,
  already-current, behind, diverged, and command failure.
- `tests/fork/sync-pin.test.ts`: exact allowed refs, ff-only command sequence,
  dev pin only on a new tag, and merge failure classification.
- `tests/fork/sync-notify.test.ts`: issue creation, same-tag update,
  already-current suppression, label preservation, and safe body content.
- `tests/fork/sync-webhook.test.ts`: pin-updated POST, HMAC header, no-op
  events, missing credentials, and non-2xx failure.
- `tests/fork/sync-cli.test.ts`: command dispatch, JSON stdin/stdout,
  environment-selected plugin IDs, and secret-free output.
- `tests/fork/sync-workflow.test.ts`: checkout SHA, default-branch ref,
  permissions, concurrency, secret names, and absence of
  `pull-requests: write` or force-push.

## Operational handoff

The parent agent must create the Cursor Automation after
`.cursor/skills/opencodex-fork-sync/automation-prompt.md` is committed. The
operator supplies `FORK_SYNC_CURSOR_WEBHOOK_URL` and
`FORK_SYNC_CURSOR_WEBHOOK_SECRET` as repository secrets. The automation stops
after creating a draft PR and decision table; a human merges `origin/main`.
