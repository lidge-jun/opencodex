# 200 - local Windows verification before promoting 2.27.0

Run on the maintainer Windows machine at `dev` = `70e8bab42` (v2.27.0),
Bun 1.3.14, Windows 11. This is the operator-side check that 190 asked for
before promotion, recorded with its evidence rather than summarized after.

## Results

| Gate | Result |
|---|---|
| `bun install` | clean, no changes across 105 installs |
| `bun run typecheck` | exit 0 |
| `bun run test` | 8028 pass, 1 fail, then a Bun runtime panic |

The suite took 2021s against a ~210s idle baseline, so the machine was heavily
contended. That matters for reading the result: slowness alone did not produce
the failure below, which is why it was re-run in isolation.

## The one failure, and why it is not this release's

`tests/codex-app-server-processes.test.ts` - "a defaulted read is memoized, and
invalidation is what clears it" (#1046).

It reproduces standalone in six seconds, so it is not a contention artifact.
It is also not caused by `main...dev`: checking out **`origin/main`'s copy of
both `src/codex/app-server-processes.ts` and the test file** and re-running
produces the identical single failure. Same defect, older code.

The mechanism is environmental. This machine runs live Codex app-servers, so
the probe finds real processes and returns `unknown`, which carries the
deliberate 250ms `CATALOG_STATE_UNKNOWN_TTL_MS` window instead of the 5s one.
The second call lands outside that window, recomputes, and returns a
structurally equal but distinct object - hence "serializes to the same string".
A CI runner has no Codex app-server running, reaches `not_running`, and gets
the full 5s TTL, so the case passes there and fails only on a developer box
that is actually using Codex.

Worth stating plainly: the test asserts object identity through a cache whose
TTL depends on what the machine happens to be running. That is a real test
defect, not a product defect, and it belongs to #2152's family rather than to
this release.

## The trailing panic

The run ended with `panic: Internal assertion failure` inside Bun itself, after
the last test file reported. This is the shard-2 Bun runtime panic already
tracked in [#2152](https://github.com/lidge-jun/opencodex/issues/2152) - a
runtime crash, not a test result.

## Verdict

Promotion criterion as stated in 190 and confirmed at the audit gate: zero
failures **outside** the tracked #2152 set. Met. Typecheck is green, the suite
is green except for one pre-existing environment-dependent case proven against
`origin/main`, and the panic is a known tracked crash.
