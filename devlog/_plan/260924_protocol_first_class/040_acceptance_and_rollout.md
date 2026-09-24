# 040 — acceptance and rollout (PF-12)

## Rollout order

1. Existing execution is the default. Every `protocols.rollout.*` switch is off.
2. `shadowPlan` on: at finalize, the dispatch-basis plan for the settled route is compared with
   the observed trace; a disagreement sets `planMismatch: true` on the trace. No second request
   is ever sent.
3. Per-target opt-in: `nativeChatCombos`, `managedMessagesNative`, `directEncoders`, then
   `managedMessagesNativeOAuth`.
4. A switch's default flips only after its scenarios below have recorded evidence on a merged
   head, in a separate reviewed change.
5. `unrepresentable: "reject"` is an operator policy, not a rollout step; it stays opt-in.

## Acceptance scenarios

| Scenario | Accepted when |
|---|---|
| Chat → Chat, `n=2` / `logprobs` | every choice and logprobs survive; direct and combo give the same upstream body; every choice terminal is honoured |
| Chat → Responses, `n=2` | under `reject`, refused before any send with `unsupported_feature`; never reduced to one choice and never emulated with extra calls |
| Messages → Messages (managed key) | source blocks and declared options (`top_k`, `cache_control`, `thinking`) survive; caller-forward, managed key and OAuth stay separate authority cases |
| Messages → Chat | role order and tool pairing preserved; unsupported fields follow policy |
| Chat → Messages | function definitions/results map to content blocks; stop reason and usage mapped |
| Responses → Chat / Messages | continuation and compaction unchanged |
| Mixed combo failover | every attempt built from the source envelope; send budget shared; affinity kept; ineligible candidates skipped with a recorded reason; no resend after partial stream output |
| `stream: false` / `true` | correct envelope, error frames, terminal, chunk boundaries, backpressure, cancellation, timeout, memory budget |
| Unknown extension or media | never silently dropped on a translated path without a recorded effect |
| Dashboard and remote runtime | stale/unknown/unsupported distinguished; per-request trace; policy-revision mismatch visible; hash state survives Back/Forward |
| API disable migration | `/v1/messages` and `count_tokens` agree; upgrade, old-UI writes and rollback never reopen a closed surface |

Verification runs in isolated fixtures with no access to a user's home, credentials or services.
Live provider probes happen only with a consenting operator's keys and budget and are recorded
separately from fixture results.

## Not-migrated inventory

Kept current by each packet that migrates something.

| Path | State after this unit |
|---|---|
| Chat/Messages request decode | still produces a Responses-shaped body before the IR (`responses-internal`); codecs are named entry points over the existing translators |
| Policy-route children | native Chat only if dispatched through the combo child loop (PF-07 records the outcome) |
| Sidecars (web search, vision, image generation) | Responses pipeline only |
| Responses-only features on Chat/Messages | `previous_response_id`, `store`, `background`, compaction stay on the bridge |
| Non-public-wire adapters (`other`) | translated through the IR; no feature claims |
| OAuth native Chat | not planned in this unit |
