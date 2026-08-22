# Fork Sync Automation Design

Date: 2026-08-22
Status: approved implementation design
Scope: fork-owned automation for polling released upstream tags, maintaining
the two vendor refs, and notifying a configured coordinator that prepares a
human-reviewable merge from the current `origin/main`. Cursor is the first
coordinator.

This is a fork-owned document. It must not be opened as a pull request to
`lidge-jun/opencodex`.

## Goal

Keep `origin/main` on released upstream code plus the fork overlay without
auto-merging or force-pushing the public default branch. A GitHub Action polls
`lidge-jun/opencodex` for the newest `v*` tag, fast-forwards the vendor refs,
upserts one tracking issue, and starts configured coordinators only after a
successful pin update. The first coordinator, Cursor, performs the daily merge
from the current `origin/main` and opens a draft PR. It uses the disconnected
`run/main` rebuild only for a `history-diverged` event; a human merges
`origin/main`.

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
- `already-current` is silent apart from the workflow summary only when
  `vendor/main` is already contained in the fork's default branch. If the pin
  is still absent from `main`, lane annotation changes the event to
  `main-behind` or `history-diverged` and the configured coordinator is
  notified.
- Scripts live under `scripts/fork/sync/` and tests under `tests/fork/`. Nothing
  in this feature is imported by `src/router.ts`, `src/server/lifecycle.ts`, or
  `src/server/responses/core.ts`.

## Runtime data contract

`SyncEvent` is the JSON boundary between Action steps, plugins, and the
coordinators:

```ts
export type SyncEventKind =
  | "already-current"
  | "pin-updated"
  | "main-behind"
  | "history-diverged"
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
  vendorContainedInMain?: boolean;
  mergeBaseCount?: number;
  recommendedLane?: "noop" | "daily-merge" | "emergency-rebuild";
  error?: string;
}
```

`detectedAt` is an ISO-8601 UTC string. SHA values are full hexadecimal commit
IDs. Errors are short, sanitized operational messages and must never include
webhook URLs, webhook secrets, GitHub tokens, or request bodies.

After detection and pinning, the CLI annotates the lane against the default
branch ref (`HEAD` in the Action checkout). It uses
`git merge-base --is-ancestor <vendorMainSha> <mainRef>` for
`vendorContainedInMain` and counts the lines from
`git merge-base --all <mainRef> <vendorMainSha>` for `mergeBaseCount`.
Missing refs leave these optional fields unset and preserve the original event
kind. Only `already-current` and `pin-updated` are reclassified:

- more than one merge base → `history-diverged` and
  `recommendedLane: "emergency-rebuild"`;
- `already-current`, not contained, with one merge base → `main-behind` and
  `recommendedLane: "daily-merge"`;
- `pin-updated` with one merge base → remains `pin-updated` with
  `recommendedLane: "daily-merge"`;
- contained `already-current` → remains `already-current` with
  `recommendedLane: "noop"`.

`pin-diverged` and `detect-failed` are never reclassified.

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

export type ProcessRunner =
  (args: readonly string[], stdin: string) => Promise<CommandResult>;

export type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

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
are registered by the CLI: `github-issue`, `cursor-webhook`, `http`, and
`cli`. Registries remain extensible so a future notifier or coordinator is one
module plus an environment ID.

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
`already-current` is ignored only when `vendor/main` is contained in `main`.
Issue text contains only the public upstream repo, tag, SHAs, event kind,
`recommendedLane`, and remediation guidance. Daily-merge events say to open or
update a merge-from-main draft PR; only history-diverged events say to rebuild
`run/main`.

The Cursor coordinator uses an injected fetch implementation:

```ts
export interface CursorWebhookOptions {
  url?: string;
  secret?: string;
  fetchImpl?: FetchImplementation;
}

export function createCursorWebhookCoordinator(
  options: CursorWebhookOptions,
): ForkSyncCoordinator;
```

It posts only `pin-updated`, `main-behind`, and `history-diverged` events. The
body is `JSON.stringify(event)` and the request has `content-type:
application/json` and
`x-fork-sync-signature: sha256=<hex HMAC-SHA256>`. Missing URL or secret is a
silent no-op. Non-2xx responses throw without logging credentials.

The generic HTTP coordinator uses the same injected fetch boundary:

