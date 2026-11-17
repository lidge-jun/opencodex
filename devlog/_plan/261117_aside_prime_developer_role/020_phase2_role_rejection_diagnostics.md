# 020 Phase 2: developer-role rejection diagnostics (C3)

Depends on: 010. Criteria: C3. Invariant: `structure/data-planes/error-detail.md` (no upstream text in rows or client bodies).

## Files

| Path | Change |
|---|---|
| `src/lib/developer-role-rejection.ts` | NEW |
| `src/lib/client-error-body.ts` | MODIFY (`actionableRefusalMessage`, new exported sentence) |
| `src/server/request-log-failure-detail.ts` | MODIFY (`recordUpstreamValidationDetail`) |
| `tests/lib/developer-role-rejection.test.ts` | NEW (verdict, client sentence on Chat and Messages payloads, log detail) |
| `tests/server/developer-role-rejection-boundary.test.ts` | NEW (native Chat end to end: client body, live row, usage.jsonl, no upstream text) |
| `structure/data-planes/error-detail.md` | MODIFY (schema-validation paragraph ~:55-66, actionable map ~:292) |
| `scripts/test-layout/layout.json` explicit (`"developer-role-rejection.test.ts": "lib"`, `"developer-role-rejection-boundary.test.ts": "server"`) and `tests/fixtures/test-layout-expected.json` | MODIFY (neither name is seed-placed: lib regex `seeds.json:110-114`, server regex `:40-46`) |

## Diffs

NEW `src/lib/developer-role-rejection.ts`:

```ts
/**
 * Whether an upstream 4xx says the provider rejects the `developer` message role (#8864).
 *
 * Read only through fixed lowercase phrases that name the role itself; nothing from the message is
 * returned or stored. Each phrase is a provider's own wording: DashScope compatible-mode (#5664),
 * Moonshot (#7583) and serde-based gateways. Any other 400 stays a plain request rejection.
 */
const MAX_SCAN = 4096;
const PHRASES = ["developer is not one of", "role 'developer' is not allowed", "unknown variant `developer`"] as const;

export function isDeveloperRoleRejection(status: number | undefined, message: unknown): boolean {
  if (typeof status !== "number" || status < 400 || status >= 500 || typeof message !== "string") return false;
  const scanned = message.slice(0, MAX_SCAN).toLowerCase();
  return PHRASES.some(phrase => scanned.includes(phrase));
}
```

`src/lib/client-error-body.ts`:

```ts
export const DEVELOPER_ROLE_REFUSAL_MESSAGE = "The provider does not accept the developer message role. Send these instructions as a system message, or set foldDeveloperRoleToSystem: true on this provider; retrying this request unchanged will not succeed.";
```

In `actionableRefusalMessage`, after the structured-token return and before the carrier-code gate:

```diff
   if (structured !== undefined && ACTIONABLE_REFUSALS.has(structured)) return ACTIONABLE_REFUSALS.get(structured);
+  // A role rejection travels as a plain invalid request, so it is read before the carrier gate.
+  if (contract === undefined && (code === null || code === "invalid_request_error")
+    && isDeveloperRoleRejection(evidence.status, evidence.message)) return DEVELOPER_ROLE_REFUSAL_MESSAGE;
   if (code === null || !REFUSAL_CARRIER_CODES.has(code) || typeof evidence.message !== "string") return undefined;
```

Reachability (architect D5): native Chat `chat-native.ts:821`, translated Chat `chat-completions.ts:731`, Chat SSE `chat-native-sse.ts:320/:390`, native Messages via `messages-error-body.ts:84`. Responses inbound does not pass upstream text and translates `developer` itself (`developer-role.ts:36-38`); no change there.

`src/server/request-log-failure-detail.ts`: imports become

```ts
import { upstreamValidationIssues, type ValidationIssue } from "../lib/upstream-validation-detail";
import { isDeveloperRoleRejection } from "../lib/developer-role-rejection";
```

and the file gains

```ts
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** The closed pair a developer-role rejection records; the dashboard already renders it. */
const DEVELOPER_ROLE_VALIDATION: ValidationIssue[] = [{ field: "messages.role", type: "enum" }];
```

`recordUpstreamValidationDetail` takes an option that only provider-body callers set, so a body this proxy formatted (`src/server/responses/core-combo-failure.ts:103`) keeps validation-only capture:

```diff
-export function recordUpstreamValidationDetail(logCtx: { failureDetail?: FailureDetail }, status: number, payload: unknown): void {
+export function recordUpstreamValidationDetail(
+  logCtx: { failureDetail?: FailureDetail }, status: number, payload: unknown, options: { providerBody?: boolean } = {},
+): void {
   ...
-  const validation = upstreamValidationIssues(parsed);
-  if (!validation) return;
-  const record = parsed as Record<string, unknown>;
-  const nested = record.error !== null && typeof record.error === "object" && !Array.isArray(record.error)
-    ? record.error as Record<string, unknown> : undefined;
-  logCtx.failureDetail = boundedFailureDetail({ code: "provider_error", type: nested?.type ?? record.type, validation });
+  const record = isRecord(parsed) ? parsed : undefined;
+  const nested = record && isRecord(record.error) ? record.error : undefined;
+  const message = typeof nested?.message === "string" ? nested.message
+    : typeof record?.message === "string" ? record.message : typeof record?.error === "string" ? record.error : undefined;
+  // Read once to choose the closed pair; the message itself is dropped here.
+  const validation = upstreamValidationIssues(parsed)
+    ?? (options.providerBody && isDeveloperRoleRejection(status, message) ? DEVELOPER_ROLE_VALIDATION : undefined);
+  if (!validation) return;
+  logCtx.failureDetail = boundedFailureDetail({ code: "provider_error", type: nested?.type ?? record?.type, validation });
```

