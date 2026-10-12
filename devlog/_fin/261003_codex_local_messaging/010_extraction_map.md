# 010 — source extraction map

Source experiment: `feat/claude-messaging` at
`9875e0c363579230fc53c0bea3114c868ef5ec94`.
Destination base: upstream `dev` at
`2e3acab46e20b9bc7eace0c9301bf4330be83ac1`.
Paths below are relative to the respective repository, not links claiming these
modules already exist on the destination branch.

## Reuse by responsibility, not whole feature commits

| Experiment source | Local responsibility | Disposition |
| --- | --- | --- |
| `src/messaging/socket.ts` | Bun Unix WebSocket adapter | Extract with unsupported-platform and socket-URL tests |
| `src/messaging/rpc.ts` | Initialize/initialized, metadata reads, pagination, pending requests | Extract; add whole-operation deadline, bounded metadata concurrency and strict response validation |
| `src/messaging/process.ts` | No-shell child runner, output bounds, termination/join | Extract; retain abort/timeout cleanup and sanitized failures |
| `src/messaging/send.ts` | Exact resolution, native queue invocation, uncertain receipt | Rewrite local-only; remove store, bridge, enrollment, Claude, isolation and remote authentication dependencies |
| `src/messaging/sender.ts` | `CODEX_THREAD_ID` plus metadata-only name | Rewrite Codex-only; no machine store, permission attribution or cross-harness process inference |
| `src/messaging/envelope.ts` | Message kinds, IDs, reply/correlation | Rewrite compact local routing; no machine identity or managed response skill |
| `src/messaging/types.ts` | UUID validation, local receipt/thread/error types | Extract only local types, not mesh/peer/policy state |
| `src/cli/message.ts`, `src/cli/message-args.ts` | Command dispatch and argument parsing | Rewrite minimal local commands; do not retain unavailable feature flags |
| `tests/helpers/messaging.ts` | Isolated daemon fixture | Replace store-dependent fixture with standalone Unix socket fixture |

Exclude `src/messaging/` store/files/runtime/slot/bridge/policy/supervisor/SSH,
enrollment, mesh, directory/cache, isolation, idle, Claude, sender-permissions,
sender-process and managed-skill modules. Do not carry messaging assets or
server management routes. Existing broad lifecycle/authentication tests do not
prove the new CLI-only boundary.

## Reuse destination facilities

| Current upstream file | Purpose / integration caution |
| --- | --- |
| `src/codex/home.ts` | Effective home resolution; do not hard-code a user's home |
| `src/codex/runtime.ts` | Runtime selection; use non-persisting resolution, not `resolveAndPersistCodexRuntime` |
| `src/codex/exec-invocation.ts` | Preserve launcher invocation semantics instead of assuming the selected command is a native executable |
| `src/cli/dispatch.ts` | Command-local dynamic import; no startup activation |
| `src/cli/registry.ts`, `src/cli/capabilities.ts`, `src/cli/help.ts` | Register the minimal surface and derive/regenerate documentation counts |
| `scripts/test-layout/layout.json`, `tests/fixtures/test-layout-expected.json` | Register each new domain test in both files |
| `structure/manifest.json`, `structure/INDEX.md` | Add ownership and regenerate index when source is introduced |

Observed runtime resolution ranks environment/configured/discovered candidates
and performs version probes in temporary Codex homes. It does not itself install
a runtime. Preserve bounded command execution by injecting a bounded async probe
and checking the operation deadline; do not allow a large candidate search to
escape the messaging command's budget. Avoid modifying the shared runtime
resolver solely for this feature unless evidence shows a required fix.

## Existing regression seeds

- `tests/codex-integration/messaging-transport.test.ts`: metadata-only sender,
  Unix transport translation, single submission, ambiguous/incomplete names.
- `tests/codex-integration/messaging-envelope.test.ts`: explicit kinds, IDs,
  body-independent reply routing and no courtesy-ack obligation.
- `tests/codex-integration/messaging-lifecycle.test.ts`: broad default-off checks;
  replace with command-local import/resource assertions rather than copying the
  broad runtime's lifecycle.
- `tests/codex-integration/messaging-native-queue.test.ts`: opt-in native queue
  fixture through an authenticated bridge; replace with direct Unix fixture.
  Its existence is not evidence that the native test ran.

## Evidence limits

This is a direct source inventory, not a certified import graph or exhaustive
blast-radius analysis. No complete dependency graph was materialized for this
preparation pass.

A text search of destination `src/` and `tests/` found no existing
`app-server-control`, `ws+unix`, `thread/loaded/list` or `thread/queue/add` matches.
That bounded observation is not a claim that no related functionality exists.
Current app-server process/restart management and remote workspace transport are
different responsibilities; no reuse of their session-creation behavior is assumed.
