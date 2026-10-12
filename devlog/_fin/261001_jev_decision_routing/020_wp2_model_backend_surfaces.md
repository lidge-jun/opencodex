# 020 wp2: model backend, validation, CLI and management surfaces

## NEW `src/combos/jev-model-backend.ts` (pure, no server imports)

```ts
export type JevModelInvoke = (request: { model: string; instructions: string; input: string; signal: AbortSignal })
  => Promise<{ text: string; usage?: Record<string, number> }>;
export const JEV_MODEL_INSTRUCTIONS: string; // fixed system text: pick exactly one key, reply {"choice":"<key>"} only
export function buildJevModelPrompt(state: Record<string, unknown>, candidates: readonly JevCandidate[]): string;
export function parseJevModelChoice(text: string, allowed: ReadonlySet<string>): string; // throws on anything else
export async function resolveJevModelDecision(options: ResolveJevDecisionOptions & { decisionModel: string; invokeModel: JevModelInvoke }): Promise<JevDecision>;
```

- Prompt = JSON text `{ state, options: { "<target>:<effort>": "<criterion description>" , ... } }` reusing `buildJevState` and the same option keys as System One (`candidateOptions`). Max 64 options, request ≤ 64 KiB (UTF-8, prompt + instructions) else `invalid`. Fewer than 1 option → `no_choices`.
- Parser: trim; strip one surrounding ```json fence; `JSON.parse`; require object with string `choice` in allowlist; also accept a bare quoted string key. Text > 4 KiB → `malformed`. Unknown key → `invalid`. Non-JSON → `malformed`.
- Errors map: invoke throws `JevModelInvokeError{gate:"http"|"network"|"malformed"|"missing_key"}` → that gate; deadline → `timeout`; caller abort rethrown by identity. `backend: "model"`. Usage keys normalized like System One (`inputTokens/outputTokens`).

## NEW `src/server/responses/jev-model-invoke.ts`

`createJevModelInvoker({ req, config, options, handleResponses }): JevModelInvoke`:
- Body `{ model, stream: true, store: false, instructions, input: [{role:"user",content:[{type:"input_text",text}]}], tools: [] }`.
- Headers: `content-type` plus `authorization` only when the parent carried it (credential ownership stays with core-auth). No session/thread/turn headers.
- Options: `{ abortSignal: signal, admission: options.admission, codexAuthPolicy: options.codexAuthPolicy, sendBudget: createInferenceSendBudget(req, childLog), turnAdmissionLease: lease, internalDecisionCall: true }`; lease from `tryAdmitTurn()`, missing lease → throw gate `network` (fail-open); released in `finally`.
- `childLog = { model, provider: "unknown", inboundProtocol: "responses" }`; settle its spend tracker in `finally` with measured usage.
- Read: non-2xx → `http` (cancel body); `readBoundedResponseBytes(64 KiB)` oversize → `malformed`; SSE via `createSseInspector` completed object, JSON via fatal decode; status must be `completed`; extract `output[].content[].type==="output_text"` text.

## MODIFY `src/server/responses/core-options.ts`, `request-prepare.ts`

- `HandleResponsesOptions.internalDecisionCall?: boolean`.
- In request preparation: when set, skip shadow interception and refuse a route that resolves to a combo (return 400 `invalid_request_error`), so a decision call can never recurse.

## MODIFY `src/server/responses/core-combo.ts`

- Pass `decisionModel` and `invokeModel: createJevModelInvoker({ req, config, options, handleResponses: requestDispatchers.handleResponses })` into `resolveJevDecision`.

## Validation

- `src/types/config.ts` `OcxComboConfig.decisionModel?: string | null`; `src/combos/types.ts` `NormalizedComboConfig.decisionModel?`, normalize trims.
- `comboConfigIssues` gains `options.combos?` (prospective map). Rules: non-empty ≤ 512 chars; only with strategy `jev`; not together with a non-null `decisionProvider`; strip synthetic selector (`parseSyntheticRowId`) then `resolveComboId` — reject when it is this combo (by id or any of its aliases in the prospective entry) or any combo whose strategy is `jev`.
- Config schema (`config-schema.ts` ~720) passes the full combos map. Management PUT/POST passes `nextCombos` and revalidates every other combo's `decisionModel` when a combo changes strategy/alias.
- Save-time: `decisionModelRouteError(config, comboId, model)` in `src/server/management/decision-model-validation.ts` uses `previewRouteModel`; refuses unroutable models and `jev-decision` adapter rows.
- `combo-routes.ts` omission preservation for `decisionModel`; selecting one selector with explicit null clears the other.
- `provider-id-rewrite.ts` rewrites the provider prefix of `decisionModel`; `comboDependsOnProvider` counts it (DELETE guard).

## CLI `src/cli/combo.ts`

- `--decision-model <route|->`; reject with `--decision-provider` non-`-`; setting one sends `null` for the other. Carry the partial-update fixes (`2740904285`, `af1b035e7a`): `set` without `--targets` GETs and merges the existing row, filtering null listing fields; drop JEV fields when strategy changes away from `jev`.

## Management

- NEW route `POST /api/combos/decision-test` in `combo-routes.ts` (registered in route-registry with read-only mutation metadata): body `{ decisionProvider?, decisionModel?, decisionTimeoutMs? }`; validates like save; runs `resolveJevDecision` with two synthetic candidates (`probe/a:low`, `probe/a:high`) and a fixed probe task; returns `{ ok, backend, gate, latencyMs }`. Model backend uses `createJevModelInvoker` with a synthetic local Request.
- NEW route `GET /api/combos/decision-discovery?q=`: `{ configured: [{ id, url, model, usable, issue? }], discovered: [{ provider, model, endpoint }] }` from config rows and the model catalog via the #6185 helpers. No probe, no adoption.

## Tests

- NEW `tests/routing/jev-model-backend.test.ts`: prompt shape and bounds; parser (fenced, bare, unknown, oversize, non-JSON); fail-open gates; timeout; caller abort rethrow; backend tag.
- NEW `tests/server/server-jev-model-decision-e2e.test.ts`: loopback Bun.serve upstream for an ordinary provider; jev combo with `decisionModel` → decision request reaches that provider without parent tools/history and the chosen target serves the turn; decision provider returning garbage → fail-open to first target; separate send budget (parent target still sends).
- MODIFY combo validation tests: self id, self alias in same PUT, other jev combo alias, non-jev combo allowed, both selectors rejected, strategy change of referenced combo rejected.
- CLI test: `--decision-model`, conflict, partial update keeps targets.
- decision-test route test for both backends (mocked post / invoker).

## Accept

Focused files above + existing JEV suites + `tests/lab/core-lab-boundary.test.ts` + `bun run typecheck`.


## Reflection amendments (architect MISALIGNED → folded)

- R1 recursion: the runtime guard refuses only self/JEV combos (non-JEV combos are legitimate decision models). With `internalDecisionCall`, request preparation skips shadow interception at both sites and memory-model rewriting, and refuses a resolved JEV combo before the `handleComboResponses` dispatch; the flag rides into combo children through options.
- R2 auth: forward `authorization` together with `chatgpt-account-id` when the parent carried them; never session/thread/turn headers.
- R3 helpers: `jevDecisionBackendFor(combo: { decisionProvider?: string; decisionModel?: string }): JevDecisionBackend` exported from `src/combos/jev.ts`. `class JevModelInvokeError extends Error { gate: "http" | "network" | "malformed" | "missing_key" }` exported from `src/combos/jev-model-backend.ts`. Validation stays import-free: `comboConfigIssues` options gain `normalizeDecisionModel?: (model: string) => string`; management and config schema inject a wrapper over `parseSyntheticRowId(id, config)`; default is identity.
- R4 prompt: `src/combos/jev.ts` exports `jevRouteOptions(candidates): Array<{ key; targetKey; effort; description }>` (wraps `candidateOptions` + `criterionDescription`); both backends use it. Bounds: ≤ 64 candidates (existing) and ≤ 64 expanded options for the model backend.
- R5 bounds: the invoker checks the complete serialized Responses body ≤ 64 KiB, passes the deadline-combined signal to `readBoundedResponseBytes`, cancels non-2xx bodies, rejects `error`/non-completed, extracts only `message` → `output_text`. Tests cover lease release and spend settlement.
- R6 field chains: decisionModel — CLI/add dialog → PUT → `comboConfigIssues`/normalize (sparse) → config write/reload → GET `/api/combos` → GUI `parseComboList` → `executeComboResponses`. backend — `resolveJevDecision` → `logCtx.jevDecision` → request-log persist (`normalizePersistedJevDecision` in request-log and usage/log) → hydration → accumulator add/clone → `/api/usage?jev=1` → GUI `JevStatsResponse` type and panel. A round-trip test exists for each chain; `jevAutoDraft` keeps no decisionModel.


## Audit amendments (A round 1 FAIL → folded)

- B1 credentials (supersedes R2). The decision request carries **no** caller credential: no `authorization`, `chatgpt-account-id`, `x-api-key` or proxy admission header is copied, and the invoker passes `callerDirectAuth: null`, `openAiSidecarAuth: null`, `nativeCallerAuth: null` explicitly so `handleResponses` captures nothing. Only the parent's typed `admission` (scope enforcement) rides along. The decision model therefore runs on credentials configured on provider rows, as the design requires ("reuse existing provider credentials; no new credentials"). A route that would need the caller's own bearer (keyless Cursor, caller-owned ChatGPT forward) fails and the decision fails open; docs say so. `request-prepare`/`core-auth` treat `internalDecisionCall` as a credential-domain boundary (no caller-credential restoration). Negative tests: parent opaque bearer, proxy admission secret, and ChatGPT bearer+account id are absent from the upstream request of a decision model routed to a custom loopback provider; a keyless caller-auth provider yields fail-open with no send of the parent bearer.
- B2 byte proof. Before any refactor in wp1, generate `tests/fixtures/jev-typesafe-request-golden.json` from the current implementation (fixed body, candidates incl. operator note, deterministic) and add `tests/routing/jev-typesafe-golden.test.ts` comparing the exact serialized request string. Commit it first; it must stay green across wp1/wp2.
- B3 prospective config. Selector normalization and route preview run against `{ ...config, combos: nextCombos }` in management and against the loaded map in config schema. Tests: same-PUT alias then `<alias>` and synthetic `<alias>--fast` selector referencing self → rejected; changing a referenced combo to `strategy: "jev"` → rejected with the referencing combo named.
- B4 landing gates. wp4 runs full `bun run test` (resource exception only if documented with focused coverage), both layout guards, file-size ratchet, `tests/lab/core-lab-boundary.test.ts`, and a dispatched **security review** of the final diff (credential forwarding, outbound policy, env keys) recorded in the PR. Every new root-suite test is registered in `scripts/test-layout/layout.json` and `tests/fixtures/test-layout-expected.json`.
- Notes folded: docs describe cleartext opt-in as loopback **and literal private LAN addresses**; send budget created from the original parent `req` (no thread header forwarded upstream); `POST /api/combos/decision-test` registered as mutating; runtime recursion refusal and fail-open tested independently of save-time validation.