and `recordUpstreamProviderErrorDetail` calls `recordUpstreamValidationDetail(logCtx, status, payload, { providerBody: true })`. Its callers are native Chat (`chat-native.ts:766`), translated adapter dispatch (`src/server/responses/adapter-dispatch.ts:1892`, non-proxy responses only) and combo failure with `rawUpstream` (`src/server/responses/core-combo-failure.ts:102`). The pair is therefore recorded on those provider-body paths only; `src/server/chat-completions.ts` has no capture of its own, so the client sentence reaches it independently of the pair (audit r1 finding 2), matching the existing scope of the schema-validation paragraph (`error-detail.md:55-56`).

## Tests

`tests/lib/developer-role-rejection.test.ts`:
- verdict true for the three phrases at 400 and 422, case-insensitive; false at 500, at 200, for a non-string, for "role 'system' is not allowed", "Invalid value for temperature", "the developer of this model ...", and for a phrase beyond 4096 characters.
- `ownedChatErrorPayload({status:400,type:"invalid_request_error",code:"invalid_request_error",evidence:{status:400,message:DASHSCOPE}})` message equals `DEVELOPER_ROLE_REFUSAL_MESSAGE`; a non-matching 400 keeps `upstreamConditionMessage("request_rejected")`; a contract-bearing call and a `cyber_policy` code keep their own sentence; the message never contains "is not one of".
- `ownedAnthropicErrorPayload` with the same evidence returns the sentence.
- `recordUpstreamProviderErrorDetail(ctx, 400, DASHSCOPE_BODY)` sets `{code:"provider_error", type:"invalid_request_error", validation:[{field:"messages.role", type:"enum"}]}`; a non-matching 400 body sets `{code:"provider_error", type:"invalid_request_error"}` only; `recordUpstreamValidationDetail(ctx, 400, DASHSCOPE_BODY)` without `providerBody` records nothing; `JSON.stringify(ctx.failureDetail)` never contains upstream words.

`tests/server/developer-role-rejection-boundary.test.ts` (harness of `tests/server/upstream-error-detail-boundaries.test.ts`): local upstream answers 400 with the DashScope body; POST native `/v1/chat/completions` with a developer message to a custom `openai-chat` provider with no fold record. Assert client `error.message === DEVELOPER_ROLE_REFUSAL_MESSAGE`, live row and persisted usage row carry the validation pair, and neither the row JSON, `usage.jsonl` bytes nor console output contain "is not one of". A second case with a non-matching 400 asserts the generic sentence and no validation pair.

## Doc

`structure/data-planes/error-detail.md`: the schema-validation paragraph adds that, on the same native Chat and translated adapter dispatch provider bodies, a 4xx whose message names a developer-role rejection through the fixed phrases in `src/lib/developer-role-rejection.ts` records the closed pair `messages.role`/`enum`; the actionable-map sentence (:292) adds that the same verdict selects the fixed `DEVELOPER_ROLE_REFUSAL_MESSAGE` for a null or `invalid_request_error` code with no contract, copying no upstream text.

## Verification (wp2 C)

`bun test tests/lib/developer-role-rejection.test.ts tests/server/developer-role-rejection-boundary.test.ts tests/server/upstream-error-detail-boundaries.test.ts tests/usage/request-log-error-detail.test.ts tests/usage/provider-failure-detail.test.ts`, the Chat/Messages error suites touched by `test:changed`, `bun run typecheck`, `bun run structure:check`, `bun run privacy:scan`; the new tests are run once against the pre-change source (stash) to show they fail.


## wp2 cycle record

- Previous D (wp1): export and registry fix landed in 3b7dd0b2ee and e8f0314c33 (es docs required by `tests/ci-workflows/docs-spanish-localization.test.ts`); 448 focused tests pass. `test:changed` hit its 900s cap on a host at load ~23 and its failures were timeouts and cascades; left to PR CI and wp3. Direction: implement this doc.
- Stale check: wp1 touched none of the files this doc changes (`src/lib/client-error-body.ts`, `src/server/request-log-failure-detail.ts`, `structure/data-planes/error-detail.md`, `scripts/test-layout/layout.json`); `origin/dev` is still `c36793a933`.
- Architect consultation: D4-D6 in [002_architect.md](002_architect.md), with reflection gaps 1-3 folded; no new design decision.
- Test-first order: write both new tests and run them against the unchanged source (expect the verdict module import to fail and the boundary test to see the generic sentence), then implement.

