# 010 — wp1: Windows removal ownership (G1-G3)

PR title: `fix(test): drain ACL work and close history before Windows fixture removal`
Branch `codex/l7-windows-removal-ownership`, worktree `.tmp/lanes/L7-ci-infra-1`.
Credit: `Co-authored-by` mashfromband (commit identity from the source PR) (#6723),
`Co-authored-by` 김상훈 (commit identity from the source PR) (#6783).

Source heads: #6723 `9149843fc6df5170b0fbb8f14b4871b30cf1040d`, #6783
`4b9952e72b8b3912f715c90bb835268b4b11e014` (fetch with `git fetch origin pull/N/head`).

## File change map

| Path | Kind | Source |
| --- | --- | --- |
| src/lib/windows-secret-acl.ts | MODIFY | #6723, whole-file diff (shown in 000 research r1): `activeAsyncAclWork` registry; register each runner before yielding; registry-parameterized `registerPendingAsyncIcaclsReap`; `canonicalRemovalPath` + alias-aware `pathIsAtOrBelow` that conservatively answers true for unreadable identity; removal guard and barrier read both registries; `hardenEntryAsync` split into a registering wrapper and `runHardenEntryAsync` |
| src/storage/policy-job.ts, policy-worker.ts, policy.ts | MODIFY | #6723: `workerLoadGate` / `holdAfterLoadGate` test barrier |
| tests/storage/api-storage-policy-put-race.test.ts | MODIFY | #6723: shared-memory loaded-policy barrier |
| tests/helpers/management-auth-fixture.ts | NEW | #6783's extraction of `remoteConfig`, `hubConfig`, `startEphemeralHubServer`, `websocketHandshakeOpens`, with #6723's close-awaiting `websocketHandshakeOpens` body (D3) |
| tests/server/server-management-auth.test.ts | MODIFY | #6783: import the fixture, delete the four inline functions, `closeRequestHistoryIndex()` between `flushConfigDirHardeningForTests()` and `flushWindowsSecretAclReapsBeforeRemoval(testHome)`. Target ~1931 lines (< 2000) |
| tests/oauth/oauth-login-cli-live-update.test.ts | MODIFY | NEW code below (G3) |
| tests/helpers/isolated-codex-home.ts | MODIFY | add `restoreEnvironment()` (env only) and `removeAfterDrain()` (rethrowing removal); keep `restore()` = both with the existing swallow, so other callers are unchanged |
| tests/claude-integration/claude-cli-picker.test.ts, claude-desktop-first-party.test.ts, claude-intercept-on-demand.test.ts, claude-messages-endpoint.test.ts, claude-picker-recovery.test.ts | MODIFY | #6723 drain-then-retry hunks (D4) |
| tests/claude-integration/claude-cli.test.ts, claude-picker-ca-store.test.ts; tests/server/link-management-routes.test.ts, local-account-switch-ingress.test.ts, plaintext-v2-agent-messages-server.test.ts, restart-replacement.test.ts, startup-health-packaged-probe.test.ts, system-restart.test.ts | MODIFY | #6783 retry-aware cleanup hunks (raw `rmSync` → `removeTreeWithRetry`) |
| tests/windows/windows-secret-acl-removal-flight.test.ts | NEW | regression tests below |
| scripts/test-layout/layout.json, tests/fixtures/test-layout-expected.json | MODIFY | register `windows-secret-acl-removal-flight.test.ts` → `windows`; `management-auth-fixture.ts` lives in `tests/helpers/` (helpers are outside the layout map; verify with `tests/test-layout.test.ts`) |
| structure/runtime.md | MODIFY | only #6723's Support-table hunk (`src/storage/` policy fixtures synchronize after loading the initial policy; 10 s barrier). The line-3 catalog/persistence sentence belongs to wp4 |
| structure/ops/service-and-sidecars.md | MODIFY | #6723's "Windows config-directory handle release" hunk, with both `async_contracts.rs` sentences rewritten to cite `tests/windows/windows-secret-acl-removal-flight.test.ts` |
| tests/helpers/fixture-teardown.ts | NEW | `drainAndRemoveFixtureRoots(plan, deps)`: runs producers → per-root config flights → history close → per-root ACL drain → removal of each drained root, restores environment in `finally`, rethrows the first failure. `deps` defaults to the real flushers and `removeTreeWithRetry`, and is injectable for tests |
| tests/ci-workflows/fixture-teardown-helper.test.ts | NEW | deterministic order/failure tests below; register → `ci-workflows` in both layout tables (where the layout seed resolves it) |
| structure/ops/test-sandbox-cleanup.md | MODIFY | fixture removal order: producers → config flights → history close → ACL drain → removal; delete a root only after its drains succeed |

Hunks out of scope here: #6723's kiro/compaction test hunks and cold-spawn warm-up changes
(wp4), Rust crate and workflow (wp5); #6783's cache, warm-up and serial-gate hunks (wp2).

## Build recipe

```sh
git fetch origin pull/6723/head:refs/l7/pr6723 pull/6783/head:refs/l7/pr6783
git worktree add -b codex/l7-windows-removal-ownership .tmp/lanes/L7-ci-infra-1 origin/dev
cd .tmp/lanes/L7-ci-infra-1
B=$(git merge-base origin/dev refs/l7/pr6723)
git diff $B refs/l7/pr6723 -- src/lib/windows-secret-acl.ts src/storage/policy-job.ts \
  src/storage/policy-worker.ts src/storage/policy.ts tests/storage/api-storage-policy-put-race.test.ts \
  tests/claude-integration/claude-cli-picker.test.ts tests/claude-integration/claude-desktop-first-party.test.ts \
  tests/claude-integration/claude-intercept-on-demand.test.ts tests/claude-integration/claude-messages-endpoint.test.ts \
  tests/claude-integration/claude-picker-recovery.test.ts \
  structure/ops/service-and-sidecars.md | git apply --3way
# then: replace the two async_contracts.rs sentences in service-and-sidecars.md with the Bun test path,
# and hand-apply only the Support-table hunk of structure/runtime.md
B2=$(git merge-base origin/dev refs/l7/pr6783)
git diff $B2 refs/l7/pr6783 -- tests/helpers/management-auth-fixture.ts tests/server/server-management-auth.test.ts \
  tests/claude-integration/claude-cli.test.ts tests/claude-integration/claude-picker-ca-store.test.ts \
  tests/server/link-management-routes.test.ts tests/server/local-account-switch-ingress.test.ts \
  tests/server/plaintext-v2-agent-messages-server.test.ts tests/server/restart-replacement.test.ts \
  tests/server/startup-health-packaged-probe.test.ts tests/server/system-restart.test.ts | git apply --3way
```

Then replace `websocketHandshakeOpens` in the new helper with #6723's body:

```ts
export function websocketHandshakeOpens(url: URL, token: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const target = new URL("/v1/responses", url);
    target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(target, {
      headers: { "X-OpenCodex-API-Key": token },
    } as unknown as string[]);
    let settled = false, opened = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(opened);
    };
    const close = () => {
      try { socket.close(); } catch { /* already closed */ }
      if (socket.readyState === WebSocket.CLOSED) finish();
    };
    socket.addEventListener("open", () => { opened = true; close(); });
    socket.addEventListener("error", close);
    socket.addEventListener("close", finish);
    const timer = setTimeout(() => {
      close();
      if (!settled) { settled = true; reject(new Error("fixture WebSocket did not close within 5000ms")); }
    }, 5_000);
  });
}
```

## G3: OAuth fixture teardown (new code)

Helper change (`tests/helpers/isolated-codex-home.ts`):

```ts
export interface IsolatedCodexHome {
  path: string;
  /** Restore CODEX_HOME only. */
  restoreEnvironment(): void;
  /** Remove the tree after the caller drained its producers; removal failures are rethrown. */
  removeAfterDrain(): void;
  /** Restore and remove, swallowing removal failures (existing behavior). */
  restore(): void;
}
```

`restoreEnvironment` is idempotent; `restore()` calls `restoreEnvironment()` then the existing
swallowed removal.

Fixture changes. Both affected hooks call one shared helper. The management-auth `afterEach`
keeps its test-seam resets but moves environment and seam restoration into the helper's
`restoreEnvironment` callback, so a drain failure cannot leak `OPENCODEX_HOME`, `CODEX_HOME`
or token variables into later files.

Helper contract (`tests/helpers/fixture-teardown.ts`):

```ts
export interface FixtureRoot { path: string; remove?: (path: string) => void }
export interface FixtureTeardownPlan { roots: FixtureRoot[]; restoreEnvironment: () => void }
export interface FixtureTeardownDeps {
  settleProducers(): Promise<void>;                    // flushNativeMainStartupReleases
  settleConfigFlights(root: string): Promise<void>;    // flushConfigDirHardening (flight only, no reaps)
  closeHistory(): void;                                // closeRequestHistoryIndex
  drainAcl(root: string): Promise<void>;               // flushWindowsSecretAclReapsBeforeRemoval
  remove(path: string): void;                          // removeTreeWithRetry
}
export async function drainAndRemoveFixtureRoots(plan: FixtureTeardownPlan, deps?: Partial<FixtureTeardownDeps>): Promise<void>;
```

Order and gating:

1. `settleProducers()`. If it fails, no root is removed.
2. `settleConfigFlights(root)` for every root. A failure blocks removal of that root only.
3. `closeHistory()`. If it fails, no root is removed (the index may live under any root).
4. `drainAcl(root)` for every root. A failure blocks removal of that root only.
5. Each root whose own steps 2 and 4 succeeded, with 1 and 3 succeeded, is removed through
   its `remove` (default `removeTreeWithRetry`); a removal failure does not stop later roots.
6. `restoreEnvironment()` in `finally`; the first recorded failure is rethrown.

OAuth hook (`tests/oauth/oauth-login-cli-live-update.test.ts`, replacing :55-60):

```ts
afterEach(async () => {
  const dir = testDir, codexHome = isolatedCodexHome;
  testDir = ""; isolatedCodexHome = null;
  await drainAndRemoveFixtureRoots({
    roots: [
      ...(dir ? [{ path: dir }] : []),
      ...(codexHome ? [{ path: codexHome.path, remove: () => codexHome.removeAfterDrain() }] : []),
    ],
    restoreEnvironment: () => {
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      codexHome?.restoreEnvironment();
    },
  });
});
```

Management-auth hook: `roots: [{ path: testHome }]`; its existing env restores and
`set*ForTests(null)` resets move into `restoreEnvironment`; `resetContextRelayActivationForTests()`
stays before the helper call.

Verified at P of wp0: `IsolatedCodexHome.path`, `flushNativeMainStartupReleases`
(`src/codex/native-profile-startup`), `flushConfigDirHardening` and
`flushConfigDirHardeningAndReaps` (`src/config/paths.ts:61,67`; the latter already awaits ACL
reaps, so the helper uses the former), `closeRequestHistoryIndex`
(`src/routing/history/indexer.ts:481`). An undrained root is left for the run-level sandbox
cleanup in `tests/preload.ts`, which drains before deleting.

## Regression tests (new file)

`tests/windows/windows-secret-acl-removal-flight.test.ts` drives the async hardening path
with `setPlatformForTests("win32")` and a controllable `setAsyncIcaclsRunnerForTests` runner:

Fixtures create real directories under a `mkdtemp` root; the fake runner signals entry
(a resolved "entered" promise) before the test asserts, so no assertion races the spawn.

1. Normal flight: the runner is held open; `windowsSecretAclReapPendingAtOrBelow(root)` is
   true and `flushWindowsSecretAclReapsBeforeRemoval(root)` stays pending until the runner
   resolves. Expected red on unmodified `windows-secret-acl.ts` (guard false before the belt);
   B records the actual red output.
2. Command gap: in a multi-command harden, after the first command resolves and before the
   next starts, the root is still held.
3. Deadline survivor: a runner that outlives the belt still blocks removal until it settles
   (existing behavior preserved).
4. Containment: work under `root/a` blocks removal of `root`, not of a sibling `root2`.
5. Aliases, both directions: registration through a symlinked/real path blocks removal
   requested through the other spelling (skip only where symlink creation is unavailable).
6. Deleted target ancestry: work registered for `root/gone/file` whose directories were
   removed is still matched against `root` through the missing-suffix walk.
7. Unreadable identity is treated as inside.
8. Required-failure preservation: a hardening failure still surfaces to the caller with its
   ETIMEDOUT/EICACLS code; registration changes no result.
9. Settlement: after resolve or reject, both registries are empty.

`tests/ci-workflows/fixture-teardown-helper.test.ts` (deterministic, all platforms) with fake deps:

1. Held flight: `drainAcl` for root A is a held promise; `remove` is not called for A until it
   resolves; after resolve, A is removed.
2. Order: the recorded call log is exactly producers → flights(A,B) → closeHistory → drain(A,B)
   → remove(A,B).
3. History owner first: `remove` is never called before `closeHistory`.
4. Cleanup failure: `settleConfigFlights(A)` rejects → A is not removed, B still is,
   `restoreEnvironment` ran once, the rejection is rethrown.
5. Removal failure: `remove(A)` throws → B is still attempted, environment restored, error
   rethrown.
6. `restoreEnvironment` runs even when `settleProducers` rejects, and no root is removed.
7. `closeHistory` throws: no root is removed, every `drainAcl` still ran, environment restored,
   error rethrown.
8. Default deps: `settleConfigFlights` is `flushConfigDirHardening` (asserted by identity), so the
   ACL drain happens only after history close.

Activation: tests 1-6 fail against a naive implementation that removes before draining
(B writes that control once and records the red output). Native handle release itself is
still only observable on Windows CI shards, which remain the additional evidence for (a)/(c).

## Acceptance

- Focused (local, macOS): the new test file, `tests/windows/windows-secret-acl.test.ts`,
  `tests/server/server-stop-config-hardening.test.ts`, `tests/server/server-management-auth.test.ts`,
  `tests/oauth/oauth-login-cli-live-update.test.ts`, `tests/storage/api-storage-policy-put-race.test.ts`,
  `tests/test-layout.test.ts`; typecheck, privacy, structure.
- Activation: test 1 fails against unmodified `windows-secret-acl.ts` (record red output in the PR).
- Hosted: exact-head CI, all nine Windows shards green.
- Security: the ACL change is production code on the secret-hardening path. The A reviewer
  checks that registration never weakens the caller-facing deadline, required-secret
  failure policy or memo semantics.
