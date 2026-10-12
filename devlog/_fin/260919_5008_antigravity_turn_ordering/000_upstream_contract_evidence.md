# #5008 — what the upstream actually validates

Evidence gathered for the intermittent first-send 400 on `google-antigravity/gemini-3.8-flash`:
"Please ensure that function call turn comes immediately after a user turn or after a function
response turn." Sources are public and primary where one exists. Nothing here is a fix, and one
finding contradicts an assumption the investigation started from.

## Where the error comes from

It is a Google service-layer `400 INVALID_ARGUMENT`, not a client-library check. The public Go,
Python and Node clients carry the content types and serializers but not this string or its
validator.

- Direct Gemini API, same string:
  <https://discuss.ai.google.dev/t/about-the-gemini-api-400-please-ensure-that-function-call-turns-come-immediately-after-a-user-turn-or-after-a-function-response-turn-error/46213>
- Vertex/gRPC, `io.grpc.StatusRuntimeException: INVALID_ARGUMENT` then the same string:
  <https://stackoverflow.com/questions/78574345/invalid-argument-using-langchain4j-tools-with-gemini-model>
- The converse validator captured from `generativelanguage.googleapis.com/...:generateContent`:
  "Please ensure that function response turn comes immediately after a function call turn."
  <https://github.com/google-gemini/deprecated-generative-ai-js/issues/267>
- The exact string captured from `daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent`:
  <https://github.com/router-for-me/CLIProxyAPI/issues/4959>

For ordinary `generateContent` the validated object is the submitted `contents[]`, which Google
describes as holding "the conversation history and the latest request"
(<https://ai.google.dev/api/generate-content>).

## The ordering the upstream considers valid

The canonical loop is `user` then `model` carrying `functionCall` then `user` carrying every
matching `functionResponse`.

- A `user` turn carrying `functionResponse` parts counts as a function-response turn; current
  Google examples use `role: "user"` for it, where older ones used `role: "function"`. That churn
  explains contradictory cookbook examples.
  <https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/tools/function-calling>
- Parallel calls need exactly one response each, together in the immediately following turn:
  "Return exactly one `FunctionResponse` for each `FunctionCall` received."
  <https://ai.google.dev/gemini-api/docs/whats-new-gemini-3.5>
- Calls and responses must not interleave. Google documents `FC1 + signature, FC2, FR1, FR2` as
  valid and `FC1, FR1, FC2, FR2` as a 400.
  <https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures>
- **A model text-only turn immediately followed by a separate model `functionCall` turn is
  invalid**: the call turn then follows a model turn, which is exactly what the error rejects.
  Same-role adjacency is not forbidden by the protobuf schema, which only constrains role values,
  but it is unsafe around function calling.

## The finding that contradicts the starting assumption

The issue was narrowed on the grounds that the reporter's A-F matrix all returned 200, so the
translator's adjacency handling was unlikely to be at fault. Case A is exactly the shape above —
`model(text)` then `model(functionCall)` — and the upstream contract says that shape is invalid.
A near-identical report exists against another Antigravity proxy: Gemini 3.6/3.7 Flash failed
after several tool rounds because a converted reasoning carrier became a model turn immediately
before another model `functionCall`, while clean tool ordering and plain chat worked
(<https://github.com/router-for-me/CLIProxyAPI/issues/4959>).

`messagesToGeminiFormat` can emit that pair today: it pushes one `model` turn per assistant
message, so a text-only assistant message followed by an assistant message carrying tool calls
serializes as two adjacent model turns. That is a sourced structural candidate, and it is the
first one this investigation has. It is not proof: a 200 on the reporter's isolated case A is a
real observation too, and the two together suggest the rule is enforced conditionally rather than
uniformly. Nothing here establishes which condition.

Related long-session corruption mechanisms, all of them client-side rather than server-state:

- orphaned `functionResponse` after a model turn carrying a call plus empty text was dropped:
  <https://github.com/google-gemini/gemini-cli/issues/26956>
- a projected request that began with model tool turns after MCP calls and large masked outputs:
  <https://github.com/google-gemini/gemini-cli/issues/26472>
- checkpoint/resume during pending tool execution producing incomplete call/response batches:
  <https://github.com/google-gemini/gemini-cli/issues/4403>

Gemini 3.5 Flash has separate intermittent function-call failures with large arguments, but those
surface as `MAX_TOKENS` or `MALFORMED_FUNCTION_CALL`, not this ordering error
(<https://github.com/googleapis/js-genai/issues/1619>).

## The session-state hypothesis is unproven

Cloud Code Assist demonstrably receives both the full history and a session identifier: Gemini
CLI sends `contents: toContents(req.contents)` alongside `session_id: sessionId` and comments
"Use sessionId as trajectoryId"
(<https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/converter.ts>,
<https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/server.ts>).
A captured Antigravity request carries `contents`, `sessionId` and `requestType: "agent"` together
(<https://github.com/router-for-me/CLIProxyAPI/issues/1675>).

What no public source establishes is that `sessionId` indexes an authoritative server-side
conversation ledger, or that Cloud Code Assist validates `contents[]` against one. Google
documents the opposite default for stateless operation — "you must pass the full history of the
conversation" — and exposes server-side continuation separately through the Interactions API's
`previous_interaction_id` (<https://ai.google.dev/gemini-api/docs/function-calling>).
"trajectoryId" is equally compatible with telemetry, agent association or routing.

## Verdict

Public evidence explains the error as validation of the serialized tool-call history, and it
supplies several long-session corruption mechanisms on the client side. It does not explain an
intermittent first-send 400 when the exact final Cloud Code Assist payload is independently
valid. Server/client state divergence remains a hypothesis. The issue should stay open.

## What was built on this evidence

`src/adapters/google-wire-shape.ts` (PR #5079) projects the structure of the compiled request
without its contents, so the next occurrence can be described from the request that actually
failed. Its `call-turn-after-model-turn` class is the shape named above; the projection reports
it and does not act on it. No translator change was made.
