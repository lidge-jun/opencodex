# 003 — Audit record: four rounds, three distinct failure modes

Record of the A-phase gate. Kept because the refutations are more instructive
than the conclusion.

| Round | Verdict | What failed |
|-------|---------|-------------|
| 1 | FAIL (8 blockers) | **The root cause was wrong.** Stub-Bun narrative refuted by code the unit never opened |
| 2 | FAIL (7 blockers) | **The fix could not work.** `execFileSync` discards the stderr the guard reads |
| 3 | FAIL (5 blockers) | **The fix was not in the file.** Atomic patch rejected; only the test half re-applied |
| 4 | FAIL (4 blockers) | **Same mechanism again.** A seam declared in prose but not threaded through the code block |

The root cause has held unchanged since round 2. Rounds 3 and 4 failed on
*transcription*, not analysis — which is its own lesson, recorded at the bottom.

## Round 1 — the root cause was wrong

`FAIL`, 8 blockers. Independent reviewer, read-only, dispatched against the
7-document R1 unit.

## The load-bearing refutation

R1 claimed: *the `bun` package's 450-byte postinstall placeholder gets baked into
the plist, and launchd re-execs it forever.*

The reviewer opened one file R1 never did:

```ts
// src/lib/bun-runtime.ts:35-46
export function bundledBunPath(): string | null {
  try {
    const bunDir = dirname(require.resolve("bun/package.json"));
    for (const name of ["bun.exe", "bun"]) {
      const p = join(bunDir, "bin", name);
      if (isRealBunBinary(p)) return p;      // <-- the stub is already rejected here
    }
    return null;
  } catch { return null; }
}
```

`cliEntry()` → `durableBunPath()` → `durableBunRuntime()` → `bundledBunPath()`.
The stub is filtered one call **before** anything is baked. R1's central claim
that "`isRealBunBinary` is not consulted on the service path" was wrong: it is
consulted, one frame earlier than R1 looked.

Confirmed by hand rather than taken on the reviewer's word — the source above is
the current working tree.

The reviewer added a second, independent kill: the update worker's reinstall runs
`node <pkg>/bin/ocx.mjs service install` ([src/update/job.ts:117](../../../src/update/job.ts),
[:303](../../../src/update/job.ts)), which enters `resolveBun()`
([bin/ocx.mjs:344](../../../bin/ocx.mjs)) — the *same* self-heal R1 credited for
making `ocx start` work. So the re-bake would have **repaired** a stub, not
perpetuated it. R1's asymmetry table row was backwards.

And R1 undercut itself: it measured `npm install --ignore-scripts` while
simultaneously stating npm 11.17 does not do that by default — i.e. it measured a
scenario that was not the reported one, then built the unit on it.

## The methodological failure

> "This is a root-cause document built entirely from code reading."

Correct, and the decisive criticism. `buildPlist()` sets `StandardErrorPath` to
`~/.opencodex/service.log` ([src/service.ts:300](../../../src/service.ts)); a
crash-looping exec writes its reason there every few seconds. R1 never read it,
never read the installed plist, never ran `launchctl print`.

The correction was one command:

```
$ launchctl load -w ~/Library/LaunchAgents/com.opencodex.proxy.plist
Load failed: 5: Input/output error
Try running `launchctl bootstrap` as root for richer errors.
$ echo $?
0
```

**Failure on stderr, exit code 0.** `startLaunchd()`
([src/service.ts:1294](../../../src/service.ts)) wraps exactly this in `sh()`,
which is `execSync` and throws only on non-zero. That is the actual defect, and it
was reachable in one command from the machine the whole time. It also happens to
be the reviewer's own second alternative hypothesis, which R1's author had not
considered.

## Confirmed-accurate criticisms adopted

| Blocker | Status |
|---|---|
| Stub narrative refuted | Retracted; demoted to WP1 hardening |
| No machine evidence collected | Fixed — `launchctl print`, plist, and load-exit measured |
| `launchctl load -w` hypothesis missing | Now the root cause |
| `tests/service.test.ts:816-823` would turn red under WP1's size floor (`bunPath` is `service.test.ts`, 47,317 bytes) | Confirmed by reading the file; folded into WP1 |
| WP1's "red-first proof" was a TypeScript compile error, not a red test | Confirmed; rewritten |
| `confirmServiceServing`'s `port` parameter unused; `findLiveProxy()` resolves via pidfile, not the baked port | Confirmed; WP2 rewritten |
| `io.healthTimeoutMs` overloaded with the existing `/healthz` window ([src/update/job.ts:1022](../../../src/update/job.ts)) | Confirmed; WP3 uses a distinct field |
| `advancingClock()` does not exist in `tests/` | Confirmed; use the file's `let now = 0` convention |

All line numbers in R1 were wrong by 5-370 lines (transcription drift, not rebase
drift). Every citation in R2 was re-derived with `grep -n` against the working
tree.

## What R1 got right, retained

- D2 and D3 as *code shapes* — both confirmed to exist exactly as described.
- The pre-existing test collision at `tests/update-job.test.ts:306-325`, and the
  instruction to inject `probeProxy` rather than shrink the timeout.
- Devlog convention compliance (decade numbering, research/implementation
  separation, no bare filenames, security notes to `.tmp/`).

## Process note

A `NEAR-PASS` here would have shipped four phases of hardening against a
mechanism that cannot occur. The audit gate paid for itself in one round, and the
cost of the correction was a single `launchctl` invocation — which is the lesson:
**measure the failing machine before modelling it.**

## Round 2 — the fix could not have worked

The rewritten WP1 specified a `runLaunchctl` built on `execFileSync`. The reviewer
executed it against the real plist:

```
execFileSync(["load","-w",plist])  ->  returns, stdout: ""            # stderr LOST
spawnSync   (["load","-w",plist])  ->  status: 0,
                                       stderr: "Load failed: 5: Input/output error…"
```

`execFileSync` discards stderr when the child exits 0 and throws only on a
non-zero exit — so the guard could never fire. The unit tests would have passed,
because their mocks fabricated a `stderr` the real API never produces.

**Same failure class as round 1, one level down:** validated against a model of
the API rather than the API. Confirmed by hand before adopting.

## Rounds 3 and 4 — the seam that was never threaded

Round 3's fix was written as one large `apply_patch` touching both the runner and
its tests. The test hunk failed to match, the patch was rejected **atomically**,
and only the test portion was re-applied. Result: tests injecting `run:` against
an implementation still reading `deps.exec`. Reported as landed without re-reading
the file.

Round 4 repeated the shape inside `startLaunchd`: the deps object appeared in the
prose, the tests injected it, and the code block declared no parameter.

Both rounds were caught by the reviewer running `grep -c` on the artifact rather
than trusting the summary of it.

### Standing rule for this unit

**After every edit, verify with `grep` on the file — never from memory of the
patch.** A rejected `apply_patch` is atomic: partial re-application silently
desynchronizes an implementation from its tests, and that desync typechecks in
prose while failing on a machine. Both times, the reviewer's first move was
reading the file; both times, that was enough.
