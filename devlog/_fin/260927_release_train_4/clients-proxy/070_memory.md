# Phase 7: selected models for Codex memory (#5983)

Depends on `060_jev.md` for serial changes to `src/types/config.ts`. The source
PR spans 51 files. The carried classifier treats explicit turn metadata as
authoritative and consults the `x-openai-subagent` header only when that
metadata is absent.

## Exact change map

- NEW `src/server/responses/memory-models.ts`: classify memory phases from
  validated turn metadata. Before: no memory-specific target. After: an
  explicit `none`/non-memory metadata result returns no memory route, and the
  legacy subagent header is consulted only when metadata is absent. Reject
  malformed target settings without silently selecting a different model.
- MODIFY `src/server/responses/request-prepare.ts` and the related normalize,
  options, availability, and config modules only to thread the selected
  memory target through both HTTP and WebSocket admission. Do not import Lab
  from `src/server/responses/core.ts`, `src/router.ts`, or
  `src/server/lifecycle.ts`; do not add a timer for no-memory users.
- MODIFY `src/types/config.ts`, `src/types/request.ts`, config schema/leaf
  validation, CLI/config docs, management config route, and GUI Memory panel
  and locale keys so input, persisted value, reload and consumers agree. No
  hand-counted preset/capability totals.
- REVIEW and MODIFY the relevant mapped source-of-truth documents:
  `structure/config.md` for the persisted setting,
  `structure/transports/responses.md` and
  `structure/transports/responses-failover.md` for routing behavior,
  `structure/gui-and-management-api.md` for settings exposure, and
  `structure/providers-and-adapters.md` for `src/types/` ownership.
  Check the other documents mapped to `src/server/` in
  `structure/INDEX.md`; update any whose described contract changes.
- NEW `tests/responses/responses-memory-models.test.ts`: send explicit
  non-memory metadata plus a subagent header and assert the normal model
  serves the request. Cover real memory metadata, absent metadata fallback,
  unavailable selected target, HTTP and WebSocket entry, and no-memory
  baseline. The WebSocket case must enter through actual WebSocket admission,
  not merely call the classifier with `transport: "websocket"`.
- NEW `tests/config/settings-memory-models.test.ts`: cover accepted and
  rejected persisted memory targets, load degradation, and management-save
  behavior without dropping unrelated config.
- MODIFY relevant `gui/tests` for model selection and disabled/unknown
  targets. Register both new test files in `scripts/test-layout/layout.json`
  and `tests/fixtures/test-layout-expected.json`.

## Acceptance and proof

Activation: a memory-phase request with configured target routes there;
explicit non-memory metadata never routes there even with the fallback header;
no setting retains current behavior. Run `bun test
tests/responses/responses-memory-models.test.ts
tests/responses/responses-shadow-intercept.test.ts
tests/config/settings-memory-models.test.ts`, a WebSocket entry-path
regression, and the relevant `gui/tests`,
`bun run test:changed`, `bun run typecheck`, `bun run lint:gui`,
`bun run build:gui`, `bun run structure:check`, `bun run privacy:scan`,
and `bun test tests/lab/core-lab-boundary.test.ts`. Inspect user-facing
English/translated docs, current merged type unions and file-size caps.
Require GUI screenshot and exact-head CI before merge.
