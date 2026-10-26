# 10 — `ocx sync --expect-link` / `--expect-hub-key` (issue #7694)

Class C3 (CLI contract + client lifecycle). Single work-phase `wp1`.

## Problem

`ocx sync` (`src/cli/dispatch.ts`, `sync` runner) reads `readClientConnectionState()` without a
lock and picks a path from it: connected -> `syncConnectedClient`; disconnected -> local
`syncModelsToCodex`. GOAT runs `ocx connect status --json` and then `ocx sync`; if the Child was
disconnected or relinked in between, sync quietly applies local providers or another Home.

## Contract

- `ocx sync --expect-link <linkId>`: proceed only when, under the lock that selects the path, the
  machine is a connected Remote Link Child (`transport: "link"`) whose saved `link.linkId` equals
  `<linkId>`, with no pending key rotation and no pending/unsafe disconnect receipt.
- `ocx sync --expect-hub-key <apiKeyId>`: same for a hub-mode client (transport absent or `hub`)
  whose `apiKeyId` equals the value.
- Match: exactly today's connected sync (catalog, Home Codex settings, apply record, runtime restart).
- Mismatch: nothing written, no local proxy discovery, no `syncModelsToCodex`; exit **5** (the
  documented "state is not what you expected; inspect first" code); stderr carries one human line
  and a final JSON line `{"phase":"child_link_mismatch"|"hub_client_mismatch","reason":R}` with
  R in `disconnected | invalid_state | disconnect_pending | pending_operation | hub_client |
  link_client | other_link | other_key`. Identifiers are not echoed.
- Usage: missing value, malformed link id (`^lnk_[0-9a-f]{16}$`), empty/oversized key id
  (> 256 chars), a repeated flag, or both flags -> exit 2 before any state read.
- Without either flag, behavior is unchanged.

## Diff-level plan

1. `src/client/sync-expectation.ts` (new): `ClientSyncExpectation`, `ClientSyncMismatchReason`,
   `ClientSyncExpectationError` (`phase`, `reason`), pure `classifyClientSyncExpectation(state,
   receipt, expectation)`, and `assertClientSyncExpectation(expectation)` which reads the disconnect
   receipt and connection state. Read-only; called with L/C held.
2. `src/client/connect.ts`: `syncConnectedClient(options.expect?)`; inside the first
   `withClientLifecycleSync(withConfigMutationLockSync(...))` block (already inside `withLinkApply`)
   call `assertClientSyncExpectation` before the existing `assertNoClientDisconnectPending`. Later
   writes are already CAS-bound to that connection by `assertClientConnectionUnchanged`. Return the
   connection the sync ran under (`connection`) so the CLI stops relying on its unlocked read.
3. `src/cli/sync-expectation.ts` (new): `parseSyncExpectation(args)` and
   `reportSyncExpectationMismatch(error, log)` (returns 5 or null).
4. `src/cli/dispatch.ts` `sync`: parse first (exit 2 on usage); with an expectation, skip the
   unlocked branch decision and always call `syncConnectedClient({ restartCodex, expect })`; map
   `ClientSyncExpectationError` to exit 5; derive `link` and the restart owner from
   `result.connection`.
5. CLI surface: `src/cli/registry.ts` usage/details, `src/cli/help.ts` line, sync capability flags
   in `src/cli/capabilities-base.ts`; `bun run skill:surface`; prose in
   `skills/ocx/references/04_failure_semantics.md` and `05_remote_hub.md`.
6. Docs: `docs-site/src/content/docs/reference/cli/lifecycle.md` (English) and
   `structure/cli-management.md` (manager scope: `structure/runtime.md` is at its 600-line cap
   and stays untouched).
7. Test `tests/cli/cli-sync-expect-link.test.ts` (registered in the `layout-clients.json` shard
   and `tests/fixtures/test-layout-expected.json`): in-process, `OPENCODEX_HOME` temp dir, config
   fixtures written directly, the client lifecycle lock moved into the test directory; spies on
   `syncModelsToCodex` and `findLiveProxy` prove no fallback; a match uses a Child selecting only
   `claude` (the schema requires one client) and a stubbed Home catalog fetch, so the real
   connected path runs end to end.
