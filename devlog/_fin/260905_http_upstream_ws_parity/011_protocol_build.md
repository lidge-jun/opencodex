# Protocol build evidence

The protocol slice is implemented; connection reuse remains the separate 020 cycle.

## Changes

- `src/codex/forward-transport-headers.ts`: one pure Lite/hint owner. Main checked the actual upstream formatter and corrected the worker's initial `;service_tier=` spelling to the native `;tier=` grammar before integration.
- `src/server/responses/codex-ws-request.ts`: copied canonical frame preparation and independent HTTP fallback init; Lite explicit-header precedence and final hint derivation do not mutate caller input.
- `src/adapters/openai-responses.ts`: canonical Lite forwarding and finalized-body routing hint; other destinations keep their own headers.
- `src/server/safe-response-headers.ts` / `ws-bridge.ts`: shared safe response projection with compatibility export retained.
- `src/server/responses/codex-ws-metadata.ts`: bounded prelude/header snapshots, typed native quota mapping, filtered provider header metadata, weak Response ownership and terminal-before-attachment replay.
- `src/server/responses/ws-upstream.ts`: canonical first-event header commitment and post-send errored-body settlement, existing one-shot lifetime and noncanonical behavior retained. The file remains above the generic 400-line guideline because it preserves one existing state machine; lifecycle extraction in 020 remains planned rather than mixing a second rewrite into this slice.
- `src/server/responses/core.ts`: immutable final account/generation capture, prelude then latest observation, and eager-relay cleanup detach.
- Existing metadata, transport, and account-label tests exercise real dispatch and account writers; no new test-layout entries are needed.
- Transport SoT and English architecture reference now distinguish prelude headers, late account-state observation, and the unchanged HTTP client default.

## Verification observed during B

- Metadata-prelude regression first failed: expected header `31`, got null. It passes after the transport change.
- Pool/main-pool final quota test passes; removing the observer integration made it fail with expected `20`, got `10`, then restoring it passed again. Both account modes and untouched-account isolation are asserted.
- Request-only worker tests observed the missing Lite/helper red state, then 16 pass / 0 fail. Main independently fixed hint grammar against upstream source rather than trusting matching implementation/test expectations.
- Combined metadata/transport/account files before the final six boundary tests: 64 pass, 1 existing skip, 0 fail, 430 assertions.
- Current `tests/responses/ws-upstream.test.ts`: 49 pass, 1 existing skip, 0 fail, 188 assertions. Includes actual HTTP adapter dispatch, metadata caps, family isolation, no-signal deadline and outer retry no-resend behavior.
- Adjacent WS endpoint/passthrough abort/core-Lab boundary files: 67 pass, 0 fail, 243 assertions.
- Direct installed-Bun typecheck passed. Privacy scan passed. Staged secret scan examined approximately 41.6 KB with no leaks; the earlier empty-commit-range scan examined zero bytes and is not evidence for this patch.
- Docs build via installed `astro/bin/astro.mjs`: 425 pages, exit 0; existing chunk-size and missing 404-content warnings remain.
- Local wire QA `.tmp/qa-protocol.ts`: actual ephemeral HTTP listener exercised success (200 with quota/etag headers and Lite on the upstream frame), metadata overflow (single 200 stream failure without resend), and malformed JSON (400 with no socket). Two fake upstream sockets closed; ephemeral listener stopped and isolated home removed. No paid provider call or live proxy change.

This is not a final C/CI/merge claim. Independent implementation review and exact-head full verification remain pending. The source and regression delta is larger than a five-line patch because it crosses HTTP header commitment and account observation; connection reuse remains excluded and separately reviewable.

## Review-driven observation redesign

The first implementation audit rejected metadata-only stale-quota replay, inherited window reset fields, and stale hints on malformed WS fallback. Targeted mutation tests reproduced all three, and the atomic-window/hint corrections remain.

A receive-time-stamp repair introduced a second partial-window merge problem. Following the repeated-repair rule, the cycle returned through failed Check to Plan. Independent revised-plan review approved moving the quota observer before dispatch. The final design attaches immutable selected-account callbacks at all six relevant fetch constructions, updates the existing quota writer immediately on fresh ordinary-window fields, and skips stale post-fetch prelude application only for an explicitly observed WS response. `src/codex/quota.ts` is unchanged and the uncommitted stamp helper was removed. There is no late observer or secondary freshness system.

Revised targeted checks: 13 pass / 0 fail across immediate primary+secondary/secondary-only updates, credits-only interleaving, metadata-only events, pool/main-pool isolation, final HTTP hints, byte/family/header bounds and pre-dispatch observation. Direct typecheck passes. This supersedes earlier references in this record to the late-attachment observer.

Independent narrow implementation re-review accepted this redesign with zero remaining findings (VERDICT: PASS). All six dispatch sites and marker/fallback behavior were checked. Final combined focused check: 93 pass, 1 existing skip, 0 fail, 514 assertions across transport, account attribution, metadata integrity and core/Lab boundary. No production quota writer changes remain. Final Check and exact-head CI are still required.

Fresh C adversarial review found two Medium edge cases: mixed-case configured Lite headers combined with a caller override, and tertiary/label-only families escaping the family cap. Both were reproduced red, then corrected narrowly: genuine Lite forwarding removes prior case-insensitive spellings; family counting includes every supported family-bearing header. The same two tests then passed, and direct typecheck passed. Follow-up review is required against the committed interdiff.
