# 010 — wp1: carry #6123 `hideRawReasoning` (issue #6122)

## Problem

`src/bridge/sse.ts:977` (`reasoning_raw_delta`) emits `response.reasoning_text.delta` and a
`reasoning_text` content part for routed providers; `src/bridge/response-json.ts:283` builds the
same visible shape for buffered responses. Existing switches cannot hide only that channel:
`hideThinkingSummary` and wire `reasoning.summary: "none"` also hide provider-authored summaries.

## Decisions (architect proposal → main disposition)

- D1 provider-level boolean `hideRawReasoning`, recomputed per final route in
  `src/server/responses/core-normalize.ts` — accepted (fallback without the option shows raw again).
- D2 every client-facing encoder honours it: SSE bridge, JSON bridge, direct adapter-event encoder
  (Chat/Messages), plus the image and web-search bridge callers — accepted; dropping a path would
  make the same option behave differently per client wire.
- D3 replay unchanged: Responses bridge keeps the text in the txt-only `ocxr1` envelope and
  `rememberReasoningForCall`; direct Chat/Messages rely on the terminal fold's
  `buildResponseJSON` filling the server replay cache — accepted.
- D4 `src/server/auth-cors.ts` `PROVIDER_CONFIG_FIELD_POLICY` entry at `editor` — accepted and
  required: the map `satisfies Record<keyof OcxProviderConfig, …>`, so omitting it fails typecheck.
  The `unsponsored_surface` failure on #6123 does not apply to a PR authored with push permission
  (`.github/scripts/pr-sponsored-surface.cjs:74`); flagged for coordinator review anyway.
- D5 wording correction — amended: #6123 says the suppressed text "never reaches the client", yet
  `ocxr1` (`src/responses/reasoning-envelope.ts:43`) is base64 JSON carrying `txt` and is sent to
  Responses clients as `encrypted_content`. The option controls display, not confidentiality.
- D6 narrowing — rejected for source (all 13 source files are one wiring chain), accepted for
  claims: docs state the display contract and the envelope caveat precisely.
- D7 (audit A1) provider save keeps the option — added. The dashboard form never sends it
  (`gui/src` has no reference), and `carryProviderCompatFields`
  (`src/server/management/provider-overwrite-carry.ts:22,88`) carries only five fields, so an
  unrelated save would silently turn the protection off. `hideRawReasoning` is an operator display
  policy, not a fact about one upstream, so it is carried on EVERY overwrite of the same provider
  name, including a destination move (a new `PROVIDER_DISPLAY_CARRY_FIELDS` list handled before the
  destination check). A value in the request always wins.
- D8 (audit A2) PATCH sets/clears it — added to `applyProviderCompatPatchFields`
  (`provider-overwrite-carry.ts:128`): boolean sets, `null` deletes, anything else is a 400.
- D9 (audit A3) validated as a boolean — added: POST check in `providerCompatFieldConfigError`
  (`provider-overwrite-carry.ts:108`) and `hideRawReasoning: z.boolean().optional()` in the provider
  schema (`src/config/schema/leaf-validators.ts`, before `.passthrough()` at :394), following the
  strict `responsesSnapshotRepair` precedent so a string `"true"` fails loudly instead of silently
  leaving raw reasoning visible.

## File change map

Cherry-pick, preserving authorship (Robin Bially):
`f96c9818aa`, `a466928729`, `bc5208a92b`, `61f8400b58`. Resulting paths:

- MODIFY `src/types/provider.ts`, `src/types/request.ts` — field + request option.
- MODIFY `src/server/responses/core-normalize.ts` — `parsed.options.hideRawReasoning = route.provider.hideRawReasoning === true`.
- MODIFY `src/bridge/sse.ts`, `src/bridge/response-json.ts`, `src/protocols/encoders/adapter-events.ts` —
  `hideThinkingSummary || hideRawReasoning` guards only the `reasoning_raw_delta` branch.
- MODIFY `src/server/responses/adapter-delivery.ts`, `src/server/responses/run-turn-execution.ts`,
  `src/server/inference/client-encoder-delivery.ts`, `src/images/loop.ts`, `src/web-search/loop.ts` — pass-through.
