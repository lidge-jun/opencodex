# 003 — #3011 / PR #3018 audit: correct fix, one shutdown blocker

PR #3018, branch `ingw/fix-3011-async-acl-spill`, exact head `aec717722`,
rebased onto `870a2adb6` by this train. Repository CI green, 0 failures.

## Verdict: the fix is right, and it is not yet mergeable

CI-green is not correctness evidence here, because the gap is in a path no test
exercises.

### What the PR gets right

It genuinely removes the ACL subprocess wait from the response event loop. On
`dev`, `writeResponseSpillDurably` calls synchronous `harden()`
(`src/responses/spill-store.ts:180`, `:324`) which runs `Bun.spawnSync()`
(`src/lib/windows-secret-acl.ts:307`). `/healthz` shares that Bun fetch handler
(`src/server/index.ts:884`), so it cannot run during the wait — that is the 47s
stall.

The PR queues Windows publications on a serialized promise tail
(`aec717722:src/responses/state.ts:280-308`) and awaits
`hardenSecretDirAsync`/`hardenSecretPathAsync`, which use `Bun.spawn()` plus
`await proc.exited` (`src/lib/windows-secret-acl.ts:329`).

Linux and macOS are genuinely untouched: all three async routing points are gated
on `windowsSecretAclApplies()`, and false continues to the existing synchronous
`writeResponseSpillDurably` (`aec717722:src/responses/state.ts:547`, `:575`,
`:1250`).

No Lab import is introduced, and no Node-only API — `Bun.spawn` is Bun-native.

### Blocker — graceful shutdown does not drain pending publications

`responseSpillPublicationTail` is awaited in exactly one place, and it is marked
test-only:

```
state.ts:187  let responseSpillPublicationTail: Promise<void> = Promise.resolve();
state.ts:306  responseSpillPublicationTail = responseSpillPublicationTail.then(...)
state.ts:328  await responseSpillPublicationTail;   <- flushPendingResponseSpillsForTests
```

`flushResponseState()` — the function shutdown actually calls
(`src/server/lifecycle.ts:492`) — awaits only `persistGate` and the snapshot
write. It never observes the publication tail. Verified by reading the function
body at the PR head.

The loss is concrete because oversized residents are deliberately excluded from
the snapshot (`aec717722:src/responses/state.ts:1015`):

```ts
if (state.kind === "resident" && size > SNAPSHOT_ENTRY_MAX_BYTES) continue;
```

with `SNAPSHOT_ENTRY_MAX_BYTES = 2 * 1024 * 1024` (`:35`).

So: a request queues a Windows spill for a payload over 2 MiB and returns while
`icacls` is still in flight. Shutdown flushes the snapshot, which *skips* that
resident because it is oversized, and the spill stub that would have replaced it
is not installed yet. The stop paths then call `process.exit()`
(`src/server/lifecycle.ts:489`, `src/server/management-api.ts:278`,
`src/cli/index.ts:365`), which also bypasses the writer's temp cleanup
(`aec717722:src/responses/spill-store.ts:467-505`). The continuation is lost and a
temp file can be orphaned.

Before the PR this race did not exist: publication was synchronous, so by the time
the request returned the stub was already installed.

### Required remediation

Drain the publication tail to a **stable fixed point** before writing the shutdown
snapshot: repeatedly capture and await the tail until the captured promise still
equals the current one. A single `await` is insufficient because a settling job can
append another (`:306`).

Surface: `src/responses/state.ts` (production drain + call it from
`flushResponseState` before snapshot serialization), `tests/responses-state.test.ts`,
and a note in `structure/02_config-and-codex-home.md`, whose current text describes
queueing but not shutdown ordering. `src/server/lifecycle.ts` needs no change — it
already calls `flushResponseState()` at the right boundary.

## Coverage gaps in the PR's own tests

The three added tests are real regressions — two wait on an injected async runner
the old synchronous path never enters (`aec717722:tests/responses-state.test.ts:720-818`).
They cover yielding, timeout recovery, and same-id supersession. They do not cover:
ordinary (non-timeout) ACL failure, cross-id serialization, shutdown, or
copy-fallback cleanup.

## Security check

Required-mode ACL failure appears to fail closed: the required helpers throw
(`src/lib/windows-secret-acl.ts:872`) and the state catch replaces the entry with a
failure marker (`aec717722:src/responses/state.ts:261`). Not covered by a test,
which is why the plan adds one.

Residual, unresolved without a real Windows host: if ACL hardening fails *and*
unlink also fails, cleanup is best-effort
(`aec717722:src/responses/spill-store.ts:310`, `:498`) and a full payload can remain
on disk. Whether another local user can read it depends on the resulting NTFS ACL.
Recorded as a follow-up, not a blocker for this unit — it predates the PR.

## Disposition

wp3 is not "merge #3018". It is: land the drain fix on top of the PR head, prove it
with the shutdown regression, then merge. The author's work is correct as far as it
goes; the missing piece is the boundary his change created.
