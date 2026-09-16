# wp2 — #4169: every stop refusal is reported as a CODEX_HOME ownership mismatch

Work-phase 2 of the L4 lane, stacked on wp1. Carried source: PR #4170 by `yeongjunyoo`,
head `4d72ef0103`, three commits on base `c15a98caa9`. All four of its files are inside this
lane's ownership, so nothing was dropped.

## What the carry does

`POST /api/stop` refuses for three distinct reasons. `stopProxy` preferred the server's own
message but fell back, when none was readable, to one hardcoded sentence naming a fourth cause
the server never reports. #4170 captures the refusal `code`, selects the fallback wording from
it, and returns the refusal per attempt instead of publishing it to module state — the last of
those fixes a real interleaving bug where two overlapping stops could swap causes.

## What the carry left open

#4169's **Expected** section asks for two things:

1. a `respawnable_service` or `service_state_unknown` refusal must not be described as an
   ownership mismatch, and
2. *"the recommended next command should not be the command the operator just ran."*

The carry does (1). Subagent Heisenberg traced (2) and returned `LOOP_REAL`:

- `ocx stop` reaches `POST /api/stop` through `dispatch.stop` → `handleStop` →
  `stopWithDeferral` → `stopProxy` → `stopProxyGracefully`. Stopping the service manager
  first does not skip it.
- The server answers with *"the stop must be run by `ocx stop`"* because that refusal is
  written for an API client, and `management-api.ts` emits `respawnable_service` precisely
  when the CLI's teardown receipt was **not** honoured, so it cannot tell the two apart.
- `handleStop` prints `err.message` verbatim, so the operator is told to run the command they
  are already running.
- The carried fallback for `respawnable_service` also ends in "Run `ocx stop`", making the
  empty-body path a tighter loop than the one being fixed.

There is no header, flag, query parameter or route that marks a CLI-originated stop, so the
server cannot word the refusal differently. The correction belongs to the CLI, which is the one
caller that knows which it is.

## What this work-phase adds

- The refusal `code` travels on `ProxyOwnershipRefusedError`. The reporting caller acts on the
  cause; re-parsing the prose is not an option, because the prose is the server's.
- `refusalFallbackMessage` names the cause only.
- A new exported `refusalNextStep(code)` owns the command, and `handleStop` prints it under the
  refusal at both call sites. The only callers of `stopProxy` are `ocx stop` and the service
  manager's own cleanup, and both have already asked the service manager to stop by then, so no
  branch answers with the command that just failed.

`ProxyOwnershipRefusedError` keeps its name. The issue suggests renaming it and the name does
overstate what it carries, but the carrying author deliberately deferred that as a separate
wider change and it is not part of the issue's Expected behaviour. Recorded, not decided
unilaterally.

## Audit

Subagent Confucius reviewed the staged diff adversarially and returned `BLOCKERS_FOUND` with one
item: the new next-step test banned the literal `` `ocx stop` ``, which the production wording
contains **in order to rule it out**, so the test failed against its own implementation. Folded:
the assertion now bans a recommendation (`/Run \`ocx stop\`/`) rather than a mention. Its second
observation — that no test pinned the CLI wiring — is folded as a source oracle over the two
`refusalNextStep(err.code)` print sites.

Re-checked deterministically afterwards: the four source-oracle counts in
`grok-lifecycle.test.ts` are all exactly 2, and no `refusalNextStep` branch matches
`/Run \`ocx stop\`/`.

## CI repair carried into this phase

Hosted CI on wp1's head failed on Linux and macOS with one test:
`codex-cli-update-launcher-policy` asserts `bin/ocx.mjs` contains
`"!codexCliUpdateInspection && isNodeModulesInstall()"` as an adjacent string. The carry gates
the #1849 boot probe on the npm layout, inserting `installMethod === "npm"` between those two
clauses. The invariant the oracle protects is intact and still evaluated first; only the
adjacency changed. The oracle now locates the guard wrapping the `bootRestoreProbe` call and
asserts both clauses are in it.

`tests/codex-integration/codex-cli-update-launcher-policy.test.ts` is not in the packet's
keep-set. It is an oracle over `bin/ocx.mjs`, which this lane owns, and the round already
granted L2 the same thing for the same reason: a lane that changes a file owns the oracle
asserting it, or the change cannot land at all. Reported rather than assumed.

## Not run

`bun test`, `bun run test`, `bun run test:changed`, `bun run typecheck`, `bun run build:gui`
and `bun install` are NOT RUN by operator instruction. Hosted CI on the exact pushed head is
the only product evidence this round accepts.