- MODIFY `src/providers/model-rename-fields.ts` (`none`), `src/server/auth-cors.ts` (`editor`).
- MODIFY `tests/adapters/bridge-raw-reasoning-hidden.test.ts`; NEW `tests/responses/responses-hide-raw-reasoning.test.ts`;
  MODIFY `tests/responses/protocol-direct-encoders-{chat,messages}.test.ts`,
  `tests/responses/responses-reasoning-summary-passthrough.test.ts`,
  `tests/server/inference-client-encoder-delivery.test.ts`; registry entries in
  `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.
- MODIFY docs: `docs-site/src/content/docs/reference/configuration/providers.md`,
  `structure/transports/responses-wire-shapes.md`, `structure/providers/chat-compat.md`,
  `structure/dashboard-and-usage.md`.

Audit fold (lane commit 2):

- MODIFY `src/server/management/provider-overwrite-carry.ts` — `PROVIDER_DISPLAY_CARRY_FIELDS =
  ["hideRawReasoning"]`; `ProviderOverwriteSample.submitted` samples both lists;
  `carryProviderCompatFields` copies an omitted display field from the live row before the
  destination check; POST type check; PATCH branch.
- MODIFY `src/config/schema/leaf-validators.ts` — boolean schema entry.
- NEW `tests/server/management-provider-hide-raw-reasoning.test.ts` (+ both test-layout registry
  entries): same-destination save keeps `true`; destination-move save keeps `true`; request value
  `false` wins; POST with `"true"` is 400; PATCH `true` then `null` round-trips through disk; PATCH
  `"yes"` is 400; provider schema rejects a string value.
- MODIFY docs-site "What a provider save keeps" (providers.md:325-337) and the option row to name
  the display carry and PATCH behaviour; MODIFY `structure/dashboard-and-usage.md` sentence.
- Owning structure doc for `provider-overwrite-carry.ts` found via `structure/INDEX.md` and updated.

Lane commit (Co-authored-by Robin Bially):

- docs-site providers row: replace "The suppressed text never reaches the client: …" with: the
  raw text is not streamed as displayable reasoning; a Responses bridge route still carries it in
  the client-echoed txt-only `ocxr1` replay envelope (base64 JSON, not encrypted), so this is a
  display control and not a confidentiality boundary; direct Chat/Messages clients get no copy
  and replay comes from the server-side cache.
- NEW test case in `tests/responses/responses-hide-raw-reasoning.test.ts`: one parsed request is
  normalized on a provider with the option (true), then the SAME request is normalized on a
  provider without it and reads false (fallback reset on a reused request object).
- `structure/transports/responses-wire-shapes.md`: same correction for "reaches no client wire".
- `structure/providers/chat-compat.md`: scope "round-trips in a txt-only envelope" to Responses
  bridge routes and name the server cache for direct encoders.
- `src/types/provider.ts` JSDoc: add the display-not-confidentiality sentence.

## Acceptance (activation → observable effect)

1. Routed openai-chat stream with `hideRawReasoning: true`: no `response.reasoning_text.delta`, no
   `reasoning_text` content part; reasoning item carries `encrypted_content` whose decoded `txt`
   equals the raw text (`tests/responses/responses-hide-raw-reasoning.test.ts`).
2. `thinking_delta` summaries still stream as `response.reasoning_summary_text.delta`
   (`tests/adapters/bridge-raw-reasoning-hidden.test.ts`).
3. Fallback route without the option shows raw reasoning again: the same parsed request object
   flips from true to false when renormalized on a provider without the option.
4. Direct Chat delivery: raw text absent from the Chat wire, present in
   `peekReasoningForCall` for the next tool call (`tests/server/inference-client-encoder-delivery.test.ts`);
   direct Messages wire carries no raw thinking text (`protocol-direct-encoders-messages.test.ts`).
5. Native passthrough relays reasoning frames unchanged (`responses-reasoning-summary-passthrough`).
5a. Management: an unrelated dashboard-style POST (field omitted) on the same or a new destination
    leaves `hideRawReasoning: true` on disk; PATCH sets and clears it; non-boolean POST/PATCH and a
    string in config are rejected (`tests/server/management-provider-hide-raw-reasoning.test.ts`).
6. Gates: typecheck, focused files, `test:changed`, `structure:check`, `privacy:scan`, full
   `bun run test` before review readiness (or a recorded resource exception with the coverage
   left to CI), Ubuntu PR CI.

Out of scope: the default display, GUI editor controls, server-only replay.
