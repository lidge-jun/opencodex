# Native Reasoning Retention

## Configuration and management

`src/config/schema/native-reasoning-retention.ts` owns strict optional boolean `nativeReasoningRetention.modelSwitch` and `nativeReasoningRetention.accountSwitch` fields, both resolved off. Invalid disk blocks disable retention with a warning without discarding unrelated config; candidate writes reject invalid fields and unknown keys. Runtime scope and recovery precedence follow [native reasoning retention](#runtime-boundary).

`native-reasoning-retention-live-cli` owns the deferred dedicated live CLI verb for `PUT /api/native-reasoning-retention`. The dashboard and management API apply it live today; `ocx config set/unset nativeReasoningRetention` edits the same block on disk without live convergence, so restart after those local edits. The route registry records this follow-up rather than granting a mutating local-transport exemption.

`src/server/management/native-reasoning-retention-routes.ts` owns `GET/PUT /api/native-reasoning-retention`. GET returns resolved `modelSwitch` and `accountSwitch` booleans. PUT accepts a strict partial boolean object, preserving omitted fields, or JSON `null` to remove the block and restore defaults. Invalid writes and failures before publication leave live state unchanged; a failure after publication keeps the committed state authoritative. `gui/src/components/NativeReasoningRetentionPanel.tsx` exposes the two opt-ins on the dashboard overview; it requires a valid read before saving and fences stale server responses. Runtime scope and rejection precedence follow [native reasoning retention](#runtime-boundary).

## Runtime boundary

`src/types/request.ts` declares trusted parsed policy fields; `src/responses/reasoning-replay-cache.ts` reports known durable identity deltas without widening cache keys. `src/adapters/openai-responses/passthrough.ts` applies reasoning and compaction stripping independently.

Native Chat's retained plaintext `reasoning_content` replay cells require an authenticated caller
principal in addition to the conversation, route, credential, model, adapter, and tool call. Native
Chat and Responses resolve that principal from data-plane admission before capture or replay; a
bridge Combo carries the resolved principal, including its absence, through internal child options
after stripping provisional caller Authorization. The Chat Completions bridge, Claude Messages, and
the routed Responses compaction handoff likewise resolve it from the admitted original request and
hand it to `handleResponses` through its options, because the internal request they build may not
carry the caller's opencodex key. Client headers and bodies cannot assert this
identity. A keyless caller cannot retrieve another principal's plaintext reasoning. This rule describes
the plaintext replay cache only. Process-local opaque serving and rejection memos also separate
authenticated principals, with a distinct keyless namespace that preserves physical route-change
and rejection safeguards. Keyless callers share a principal namespace and thread slot, but serving
route changes still compare physical identity and rejection memos remain bound to the durable
physical identity. Google's durable signature bindings retain their own identity and validation rules.

`src/server/responses/request-prepare.ts` snapshots the resolved policy into trusted parsed state. `src/server/responses/core-replay.ts` applies it to the selected concrete route, including each fresh Combo candidate. Retention is eligible only on the canonical ChatGPT Responses forward destination, with an unchanged provider, adapter and durable endpoint. A known model change requires `modelSwitch`; a known credential change requires `accountSwitch`; simultaneous changes require both. It does not widen the serving identity used for reasoning caches or strict plaintext Combo eligibility. Unknown or expired serving provenance retains the existing destination-only behavior rather than inventing a compatibility match.

Account retention is experimental forwarding permission, not evidence that the backend accepts or reuses another caller's reasoning. `src/server/responses/account-change-state.ts` continues removing account-bound continuation references and foreign reasoning item ids; uploaded-file refusal stays independent. Opaque-blob rejection recovery and its rejection memo override retention. When retention actually kept ciphertext across a change, `src/server/responses/passthrough-dispatch.ts` also inspects the zero-output stream prelude, so a refusal ChatGPT sends inside a 200 stream (a Codex WebSocket `error` frame or `response.failed`) takes the same single sanitized rebuild as an HTTP 4xx refusal. Previously stripped ciphertext is never restored in a later recovery leg. Claude-native per-blob replay tags remain authoritative: retention never permits a blob whose durable endpoint or generation-bearing credential fails its tag check.

Only reasoning `encrypted_content` is covered. Native compaction cleanup has its own internal flag and preserves the existing identity-change behavior. Direct native `/v1/responses/compact` sanitization is unchanged. API-key providers, arbitrary forward aliases and translated destinations receive no new permission. The configuration and management surface is described above.

## Combo tool-loop continuation

A combo picks a target per request, but a tool loop spans several requests that form one assistant turn. Re-picking between them handed DeepSeek a GPT-issued `function_call` with no reasoning item, which its thinking mode refuses with HTTP 400 (#7298). Two layers make a mid-loop switch safe.

`src/server/responses/combo-tool-loop-pin.ts` pins a request whose `input` (or Chat `messages`) ends with a tool output to the target that completed the lane's previous turn, recalled from `src/server/responses/combo-session-recall.ts` under its existing TTL, ownership and lane rules. The pin applies only while that target passes every current filter: provider enabled, still a combo member, out of cooldown, metered consent and per-request eligibility. It uses a non-mutating pick preview, so rotation state is unchanged, skips the JEV decision, and records `combo-tool-loop-pin` as the selected route reason. A new user message is never pinned, and override routes (compaction, main hard-lock fallback) neither record nor read a lane target.

When the pinned target is unavailable or fails, normal selection and failover run, and each strict serializer accepts foreign history instead of refusing it. `sanitizeReasoningInputContent` in `src/adapters/openai-responses/reasoning.ts` gives every assistant tool-call turn with no reasoning item a `reasoning_text: " "` item at its head on destinations with `requiresPlaintextReasoningReplay`. That is the Responses twin of the Chat adapter's `reasoning_content: " "` placeholder (#5421): a fixed single space, never invented reasoning. Gemini on AI Studio receives the validator sentinel for an unsigned first call, as Antigravity and Vertex already did ([Google provider](../providers/google.md#google-tool-call-thought-signature-replay)). Anthropic receives the call as an ordinary `tool_use`/`tool_result` pair with no thinking block. The opaque-only eligibility rule in `core-replay.ts` is unchanged. Coverage: `tests/server/server-combo-tool-loop-continuation.test.ts`, `tests/providers/deepseek-bare-tool-call-replay.test.ts` and `tests/adapters/google/google-ai-studio-foreign-call-signature.test.ts`.


## Cold opaque-state rejection recovery

`src/server/responses/core-opaque-recovery.ts` selects bounded zero-output stream preflight from
opaque state in the actual outbound body, even without a process-local serving record after restart.
The flat SSE error projector preserves a caller-validated 400 rejection identity, including its
dedicated code or exact verification wording. A successful native replay remains untouched.
Only the existing explicit rejection identities can
trigger the existing one-shot sanitized rebuild; generic 502s do not. An identified reasoning-only
502 follows that contract too. The encrypted-function-output-specific message still requires actual
outbound encrypted function output. Existing transport retries retain their separate send accounting.
Text/tool commitment, ambiguous-resend ownership, non-replayable responses, configured send limits
and the one-shot guard still prohibit unsafe replay. The outbound rebuild preserves store:false and
paired tool calls/results; this path never edits the on-disk conversation. It does not decrypt native
ciphertext or add a new plaintext reconstruction rule. `tests/responses/responses-cold-opaque-recovery.test.ts`
and `tests/responses/responses-azure-opaque-blob-recovery.test.ts` cover cold recovery and the negatives.

> Decision record: [ADR-7369](../decisions/ADR-7369-cold-opaque-state-recovery.md)
