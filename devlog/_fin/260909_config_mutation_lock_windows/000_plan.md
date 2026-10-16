# config-mutation-lock Windows fixture: readiness budget + failure unmasking

## Reader summary

Windows shard 2/6 of run
[34321628628](https://github.com/lidge-jun/opencodex/actions/runs/34321628628)
(attempt 1, job 102369384143, head `ddcf8b5f9b13`, branch
`codex/pr3997-caller-main-cooldown`, a `workflow_dispatch` lane run) failed
`tests/config/config-mutation-lock.test.ts` at line 111 with `Expected: 0 /
Received: 143` after 5915.82 ms. The 143 is not a lock defect and not the
30 s teardown kill: it is the readiness-timeout path's own `child.kill()`,
and the `finally` block's exit-0 expectation then masks the real error. The
fix gives spawned-child readiness a measured 30 s budget, stops the masking,
and corrects a stale comment. No product code, no workflow changes.

## Loop spec

- **Loop archetype:** satisfy-spec repair of a CI test fixture.
- **Trigger:** delegated follow-up from the managing task after the xAI OAuth
  unit completed; user-authorized as a small isolated maintainer PR.
- **Goal:** the Windows flake either passes (child ready within a measured
  budget) or fails with the real readiness error instead of a bare 143.
- **Non-goals:** product code, CI workflow files, other tests, skipped tests,
  accepting 143 as a valid outcome, bare timeout bumps without observability.
  No local suite/typecheck/build (user restriction).
- **Verifier:** remote `ci.yml` — PR lane (Linux `test`, macOS
  `platform-macos`, `gates`) on the PR, then a `workflow_dispatch`
  `lane=all` run on the exact PR head whose Windows shards execute this file;
  the previously failing test must pass there.
- **Stop condition:** PR published, PR lane green, Windows dispatch run green
  for this file at the exact head, managing task handed the report.
- **Memory artifact:** this unit directory; goalplan
  `.codexclaw/goalplans/` entry for this session's second goal.
- **Expected terminal outcomes:** DONE = both CI evidences green at the exact
  head. BLOCKED = the Windows run shows the failure is NOT the readiness budget
  (e.g. child never acquires the lock even in 30 s → real lock defect, which
  would be out of this task's scope and handed back with evidence).
- **Escalation condition:** any need to touch `src/` or `.github/`, or a
  Windows re-failure after the fix.

## Verified cause (log + source, no patch before this was established)

Timeline of the failing attempt (test duration 5915.82 ms):

1. Parent spawns the Bun child and enters `waitForPath(readyPath)` —
   **500 attempts × 10 ms = 5 s** budget (tests/config/config-mutation-lock.test.ts:27-34).
2. The child must boot Bun, transpile the `src/config.ts` import chain, and
   acquire the mutation lock before writing `holder-ready`. On this loaded
   runner that exceeds 5 s: the sibling child in `an abruptly exited holder
   releases the OS-backed transaction…` needed **8290.11 ms** end-to-end in the
   same shard (and passed, because `waitForOwnedChild` allows 30 s). The lock
   itself is healthy — every other test in the file passed, and attempt 2 of the
   run was green.
3. `waitForPath` throws at ~5 s; the catch kills the child — SIGTERM, exit
   **143** — and rethrows an enriched error with the child's stderr
   (tests/config/config-mutation-lock.test.ts:85-92).
4. The `finally` block (line 109-112) runs `writeFileSync(releasePath)` and
   `expect(await waitForOwnedChild(child)).toBe(0)`. The child is already dead
   with 143, so this expectation throws and **replaces** the enriched readiness
   error — the log shows only the 143 mismatch at line 111, and the "child
   stderr" text never appears.
5. The stale comment in `waitForOwnedChild` (lines 36-41) attributes a 5858 ms
   / 143 failure to "this helper's own `kill()`" from the 5 s era — that helper
   now waits 30 s, so the explanation is wrong; the 143 comes from the
   readiness-timeout catch.

## File change map

| Path | Action | What |
|------|--------|------|
| `tests/config/config-mutation-lock.test.ts` | MODIFY | readiness wait reuses the predeclared platform policy `watchdogMs(5_000)` (5 s local / 30 s CI / 45 s Windows CI) with an elapsed deadline, a final recheck, and fail-fast on an already-exited child; unmask the primary readiness failure in both holder tests' `finally`; correct the stale `waitForOwnedChild` comment |

OUT: `src/**`, `.github/**`, `tests/helpers/ci-watchdog.ts` (imported, not
modified), every other test file.

Forensics correction (independent verifier Descartes, forwarded by the managing
task after the first plan draft): the readiness budget must reuse the EXISTING
`watchdogMs(5_000)` platform policy from `tests/helpers/ci-watchdog.ts`
(Windows CI floor 45 s) rather than a new hardcoded 30 s constant — that helper
is the repository's declared answer to "spawned children are slow on loaded
Windows CI", so this fix expresses policy, not a local bump. It also directed
the fail-fast on `child.exited` (no 45 s poll on an already-dead child) and
extending the unmasking to the management-API holder test.

## Diff-level design

### 1. `waitForPath` → `waitForOwnedChildReady` — platform-policy budget, fail-fast

Before (lines 27-34): a fixed 500 × 10 ms (5 s) poll with no knowledge of the
child.

After: the wait takes the spawned child, budgets `watchdogMs(5_000)` (5 s
locally, 30 s on CI, 45 s on Windows CI — the predeclared policy in
`tests/helpers/ci-watchdog.ts`), polls on an elapsed-time deadline with a final
`existsSync` recheck, and races each 10 ms tick against `child.exited` so a
child that died before writing the marker fails immediately with its exit code
and stderr instead of burning the whole budget.

### 2. Unmask the primary failure in both holder tests

Before (lines 84-112):

```ts
  try {
    try {
      await waitForPath(readyPath);
    } catch (error) {
      child.kill();
      await child.exited;
      const stderr = await new Response(child.stderr).text().catch(() => "");
      throw new Error(`${(error as Error).message}\nchild stderr: ${stderr}`);
    }
    ...
  } finally {
    writeFileSync(releasePath, "release");
    expect(await waitForOwnedChild(child)).toBe(0);
  }
```

After:

```ts
  let childKilled = false;
  try {
    try {
      await waitForOwnedChildReady(child, readyPath);
    } catch (error) {
      childKilled = true;
      child.kill();
      await child.exited;
      const stderr = await new Response(child.stderr).text().catch(() => "");
      throw new Error(`${(error as Error).message}\nchild stderr: ${stderr}`);
    }
    ...
  } finally {
    writeFileSync(releasePath, "release");
    // The readiness-timeout path already killed the child; expecting exit 0 here
    // would mask that primary error with a bare 143.
    if (!childKilled) {
      expect(await waitForOwnedChild(child)).toBe(0);
    }
  }
```

The happy path is unchanged: release marker is always written (bounded cleanup),
the exit-0 core assertion still runs whenever the child was not sacrificed, and
every lock assertion (not stolen, immediate writer failure, no stale writes) is
untouched.

### 3. `waitForOwnedChild` comment correction

Replace the stale 5 s-era explanation with the verified provenance:

```ts
  // The child polls for the release marker on a 10 ms sleep, so its exit is bounded by
  // the filesystem noticing that write plus one Bun teardown; a loaded Windows runner
  // needs real room for both. A surfaced exit 143 is never this helper's own kill()
  // (which fires only after the full budget) — it is the readiness-timeout path's
  // child.kill(), so read the readiness error, not this wait.
```

## Regression evidence plan

- The failure mode is exercised by construction: if readiness ever exceeds the
  budget again, the thrown error is the enriched `waitForOwnedChildReady`
  message (with child stderr), asserted by reading the code path. A child that
  *dies* before writing the marker is caught immediately by the `child.exited`
  race rather than at the deadline; only a child that stays alive and never
  becomes ready costs the full platform budget, and a dedicated test for that
  would be a deliberate 45 s negative test on Windows CI — a cost not justified
  for a CI fixture, where the unmasking is straight-line control flow reviewed
  in the diff.
- Positive path: `ci.yml` PR lane plus a `workflow_dispatch` `lane=all` run
  on the exact PR head; the Windows shard executing
  `tests\config\config-mutation-lock.test.ts` must pass, and the run must
  show this file's tests green.
