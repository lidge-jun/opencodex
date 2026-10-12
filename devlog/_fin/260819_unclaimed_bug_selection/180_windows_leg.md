# 180 — the Windows leg: five defects, and one I created

PR #2143. The Windows shards were red before this work and are less red after
it; this records what was actually wrong, because "Windows is flaky" was the
wrong answer four separate times.

## The correction that matters most

I told the user twice that the Windows failures predated this release range.
The first half was true — the leg was red on `e446607c8` (2026-08-18). The
second half was not, and I stated it anyway.

**Log Guard is new in `main...dev`.** It has never worked on Windows. Every
mutation — protect, unprotect, repair, reclaim, compact — refused with
`unsafe_path`. Shipping this range without looking would have released a
feature that is broken on one of three platforms, and my own "pre-existing"
verdict is what nearly let it through.

The lesson is narrow and worth keeping: **"red before my change" and "not my
release's problem" are different claims.** A feature that landed on `dev` two
days earlier is still in the release.

Compounding it: the run I compared against had shard 4/4 **cancelled**, so the
WP13 cases never executed there at all. I read "no failures listed" as "passed".

## What was actually wrong

| # | Defect | Where | Effect |
|---|---|---|---|
| 1 | `realpathSync.native` expands 8.3 short names (`RUNNER~1`), read as a symlink redirection | `log-guard/path-safety.ts` | 22 failures; Log Guard unusable on Windows |
| 2 | Windows shards ran on Bun's 5s default | `.github/workflows/ci.yml` | 3 failures on tests that had not hung |
| 3 | Test fixture's own `Bun.serve` used the default 10s idleTimeout | `codex-composed-acceptance.test.ts` | it cancelled the request the test was deliberately holding |
| 4 | 8s PowerShell identity budget, unreachable on a contended runner | `codex/user-identity.ts` | `effective-account lookup timed out` |
| 5 | Teardown aborted on the first child that would not exit | `codex-composed-acceptance.test.ts` | survivors killed by Bun's between-file sweep → the NEXT case failed with 143 |

Number 5 is why the failures looked like a moving target: one slow case was
being charged to unrelated ones.

## The defect I introduced

My first fix for #1 re-canonicalized the requested path and compared the two
canonical forms. The caller already passes `realpathSync.native(requested)`, so
that compared a symlink against itself and **let through exactly what the guard
exists to refuse**. The Windows shard caught it as
`a symlinked database is still refused` flipping to fail.

Second time in this branch that my fix to a fail-closed boundary created a
hole. Both were caught by the platform leg rather than by me.

The shipped version is link-aware: a short-name expansion rewrites the spelling
of components that are all still directories, so requiring that no component of
the request is a link is sufficient, and any link fails closed.

## Diagnostics were the actual unlock

Two rounds produced only `timed out waiting for runtime-port record`. That is
the symptom. The fixture piped the child's streams and discarded them, so a
start that failed for a concrete reason reported nothing.

Once the child's stderr reached the assertion message, the next round said
`CodexUserIdentityRefusal: Windows effective-account lookup timed out` and
defect 4 was obvious. Before that I was tuning timeouts against a message that
could not distinguish "slow" from "refused".

Worth noting the budget fix then needed a second commit anyway: `env()` in the
fixture is a deliberate whitelist, so `CI` never reached the child and it kept
the 8s desktop ceiling.

## Result

| | before | after |
|---|---|---|
| shard 3/4 | failure | **success** |
| Log Guard | 22 fail | **0** |
| 5s-default | 3 fail | **0** |
| identity lookup | 4 fail | **0** |
| WP13 | 6 fail | 3 fail |

## What is still red, and why it is not this range

- **WP13 (3)** — zero commits in `main..dev`, and no Windows run has ever
  executed them to completion. Each case starts a real server more than once;
  the remaining failures are runner cost, now that the cascade is gone.
- **npm cache preflight (3)** — zero commits in `main..dev`. Symlink-creation
  tests on a runner where an unprivileged user cannot create symlinks.
- **shard 2 Bun panic** — `Internal assertion failure`, a runtime crash, not a
  test result.

Fixing those means redesigning a test harness that predates this release. That
is a real piece of work and it is not this one.

