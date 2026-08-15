# 110 — Release readiness for `dev` @ 4b950101a

## Outcome

`dev` is release-ready. Every repository gate is green on the exact head, on the Linux
validation host and in CI across all three platforms.

| Gate | Result |
|------|--------|
| `bun run test` | 12388 pass, 11 skip, **0 fail**, 158046 expect() across 789 files (447.98s) |
| `bun run typecheck` | clean |
| `bun run privacy:scan` | passed |
| `bun run build:gui` | built, package prepared |
| `bun run lint:gui` | 0 warnings, 0 errors |
| CI @ 4b950101a | ci, gates, test 1-4/4, macos, keyring x3, npm-global x3, storage policy, api usage — all success |

`origin/dev`, the local checkout, and the remote validation host all sit on
`4b950101a1116d8bac4e479cb2dceca3bb80370e`.

## The "122 failures" were a missing `--isolate`, not a defect

An earlier run in this session invoked `bun test` with no flags and reported 122 failures,
with 67 "refusing to write the real OpenCodex home" errors in the log. The same 122 appeared
on the pre-session baseline, which is what first showed the count was not caused by any
change here.

**The trigger is the missing `--isolate`, not a missing sandbox.** That distinction matters,
because the first version of this note blamed the wrapper and was wrong. `tests/preload.ts`
is registered in `bunfig.toml` precisely so a bare `bun test` still gets a sandbox and an
armed guard; that defense works, and it is why a bare `bun test <file>` passes.

What `bun run test` adds is process isolation: `scripts/test.ts` spawns
`bun test --isolate ./tests/`. Without `--isolate`, Bun shares one process across test files.
The preload runs once per process, so one sandbox is created and all 789 files then run
inside it — and any suite that mutates `process.env.OPENCODEX_HOME`, or restores a captured
environment in `afterEach`, can leave a later file pointing back at the operator's real home.
`assertNotRealHomeUnderTest` correctly refuses that write, and the refusal surfaces
downstream as an unrelated assertion: empty `usageRows()`, a missing `admissionKind`, a 503
where a 429 was expected.

Measured on this host, same commit, same machine:

| Invocation | Refusals | Failures |
|-----------|----------|----------|
| `bun test` | 67 | 122 |
| `bun test --isolate tests` | 0 | 0 |
| `bun run test` | 0 | 0 |

The middle row is the one that isolates the variable: no wrapper and no sandbox hand-off,
only `--isolate` plus the preload, and it is completely green. It is also the exact command
`scripts/release.ts` runs in its preflight, so the release gate is unaffected.

**Operational note:** run `bun run test`. A bare `bun test` shares one process across the
whole suite and produces cross-file environment bleed that looks like product defects; a bare
`bun test <file>` on one file is fine.

## Not claimed here

This records that `dev` passes its gates. It is not a release: no version bump, tag, npm
publish, or promotion to `preview`/`main` was performed, and `scripts/release.ts` remains the
only authority for those.
