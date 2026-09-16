# WS commit boundary — 260911

Base: `origin/dev` `babb76449f` (fetched 2026-09-11 KST). Branch `codex/260911-ws-commit-boundary`,
worktree `/Users/jun/.codex/worktrees/260911-wsc/opencodex`.

## Why this unit exists

#4191 reports a long Codex thread that fails only while routed through OpenCodex, as either
`codex websocket closed before a Responses terminal event (close 1006 Connection ended)` or
`codex websocket response prelude timed out`, and works immediately when the proxy is bypassed.
#4083 raised the fixed prelude deadline from 30 s to 90 s for slow multi-image starts; #3976 asked
for the number to be configurable; #2471 fixed the 16 MiB create-frame ceiling.

The lane dispatch round (`260911_lane_dispatch_round`) added the #4191 failure-stage counters so
a user can tell an unanswered socket from one that carried only quota frames. That was
diagnosis. This unit is the fix to the boundary the diagnosis exposed, after an external
semantic review (`010_journey_evaluation.md`) overturned the first framing.

## Scope

- `src/server/responses/codex-ws-exchange.ts` — settle post-send, pre-response failures as an
  honest HTTP status; replace the fixed prelude timer with silence-based liveness; cancel the
  upstream turn on a pre-commit client abort.
- `src/server/responses/codex-ws-wire.ts` — liveness constants and the non-replayable body shape.
- `src/lib/upstream-retry.ts` — a non-replayable marker that `fetchWithTransientRetry` honours, and the
  structured error codes the other resend paths stop on.
- `src/server/responses/core.ts` — two early returns on the marker (pool quota rotation, opaque-blob
  recovery); `src/combos/failover.ts` — structured-code stop. See 025.
- `docs-site/src/content/docs/reference/configuration/server.md` — the prelude paragraph.
- `tests/responses/ws-upstream.test.ts`, `tests/lib/upstream-retry.test.ts` — oracle updates and
  new cases.

Out of scope, recorded in `020_design_record.md`: resume-by-id after 1006 (Codex does not request
background responses, so the vendor resume surface does not apply), the opt-in provider path
without a metadata channel (it commits at send today and keeps doing so), the create-frame size
predicate, and any core.ts change beyond the two marker guards named in 025.

## Rules for this unit

- No local product suite: no `bun test`, `bun run test`, `test:changed`, `typecheck`,
  `build:gui`, or `bun install` in this worktree. Every verification line reads NOT RUN until
  remote CI on the final head says otherwise.
- Push with `--no-verify` and `core.hooksPath=/dev/null`.
- xai/grok-4.6 subagents are read-only verifiers of the diff; aside/web research is free.
- One work-phase is one PABCD cycle: wp1 this roadmap, wp2 honest status + marker, wp3 liveness
  and abort propagation, wp4 PR, review, CI.

## Work phases

| wp | unit | doc | exit |
|---|---|---|---|
| wp1 | roadmap | 000, 010, 020 | docs committed on the branch |
| wp2 | honest post-send status | 030 | code + tests committed, NOT RUN |
| wp3 | liveness + abort | 040 | code + tests committed, NOT RUN |
| wp4 | PR + review + CI | 050 | final-head CI green, review dispositioned |

