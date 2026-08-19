# 130 — CI red: the proxy env leak that made 73 Lab tests fail

Found because the user asked why PR #2116 was red. It was not flake, and it was
not inherited from `dev`.

## What the checks actually said

| PR | `macos` | failures |
|---|---|---|
| #2116 / #2117 / #2118 | fail | **73** |
| `dev` @ `0fc8d136e` | fail | **1** (`provider request pacing queue`) |

So `dev` was red too, which is what made this easy to wave off. But 73 ≠ 1, and
the 73 were all Lab/fabric tests that #2116 never touches.

## The failure

```
LabSandboxError: proxy environment variable HTTP_PROXY is forbidden
  code: "harness_failure"
  at rejectProxyEnvironment (src/lab/live/sandbox.ts:14)
  at runFabricSyntheticPatchTaskInternal (src/lab/fabric/executor.ts:157)
```

The Lab sandbox refuses to run if any proxy variable is set on the live
`process.env` — it must not dial out through a proxy. Correct, and it was doing
its job.

## The cause

The #2107 tests set the real environment and restored it in a `finally`:

```ts
const saved = { ...process.env };
try {
  process.env.HTTP_PROXY = "http://127.0.0.1:7890";
  ...
} finally { /* restore */ }
```

That reads as airtight. It is not, because **`bun test a.test.ts b.test.ts`
runs every file in one process, and `--isolate` does not change that.** The
variable outlived the file, and every Lab file loaded afterwards died on an
environment it never touched.

## Isolating it

The bisect that settled it, all on our branch:

| Run | Result |
|---|---|
| Lab suites alone | 42 pass / 0 fail |
| `service.test.ts` + Lab suites | 39 fail |
| Same pair on `origin/dev` (our commits absent) | 144 pass / **0 fail** |

The third row is the one that mattered: same files, same machine, our commits
removed, green. That converts "CI is flaky" into "we broke it".

A probe file printing `process.env` at module-evaluation time then showed
`HTTP_PROXY` already set **before** `service.test.ts`'s own tests ran, which is
what proved the leak was cross-file rather than a bad `finally`.

## A wrong turn worth recording

The first fix assumed Bun's `{ ...process.env }` yields `null` rather than
`undefined` for absent keys, so the restore's `=== undefined` check took the
wrong branch. A probe did print `null` — but that was the *restore loop's own
output*, not the snapshot. Ablation killed the theory: with and without the
"fix", 50 fail / 50 fail, byte-identical. A change that does not move the number
is not a fix, however good the story is.

## The actual fix

Stop mutating global state to test a pure function.

`buildUnit()` and `buildPlist()` now take the resolved proxy entries as a
parameter defaulting to `resolvedProxyEnv()`. Production behavior is unchanged
— the default is the old call — and the tests hand in a literal environment
instead of assigning onto `process.env`. `resolvedProxyEnv()` already accepted
an `env` argument; it is now exported so a test can use it the way the runtime
does.

A third assertion was added while the seam was open: a lower-case `http_proxy`
must be baked under the canonical upper-case name. That behavior was implemented
and documented in #2107 but never asserted.

## Verification

The five suites that carried the failure — `service`, `lab-live-probe`,
`lab-fabric-task`, `lab-automation`, `api-key-attribution` — go **50 fail → 0
fail, 236 pass**. `tsc --noEmit` exit 0.

Full suite runs on `ssh lidge` per standing instruction, not the workstation.

## Stack consequence

The fix belongs to #2116, the bottom of the stack, so it was committed there
(`2d7b945b6`) and the other three branches were rebased onto it. All four
force-pushed with `--force-with-lease`.

`dev`'s own single failure (`provider request pacing queue`) is a separate
matter and is not ours to fix inside this stack.

## What this changes about the working rule

The standing instruction was to ignore CI while the merge train churns and judge
from local green. That was right for a churning `dev` — but "ignore CI" cannot
mean "do not look at CI". Local green missed this entirely, because the local
runs were per-suite and the defect only exists across suites in one process.

