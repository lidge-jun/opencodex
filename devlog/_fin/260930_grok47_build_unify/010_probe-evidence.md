# 010 — Live probe evidence (2026-09-30, KST)

All probes ran against the user's Grok OAuth subscription (credential source grok-oauth). "Direct" rows call
`https://cli-chat-proxy.grok.com/v1` with the same compatibility headers `src/providers/xai-transport.ts`
builds; "proxy" rows go through the running ocx 2.69.0 on 127.0.0.1:10100. No tokens, account/team ids or
request bodies are recorded here; raw per-request rows were kept in the gitignored `.tmp/grok47/` scratch
directory. Lanes: capability (86 requests), speed (streaming, interleaved round-robin, sequential),
cost/continuation (14 + follow-up).

## Identity and capability (direct unless noted)

| Check | grok-4.7 | grok-4.7-build-fast | grok-4.6 (reference) |
|---|---|---|---|
| Listed by upstream `/v1/models` | yes | yes | yes |
| Advertised context / backend / default effort | 256000 / responses / high | 256000 / responses / high | 256000 / responses / high |
| Advertised effort ladder | low..xhigh | low..xhigh | — |
| Served-model echo (Responses and Chat) | `grok-4.7-build` | `grok-4.7-build-fast` | `grok-4.6-build` |
| `grok-4.7-build` requested directly | 404 "does not exist or your team … does not have access" | — | — |
| Effort accepted (R and C) | minimal, low, medium, high, xhigh | minimal, low, medium, high, xhigh (C xhigh not run) | low..high checked |
| Effort rejected | none ("does not support reasoning_effort value none"), max ("Invalid reasoning effort.") | identical | — |
| 32×32 PNG input | 200 | 200 | — |
| 16×16 PNG input | 400 "below the minimum of 512 pixels" | identical | — |
| `stop` / `presence_penalty` on direct Responses | 200 / 200 | 200 / 200 | — |
| ~521k-token prompt | 400 "(521246 tokens > 500000 tokens)" | identical message | — |
| `service_tier: priority` echo (R and C) | priority | priority | priority |

The gateway's advertised 256000 context disagrees with the enforced 500000 limit on both ids; the registry
keeps the measured 500000 for both. Parameter acceptance on the direct Responses wire does not overturn the
existing Chat-wire `stop`/penalty rejections recorded in the registry; those lists are unchanged.

Proxy today (before this unit): `xai/grok-4.7-build-fast` routes over the openai-chat adapter (no wire pin),
and both `xai/grok-4.7-build-fast--fast` and an explicit priority tier return 200 with the tier echo visible in
telemetry but not in the client body. The dashboard lists build-fast as a second, disabled Grok 4.7 row.

## Speed (direct, streaming, long prompt: 40 one-line facts, sequential)

Round 1 of the interleaved matrix (later rounds were still running when this doc was written; see the
update block below). TTFT is time to the first visible text delta; "all tok/s" counts reasoning + visible
output over total time.

| Model | Wire | Tier | Effort | TTFT s | Total s | all tok/s |
|---|---|---|---|---:|---:|---:|
| grok-4.7 | R | default | low | 36.9 | 41.3 | 84.6 |
| grok-4.7 | R | priority | low | 35.7 | 40.0 | 83.1 |
| grok-4.7-build-fast | R | default | low | 18.6 | 21.3 | 126.8 |
| grok-4.7-build-fast | R | priority | low | 22.5 | 24.8 | 140.0 |
| grok-4.7 | R | default | high | 47.6 | 52.3 | 87.6 |
| grok-4.7 | R | priority | high | 59.4 | 63.4 | 89.8 |
| grok-4.7-build-fast | R | default | high | 31.3 | 33.8 | 144.2 |
| grok-4.7-build-fast | R | priority | high | 27.3 | 29.1 | 158.3 |
| grok-4.7 | C | default / priority | low | 30.0 / 41.5 | 34.4 / 46.4 | 76.5 / 79.7 |
| grok-4.7-build-fast | C | default / priority | low | 28.5 / 19.5 | 31.3 / 22.1 | 134.9 / 145.8 |
| grok-4.6 | R | default / priority | low | 58.7 / 12.3 | 63.1 / 22.6 | 67.4 / 55.1 |

Short prompts (non-streaming, 20 facts, effort low, N=2): grok-4.7 6.1–6.6 s, build-fast 3.4–4.0 s.
Visible-text streaming rate on Responses: grok-4.7 ~106–119 tok/s, build-fast ~177–209 tok/s.

Reading: build-fast is 1.5–1.7x faster end to end at every effort and on both wires. Priority processing on
`grok-4.7` produced no measurable speedup. Priority on build-fast was mixed (TTFT worse at low, better at
high, throughput +10%).

## Cost ticks (direct, non-streaming, effort low, N=2, identical 1259-token input)

| Model | Tier echo | Output tokens | Cost ticks | Ticks per output token |
|---|---|---:|---:|---:|
| grok-4.7 | default | 334 / 334 | 9.50M / 9.50M | 28.4k |
| grok-4.7 | priority | 336 / 308 | 56.1M / 52.8M | ~169k |
| grok-4.7-build-fast | default | 318 / 315 | 18.3M / 18.2M | ~57.8k |
| grok-4.7-build-fast | priority | 321 / 329 | 108.6M / 110.6M | ~337k |

`cost_in_usd_ticks` is what the gateway charges against the subscription's usage allowance. Priority multiplies
it ~5.9x on both ids; build-fast without priority costs ~2x base.

## Decision (see 000_plan.md D3)

One model, two serving lanes. Keep `grok-4.7` as the only visible row. Its Fast selection on the OAuth lane
dispatches `grok-4.7-build-fast` with no service tier: the fastest measured lane at a third of the cost of
today's Fast (priority on grok-4.7), which bought no speed. Key auth keeps priority (build-fast is not on the
public API). Explicit build-fast requests keep working and gain the probed OAuth Responses wire.


## Continuation across the two ids

The Grok OAuth gateway echoes `store: false` even when `store: true` is requested, and a direct
`previous_response_id` returns 404 even for a same-model control, so upstream-held continuation is not
available on this lane at all. OpenCodex already covers that: with cached history it expands the input
locally and strips `previous_response_id` (request-prepare.ts:315/397, passthrough.ts:267), and the state
lookup is keyed by response id and client scope, not model (state.ts:1056). Codex itself sends full input
with `store:false`.

| Recipe | 4.7 → 4.7 | 4.7 → build-fast | build-fast → 4.7 |
|---|---|---|---|
| Direct, full replay, store:false | recalled | recalled | recalled |
| Proxy, previous_response_id (local expansion) | recalled | recalled | missed once (N=1) |

The one proxy miss started on build-fast while it still fell back to the Chat wire (no wire pin before this
unit); the same direction recalled under direct full replay. The model switch itself showed no boundary.
This unit also pins build-fast to the OAuth Responses wire, removing that confounder.