```ts
export interface HttpCoordinatorOptions {
  url?: string;
  secret?: string;
  signatureHeader?: string;
  signaturePrefix?: string;
  authHeader?: string;
  errorLabel?: string;
  fetchImpl?: FetchImplementation;
}

export function createHttpCoordinator(
  options: HttpCoordinatorOptions,
): ForkSyncCoordinator;
```

It posts only `pin-updated`, `main-behind`, and `history-diverged` events when a
URL is configured. A secret adds an HMAC-SHA256 header, defaulting to
`x-fork-sync-signature: sha256=<hex>`. `signatureHeader` and
`signaturePrefix` adapt the header spelling and encoding required by another
agent. `authHeader` supports HTTP endpoints such as a bearer-token gateway.
Missing URL is a silent no-op, and non-2xx responses throw without logging
credentials.

The generic CLI coordinator sends the event to a configured local process:

```ts
export interface CliCoordinatorOptions {
  command?: string;
  input?: "json" | "summary";
  runner?: ProcessRunner;
}

export function createCliCoordinator(
  options: CliCoordinatorOptions,
): ForkSyncCoordinator;
```

The command is whitespace-separated executable/argument text and receives one
event on stdin. `json` is the default input; `summary` sends a readable,
credential-free release summary. It runs for `pin-updated`, `main-behind`, and
`history-diverged`, does nothing when the command is missing, and throws on a
non-zero exit code.

These adapter kinds cover the current extension points:

- **Hermes:** its gateway webhook routes accept HTTP POSTs with route-level HMAC
  validation, so use `http` with the route URL, secret, and target signature
  header/prefix.
- **ZeroClaw:** its webhook channel accepts HTTP POSTs with an optional HMAC,
  while its gateway accepts bearer-authenticated HTTP; use `http` with either
  the signature settings or `authHeader`.
- **Nanobot:** local triggers are delivered through `nanobot trigger` and
  Nanobot documents an external webhook as a small service that invokes that
  command, so use `cli` with `nanobot trigger <trigger-id>` and `summary`
  input.

To add an agent that fits one of these kinds, add its ID to the workflow's
`FORK_SYNC_COORDINATORS`, configure the corresponding `FORK_SYNC_HTTP_*` or
`FORK_SYNC_CLI_*` environment values, add a focused adapter test, and update
the operator docs. For a protocol that fits neither kind, add one coordinator
module implementing `ForkSyncCoordinator`, register it in `registerBuiltins`,
give it a stable ID, add a focused test, and document its environment values.
No sync, pin, notifier, or workflow pipeline rewrite is required.

## CLI and workflow boundary

`bun scripts/fork/sync/cli.ts detect|pin|emit` is the only executable entry
point. `detect` prints a `SyncEvent`; `pin` detects, pins, and prints its final
event; `emit` reads one event JSON object from stdin, calls enabled notifiers,
then calls enabled coordinators. The CLI obtains `GITHUB_REPOSITORY`,
`GITHUB_TOKEN`, the Cursor webhook values, the generic HTTP values
(`FORK_SYNC_HTTP_URL`, optional secret/signature/auth values), and the generic
CLI values (`FORK_SYNC_CLI_COMMAND` and optional `FORK_SYNC_CLI_INPUT`) from
the environment. Secrets are never printed.

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
- `tests/fork/sync-webhook.test.ts`: Cursor pin-updated POST, HMAC header,
  no-op events, missing credentials, and non-2xx failure.
- `tests/fork/sync-generic-http.test.ts`: configurable HMAC/auth HTTP POSTs,
  unsigned endpoints, and no-op events.
- `tests/fork/sync-generic-cli.test.ts`: JSON/summary stdin, command
  execution, no-op events, and non-zero exit handling.
- `tests/fork/sync-cli.test.ts`: command dispatch, JSON stdin/stdout,
  environment-selected plugin IDs, and secret-free output.
- `tests/fork/sync-workflow.test.ts`: checkout SHA, default-branch ref,
  permissions, concurrency, secret names, and absence of
  `pull-requests: write` or force-push.

## Operational handoff

The parent agent must create the Cursor Automation after
`.cursor/skills/opencodex-fork-sync/automation-prompt.md` is committed. The
operator supplies `FORK_SYNC_CURSOR_WEBHOOK_URL` and
`FORK_SYNC_CURSOR_WEBHOOK_SECRET` as repository secrets and selects
`cursor-webhook` as the first coordinator. Other coordinators may be enabled
alongside it, but every agent must stop after a draft PR or recommendation;
none may merge `origin/main`.
