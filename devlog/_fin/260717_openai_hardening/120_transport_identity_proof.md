# Cycle 120 — HTTP/SSE/WebSocket Transport Identity Proof

## Objective

Verify that all three Pro virtual aliases produce the correct wire identity (base
model in upstream request and client response) and log identity (virtual model in
request log and usage JSONL) across HTTP JSON, HTTP SSE, and real WebSocket transports.

## Scope

- `applyOpenAiVirtualModel` called after routeModel and namespace stripping in `handleResponses`
- Upstream body: base model + `reasoning.mode: "pro"` + preserved effort
- Client response: upstream base model unchanged (Windows native relay safety)
- Request log: `model` = virtual id, `requestedModel` = namespaced, `resolvedModel` = base
- Usage JSONL: same three identities persisted
- No Codex account headers on API tier requests
- Parser-rejected scalar/array reasoning never reaches apply (400 before virtual rewrite)

## Activation tests

- `tests/openai-api-virtual-models.test.ts` "OpenAI API Pro transport identities"
  - HTTP JSON: all 3 Pro ids, base wire model in response, virtual in logs
  - HTTP SSE: streaming response contains base model, not virtual
  - Real WebSocket: `response.create` with Pro id, base in terminal event
  - Captured upstream headers: API key present, no chatgpt-account-id or x-codex-account-id
  - `/api/logs` entries: provider, model, requestedModel, resolvedModel all correct
  - Invalid reasoning (string, array) returns 400 without upstream fetch

## Evidence

- Consolidated implementation and activation evidence is indexed in
  [`190_consolidated_finish_plan.md`](./190_consolidated_finish_plan.md), with the final
  Cycle-B integration and gate receipts in [`050_integration_verification.md`](./050_integration_verification.md).

## Status

`done — verified by consolidated Cycle A/B sweep, see 190 + 050 evidence`
