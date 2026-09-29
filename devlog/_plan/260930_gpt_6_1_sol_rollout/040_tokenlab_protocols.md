# 040 TokenLab per-model protocols and JEV backend (wp3)

## Wires

Keep the preset's provider-wide adapter `openai-chat` (the released, verified path). Add registry defaults so each model rides its declared native wire:

- `modelWireDefaults` -> `{ wire: "openai-responses", inbound: ["responses"] }` for gpt-6-astra, gpt-6-sol, gpt-6-luna, gpt-6.1-sol, grok-4.7, deepseek-v4.1-flash, deepseek-v4-pro, kimi-k3, glm-5.3. Scoped to Responses inbound (Codex) like the Alibaba Token Plan precedent (tests/providers/alibaba-token-plan-wire-defaults.test.ts): a Chat or Anthropic client keeps the verified Chat wire with no translation hop. User-overridable: an explicit `modelAdapters` entry of `openai-chat` wins.
- Claude ids -> Anthropic Messages through the existing endpoint-bound prefix pin (`WIRE_ADAPTER_PIN_PREFIXES` in src/types/wire.ts, the Command Code mechanism): `tokenlab: { endpoint: "https://api.tokenlab.sh/v1", prefixes: { "claude-": "anthropic" } }`. The anthropic adapter already normalizes `/v1` to `/v1/messages`. The pin is bound to the canonical endpoint, so a retargeted TokenLab row is untouched. Every live `claude-*` TokenLab id is checked to declare anthropic_messages before the prefix is used.
- Everything else, including gemini-3.8-flash, stays on Chat. Gemini native is deferred until tested, as Vincent proposed.
- No delivery-policy header is added: the user's API-key default stays authoritative.

Rejected: a provider-wide switch to Responses (sends Claude/Gemini to an endpoint they do not accept); separate provider entries (duplicates models by default); widening `MODEL_ADAPTER_OVERRIDE_ALLOWED` to anthropic (needs the #404 credential threat model; the prefix pin already exists and is endpoint-bound).

Tests: resolveWireProtocolOverride / resolved policy for each class on the canonical endpoint, user modelAdapters override back to Chat for a Responses default, retargeted base URL keeps Chat, anthropic URL resolves to https://api.tokenlab.sh/v1/messages.

## JEV decision backend — deferred to its own unit

Decision after audit A1 (blockers 1-3): not in this release. A per-combo backend has to travel through `src/server/responses/core-combo.ts:536` (the call passes no combo settings), combo normalization and persistence (`src/combos/types.ts:379`, `src/server/management/combo-routes.ts:231`), and the GUI combo editor round trip (`gui/src/combo-workspace-data.ts:266`, `:460`), and credential, fixed URL and canonical outbound guard (`src/combos/jev.ts:568`, `:599`) must switch together. It also sends conversation-derived decision state to a new third party, which deserves its own review and a GUI screenshot. That does not meet this unit's "fits cleanly" bar.

Follow-up unit sketch: combo fields `jevBackend: "typesafe" | "tokenlab"` (default typesafe) and `jevModel` (`jev-*`), fixed endpoint per backend (`https://api.typesafe.ai/v1/systemone`, `https://api.tokenlab.sh/v1/systemone`, body `{model, state, questions}` confirmed identical in docs.tokenlab.sh/api-reference/systemone/create-decision), credentials never shared between backends, allowlist/timeout/cancellation/fail-open unchanged.
