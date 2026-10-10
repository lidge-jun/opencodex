# 020 — native contract and acceptance ledger

Preparation snapshot, 2026-10-03, before implementation or source tests.
Subsequent foundation implementation and verification are recorded in
[030](030_foundation_implementation.md); the remaining matrix is not all complete.

## Native evidence actually obtained

Native binary: `codex-cli 0.160.0`, Linux x86_64 musl distribution.
Binary SHA-256:
`12eb3e81114588aca3b7998f4f19e8997b056aca08e57a7ca7c8a3ec8c652aad`.

Executed `codex --version`, `codex queue --help`, and offline schema export:

```bash
codex app-server generate-json-schema --experimental --out <scratch>/schemas
```

Schemas are ignored scratch artifacts, not vendored upstream source. Regenerate
from the pinned binary for interoperability verification. No live message, daemon
startup, session resume, API inference or queue write was performed in this pass.

| Contract | Evidence and limit |
| --- | --- |
| Initialization | Official app-server documentation describes one initialize request followed by initialized per connection |
| Loaded discovery | Generated `ThreadLoadedListParams` has optional limit/cursor; response requires data IDs with optional nextCursor |
| Metadata read | Generated `ThreadReadParams` requires threadId and permits includeTurns; use false |
| Queue CLI | Help exposes thread/message/remote; remote accepts Unix sockets. Resolve the target ourselves, then supply its ID |
| Queue RPC | Generated `ThreadQueueAddParams` requires threadId, input and clientUserMessageId; response requires queuedSubmission with id/input/clientUserMessageId |
| Control socket path | Existing experiment uses `<effective CODEX_HOME>/app-server-control/app-server-control.sock`; deployment convention still needs native runtime verification, not schema inference |
| Unix transport spelling | Bun `ws+unix://<path>:/` versus native CLI `unix://<path>`; prove translation against isolated native queue fixture |
| Queue completion | Schema acknowledgement is not evidence of recipient processing, steering or end-to-end delivery |

[Official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)
was consulted after an official-domain search. Its overview did not document
`thread/queue/add`; the queue-specific evidence above comes from this binary's
generated schemas/help, not an invented public API guarantee.

Generated schema SHA-256 receipts:

| File under `v2/` | SHA-256 |
| --- | --- |
| `ThreadLoadedListParams.json` | `42c2d124ab2b2998d84f0126daae2d32b0bf9c5a7ea7266e3a0814e5e37cf00d` |
| `ThreadLoadedListResponse.json` | `1ea02c4710083e552b2a3a89b931b9049d5bf05b7db46278b8352cf9fd80cd52` |
| `ThreadQueueAddParams.json` | `60f25b7d3e3357c215bef9d2fe7047200f545e030dca9e00527ac0620cd0c88f` |
| `ThreadQueueAddResponse.json` | `c11b9772788427b19c9f9decf0765e2b41cbdead1aa9c3d39f42fdd70b339314` |

Only 0.160.0 was inspected here. Minimum supported version, cross-version
compatibility, macOS operation and actual native queue interoperability remain
unverified. Do not claim a supported version range from presence of help flags.

## Named offline acceptance cases (proposed, not yet implemented)

All files below belong in `tests/codex-integration/`; use a standalone
`tests/helpers/messaging-local.ts` with fresh scratch home/socket, no actual
sessions, no global config, no listeners surviving teardown and strict RPC
allowlisting. An unexpected thread/start, thread/resume or turn/start must fail.

| Proposed file | Required cases |
| --- | --- |
| `messaging-local-discovery.test.ts` | metadata-only loaded discovery; exact ID/name; duplicate or absent names; incomplete metadata; repeated/exhausted cursors; malformed/oversized pages; unloaded ID; empty valid directory; bounded concurrency |
| `messaging-local-send.test.ts` | Unix argv translation; effective home and launcher selection; unsupported queue fails before send; one submission on success; lost receipt/nonzero/timeout yields unknown and no replay; preflight failure yields not_sent; cancellation before/after invocation; no daemon start/resume |
| `messaging-local-envelope.test.ts` | generated IDs; response correlation; explicit kind; no ack obligation for responses/FYIs; missing sender cannot invent reply; names/body cannot supply routing; UUID/control-character validation; bounded stdin/full envelope; no body in receipts/logs |
| `messaging-local-lifecycle.test.ts` | disabled startup imports/activates no messaging; no store/listener/timer/skill/probe on ordinary startup; RPC abort/close clears requests/timers/listeners; oversized frame/output ends safely; terminated own child is joined; whole-operation deadline covers discovery/probes; Windows unsupported |
| `messaging-local-native-queue.test.ts` | pinned actual native queue against isolated Unix fixture: initialize handshake, exact ID, exactly one thread/queue/add and correlated queued submission; no lifecycle mutation; failed/lost acknowledgement cannot trigger replay |

Native interoperability is opt-in locally using an explicit binary path/version
receipt; the deterministic fixture regressions must run offline by default.
Pin the native binary in CI only through accepted repository installation policy;
do not silently download a moving `latest` or count an opt-in skip as passing
interoperability. Investigate capability mismatch before declaring support.

## Verification and readiness sequence

1. Implement fixture/RPC tests, then discovery, envelope/send and CLI integration;
   run focused regressions at each stage. Register new files in both test maps.
2. Run the native Unix fixture test with exact binary/hash recorded. It must not
   connect to the user's daemon or require an API key.
3. Before review readiness: `bun run typecheck`, focused source-oracle/CLI/layout
   regressions, `bun run test:changed` and the default `bun run test`; document any
   resource exception and exact coverage left to CI rather than claiming a pass.
4. Run `bun run privacy:scan`, `bun run structure:check`, and
   `bun run skill:surface:check` after registry/docs integration. Check file-size
   ratchets; extract siblings instead of raising caps.
5. Recheck current `dev`, resolve correct automated review findings, obtain
   independent/security review and inspect required CI for the exact PR head.
   Follow the contributor draft/readiness checklist; missing or skipped CI is not
   passing evidence. Publication/merge/deployment are separate authorizations.

Preparation-only validation should cover whitespace, referenced source paths,
document links and privacy/structure guards. Do not rerun the source suite merely
to validate unchanged code or label this document packet review-ready software.

## Preparation verification receipt

On 2026-10-03, using the existing repository's Bun executable against the
isolated destination worktree:

- `bun scripts/privacy-scan.ts`: passed for the tracked repository.
- `bun scripts/structure-ssot.ts`: passed.
- Direct `scanText` on all three new, then-untracked preparation files: passed.
- Direct whitespace/relative-link checks and existence checks for 25 source
  references across the source and destination trees: passed.
- `git diff --check`: passed; new files also checked directly because an
  unstaged untracked file is not included in this command's diff.

No runtime source changed. Typecheck, the source test suite and native queue
interoperability were not run; these preparation checks do not substitute for
implementation acceptance evidence. No publish, install or restart occurred.
