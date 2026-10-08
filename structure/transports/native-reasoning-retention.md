# Native Reasoning Retention

## Configuration and management

`src/config/schema/native-reasoning-retention.ts` owns strict optional boolean `nativeReasoningRetention.modelSwitch` and `nativeReasoningRetention.accountSwitch` fields, both resolved off. Invalid disk blocks disable retention with a warning without discarding unrelated config; candidate writes reject invalid fields and unknown keys. Runtime scope and recovery precedence follow [native reasoning retention](#runtime-boundary).

`native-reasoning-retention-live-cli` owns the deferred dedicated live CLI verb for `PUT /api/native-reasoning-retention`. The dashboard and management API apply it live today; `ocx config set/unset nativeReasoningRetention` edits the same block on disk without live convergence, so restart after those local edits. The route registry records this follow-up rather than granting a mutating local-transport exemption.

`src/server/management/native-reasoning-retention-routes.ts` owns `GET/PUT /api/native-reasoning-retention`. GET returns resolved `modelSwitch` and `accountSwitch` booleans. PUT accepts a strict partial boolean object, preserving omitted fields, or JSON `null` to remove the block and restore defaults. Invalid writes and failures before publication leave live state unchanged; a failure after publication keeps the committed state authoritative. `gui/src/components/NativeReasoningRetentionPanel.tsx` exposes the two opt-ins on the dashboard overview; it requires a valid read before saving and fences stale server responses. Runtime scope and rejection precedence follow [native reasoning retention](#runtime-boundary).

## Runtime boundary

`src/types/request.ts` declares trusted parsed policy fields; `src/responses/reasoning-replay-cache.ts` reports known durable identity deltas without widening cache keys. `src/adapters/openai-responses/passthrough.ts` applies reasoning and compaction stripping independently.

`src/server/responses/request-prepare.ts` snapshots the resolved policy into trusted parsed state. `src/server/responses/core-replay.ts` applies it to the selected concrete route, including each fresh Combo candidate. Retention is eligible only on the canonical ChatGPT Responses forward destination, with an unchanged provider, adapter and durable endpoint. A known model change requires `modelSwitch`; a known credential change requires `accountSwitch`; simultaneous changes require both. It does not widen the serving identity used for reasoning caches or strict plaintext Combo eligibility. Unknown or expired serving provenance retains the existing destination-only behavior rather than inventing a compatibility match.

Account retention is experimental forwarding permission, not evidence that the backend accepts or reuses another caller's reasoning. `src/server/responses/account-change-state.ts` continues removing account-bound continuation references and foreign reasoning item ids; uploaded-file refusal stays independent. Opaque-blob rejection recovery and its rejection memo override retention. Previously stripped ciphertext is never restored in a later recovery leg.

Only reasoning `encrypted_content` is covered. Native compaction cleanup has its own internal flag and preserves the existing identity-change behavior. Direct native `/v1/responses/compact` sanitization is unchanged. API-key providers, arbitrary forward aliases and translated destinations receive no new permission. The configuration and management surface is described above.