8. `src/client/machine-api.ts`: `/api/machine/sync` spreads the sync result into its response,
   so it drops the new `connection` field (token fingerprint, prior catalog) before replying.

## Audit round 1 (codex/gpt-6.1-sol, NEAR-PASS) — decisions

1. Record deletions after the Home settings await are not re-checked against a concurrent
   disconnect. **Rebutted for this unit**: pre-existing in every connected sync, unchanged by the
   expectation, and the record is one disconnect removes anyway. Left as a residual.
2. Pending connect marker not inspected. **Accepted**: on a disconnected machine a valid
   `client-connect-pending` marker is `pending_operation`, an unreadable one `invalid_state`. A
   connect only starts from a disconnected machine, so a marker beside a connection is ignored.
3. Test coverage. **Accepted in part**: added both expectation kinds end to end, invalid config,
   pending connect (valid and malformed), pending/unsafe receipts in the classifier, a relink
   during the catalog read, isolated lock path, restored `process.exitCode`. Selected-Codex
   injection is unchanged code after the gate and stays covered by its existing suites.
4–6. Notes adopted: lock files are coordination artifacts, not state; the JSON `phase` is the
   discriminator, exit 5 the code; `result.connection` is `next`.

Test hazard found while recording the red run: on an unfixed tree an argv containing
`--restart-codex` is a real restart request, which ended the Codex app hosting the agent. The
test carries no restart flag and stubs the restart helper.

## PR review round 1 (codex/gpt-6.1-sol, FAIL) — decisions

1. Blocker, **accepted**: `runCli` ran `maybeAutoRestoreCodexShim` before dispatch, so a pinned
   sync could repair the shim on a mismatched machine, and a malformed one read shim state before
   exiting 2. Fix: `src/cli/root.ts` validates the flags before any preflight (exit 2);
   `skipsCodexShimAutoRestore` exempts a pinned sync (the `stop --expect-*` precedent); the sync
   runner calls `runCodexShimAutoRestore` once the locked check passed, so a match still repairs
   like an unpinned sync. Root-level tests added; without the fix 4 of 25 cases fail.
2. Non-blocking, **accepted**: trailing blank lines at EOF removed (`git diff --check` clean).

## Manager review at 7bfbd75a41 (MUST-FIX) — decisions

1. P2, **accepted**: a link connect holds the apply lock across its network reads, so a pinned
   sync failed acquiring it before its check and exited 1 without a phase. `withLinkApply` now
   throws `LinkApplyBusyError` (`code: "link_apply_busy"`, same message); `syncConnectedClient`
   maps that or `client_lifecycle_busy` raised before its check passed to
   `ClientSyncExpectationError(..., "pending_operation")`. Tests hold a real link connect at its
   readiness fetch (deferred promise) and a real lifecycle lock; without the fix both fail.
2. P3, **accepted**: PR body regains a standalone `## Verification` heading and `Closes #7694`.

## PR review round 4 (codex/gpt-6.1-sol at 21166e1be, FAIL) — decisions

1. Blocker, **accepted**: the check also needs the config mutation lock; a concurrent config writer
   made acquisition throw `CONFIG_MUTATION_LOCK_UNAVAILABLE` (cause `SQLITE_BUSY`), which the
   mapper ignored (exit 1, no phase). `isClientSyncLockBusy` now accepts that code when its cause
   is busy/locked, with the classification `src/config/mutation-lock.ts` already uses; other
   acquisition or storage failures stay themselves. Test: a real SQLite `BEGIN IMMEDIATE` holder
   for both expectation kinds, an unpinned control (exit 1), and a holder taken after the check
   (exit 1, "Config mutation already in progress"). Without the fix the case fails.

## Verification

Red run of the new test on the unfixed tree, then: focused test files, `bun run typecheck`,
`bun run test:changed`, `bun run privacy:scan`, `bun run structure:check`,
`bun run skill:surface:check`, docs-site build. Full `bun run test` is optional (shared host).

## Risks

- Older `ocx` ignores unknown sync flags, so a caller must version-gate the flag (GOAT keeps its
  status check for older versions, per the issue).
- A connection that changes after the locked check but before a write still fails as today
  (`client_connection_changed`, exit 1), not as a mismatch: the expectation held when checked.
