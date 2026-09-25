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
| Chat/Messages response encode (PF-09) | migrated behind `directEncoders` for one concrete non-Responses route in the streaming adapter delivery: `[upstream, ir, client]`. Still through `responses-internal`: combo and policy children, routed compaction, run-turn adapters (Cursor, Devin, coding-agent CLIs, CodeBuddy), sidecar turns, the buffered `parseResponse` branch (unused by these ingresses, which always stream internally), and every route while the switch is off. Responses-wire upstreams keep their existing codec path |
| Policy-route children | not migrated (PF-07): `routeModel` evaluates the policy and returns one concrete candidate, so a policy request never reaches the combo child loop and keeps the Chat bridge |
| Chat combos with `nativeChatCombos` off | bridge for every candidate, and not judged per candidate under `reject` (the ingress guard also skips combos) |
| Chat combos reached through an effort row | bridge (PF-07): the row's effort lives only on the Responses body, so the native source is not supplied |
| Native Chat combo child, streamed, zero-output in-band failure | no hop (PF-07): the child's 200 is committed without `preflightComboStreamResponse`, so a failure frame before any output reaches the client instead of the next target; the bridge child would have hopped |
| Sidecars (web search, vision, image generation) | Responses pipeline only |
| Responses-only features on Chat/Messages | `previous_response_id`, `store`, `background`, compaction stay on the bridge |
| Non-public-wire adapters (`other`) | translated through the IR; no feature claims |
| OAuth native Chat | not planned in this unit |
| Messages → key-auth Anthropic | native behind `managedMessagesNative` (PF-08); bridge while off. Caller `anthropic-beta` is not forwarded (PF-10 allowlist); top-level fields outside the allowlist are dropped with no feature effect |
| Messages → Anthropic OAuth | bridge until `managedMessagesNativeOAuth` (PF-10) |
| Messages native lane, translated-only steps | a pinned route effort, blocked-skill elision, the web-search sidecar and vision preprocessing keep the request on the bridge (`bridge-only-policy` / `vision-preprocessing`); `stabilizePromptCache` is a recorded gap — the native lane does not apply it |
