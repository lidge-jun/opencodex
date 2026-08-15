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

## The "122 failures" were a harness misuse, not a defect

An earlier run in this session invoked `bun test` directly and reported 122 failures. That
number was an artifact of the invocation, and the same 122 appeared on the pre-session
baseline, which is what first suggested it was not caused by any change here.

`bun test` is not the suite's entry point. `package.json` maps `test` to
`scripts/test.ts`, which builds an isolated environment per run: a `mkdtemp` root with
`HOME`, `USERPROFILE`, `OPENCODEX_HOME`, and `CODEX_HOME` pointed inside it, plus
`OCX_REAL_HOME` captured before the rewrite so the real-home write guard still knows which
path to protect.

Run raw, none of that exists. Suites that persist config resolved to the operator's actual
`~/.opencodex`, where `assertNotRealHomeUnderTest` correctly refused the write. Every one of
the 122 failures is that refusal surfacing as a downstream assertion — empty `usageRows()`,
a missing `admissionKind`, a 503 where a 429 was expected. The guard did exactly its job; the
harness was simply absent.

Confirmation: the same files pass in isolation and in groups (216/216 for the six heaviest),
and the full suite under `bun run test` reports 0 failures.

**Operational note:** run `bun run test` on this repository. Raw `bun test` writes to the real
home, is refused, and produces failures that look like product defects.

## Not claimed here

This records that `dev` passes its gates. It is not a release: no version bump, tag, npm
publish, or promotion to `preview`/`main` was performed, and `scripts/release.ts` remains the
only authority for those.
