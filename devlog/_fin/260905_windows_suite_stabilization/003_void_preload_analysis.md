# 003 — VOID: the preload run-id analysis (1.3.14 only)

> **This phase does not ship.** The defect it describes does not exist on
> `bun 1.4.0`: the same files are 50/50 green there (`001`, `002`). Renumbered
> into the research range because it is now a record of a mechanism, not a plan.
>
> **The latent hazard it found is still real and still unfixed**, and that is why
> the document stays: `tests/preload.ts:41` republishes its own bare run id into
> `OCX_TEST_RUN_ID`, which makes a bare run indistinguishable from a wrapper
> handoff. On 1.3.14 that ambiguity was load-bearing. On 1.4.0 nothing currently
> reaches it. If a future runtime re-evaluates preload the same way, this is
> where to start — and `tests/preload.ts:41` is the line to delete, not the
> `OCX_TEST_RUN_KIND` marker the original draft proposed (the audit showed that
> marker is unsound: `??= "bare"` preserves an ambient `wrapped`, and
> `OCX_TEST_NO_QUEUE=1` already separates a marker from its capability).

> **Status: HELD, pending the `002` baseline.** The source mechanism below was
> verified line by line by the plan audit — with one citation corrected: the
> non-win32 early return is `scripts/test-run-lock.ts:164`, not `:162`
> (`:162` is the no-run-id return). What is NOT established is that it fires on
> `bun 1.4.0`, the runtime this project actually pins. On 1.4.0 the same files
> pass 50/50. See `001_runtime_fault.md`.
>
> If `002` shows the guard armed on 1.4.0, this phase does not ship a fix for a
> defect nobody has. What survives either way is the latent hazard: a preload
> that republishes its own bare id is indistinguishable from a wrapper handoff,
> and `tests/preload.ts:41` is the line that makes them indistinguishable.
>
> **Audit findings to fold in before this phase can be attested, whatever `002`
> says:**
>
> 1. The proposed `OCX_TEST_RUN_KIND` is unsound as written.
>    `process.env[TEST_RUN_KIND_ENV] ??= "bare"` preserves an ambient
>    `wrapped`, so an environment that already carries `wrapped` with no id
>    reproduces the original fault. A fix must be a total, fail-closed state
>    machine over: undefined, invalid, bare, wrapped, wrapped-without-id,
>    partial capability, `OCX_TEST_NO_QUEUE=1`, non-Windows, and mutation
>    between isolate files.
> 2. The claim that the marker and its capability "can never separate" is
>    **false**: `OCX_TEST_NO_QUEUE=1` produces a wrapper run with a kind and an
>    id but deliberately no path/token.
> 3. A simpler candidate was not evaluated and must be: **delete the write-back
>    at `tests/preload.ts:41`.** Bare identity is already stable per process or
>    parallel controller (`scripts/test-run-lock.ts:365-371`), and a repository
>    search found no consumer that needs a bare preload to publish
>    `OCX_TEST_RUN_ID`. If nested bare invocations do need it, that requires a
>    reproducer, not an assumption.
> 4. The proposed regression test says "with win32 semantics" without saying how
>    `process.platform` becomes Windows in a cross-platform test. Either inject
>    the platform through the existing seam or run the regression only on the
>    Windows box and say so.

One defect. It accounts for **161 of the 174 failures** seen so far
(44 in shard 1, 117 in shard 2) and it is Windows-only by construction.

## What fails

Three unrelated test files die in `beforeEach`/`afterEach`, each on a different
guarded seam, each with the same underlying condition
`process.env.OCX_TEST_HOME_GUARD !== "1"`:

| file | seam | src | count |
|---|---|---|---|
| `tests/codex-reset-credit-operation-ledger.test.ts:296` | `setResetCreditOperationMigrationFaultForTests` | `src/codex/reset-credit-operation-ledger.ts:488` | 44 |
| `tests/codex-reset-credit-recovery.test.ts:90,94` | `resetCodexResetCreditRecoveryProcessStateForTests` | `src/codex/reset-credit-recovery.ts:638` | 68 |
| `tests/lab-fabric-task.test.ts:304` | `setFabricProducerIsolationLimitsForTests` | `src/lab/fabric/producer-isolate.ts:287` | 49 |

Plus the one that names the defect outright:
`tests/test-home-guard.test.ts:274` — *"the preload sandboxes this very process"* —
asserts `isTestHomeGuardArmed()` is true and receives false. That test exists
precisely to catch this state, and on Windows it is red.

## Mechanism

`bunfig.toml` preloads `tests/preload.ts`, and `--isolate` re-evaluates it per
test file. The preload's own bookkeeping is what breaks the next evaluation:

```
preload.ts:30  const wrappedRunId = process.env[TEST_RUN_ID_ENV]?.trim();
preload.ts:36  const inheritedLock = resolveInheritedTestRunLock({ wrappedRunId, env: process.env });
preload.ts:41  process.env[TEST_RUN_ID_ENV] = runId;      // <- writes back a BARE id
```

File 1 has no `OCX_TEST_RUN_ID`, so `wrappedRunId` is undefined, the bare
identity is used, and line 41 publishes `bare-<pid>` into the environment.
File 2's preload reads that value as `wrappedRunId` — it cannot tell who wrote
it. On Windows `resolveInheritedTestRunLock` then demands the rest of the
wrapper capability:

```
test-run-lock.ts:162  if (platform !== "win32") return undefined;   // macOS exits here
test-run-lock.ts:166  const candidate  = env[TEST_RUN_LOCK_PATH_ENV]
test-run-lock.ts:167  const ownerToken = env[TEST_RUN_LOCK_TOKEN_ENV]
test-run-lock.ts:169  throw new Error("The wrapped Bun test lock capability is incomplete; ...")
```

A bare run never sets those two variables, so the preload throws at line 36 —
**before** the sandbox is installed and before `OCX_TEST_HOME_GUARD = "1"` at
line 64. Every guarded seam in that file's realm then refuses.

macOS never reaches the check: line 162 returns early on any non-win32 platform.
That is why the same three files are green locally at the same SHA.

### Why the failure count differs per shard

It is a function of how many guarded files land in the shard, not of flakiness.

## Fix (NOT IMPLEMENTED)

The original draft proposed an OCX_TEST_RUN_KIND provenance marker plus edits to
scripts/test-run-lock.ts, scripts/test.ts and tests/preload.ts. **That proposal is
withdrawn and deliberately not reproduced here**: the audit showed it unsound
(`??= "bare"` preserves an ambient `wrapped`, and OCX_TEST_NO_QUEUE=1 already
separates a marker from its capability), and the defect it targeted does not exist
on the pinned runtime.

If this class ever returns, the candidate to evaluate FIRST is deleting the
write-back at tests/preload.ts:41 — bare identity is already stable per process or
parallel controller (scripts/test-run-lock.ts:365-371), and no consumer was found
that needs a bare preload to publish OCX_TEST_RUN_ID.
