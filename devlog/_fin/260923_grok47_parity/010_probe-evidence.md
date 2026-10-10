# Live probe evidence — grok-4.7 (2026-09-23 KST)

Mechanics: POST /v1/responses on the running proxy (127.0.0.1:10100, ocx 2.62.0), then `ocx logs --json` for the
matching attempt (adapter, credentialSource, reasoningWireField/Value, tierOutcome, usage). xAI traffic used the Grok
OAuth lane (credentialSource "grok-oauth"); no API key was involved. The Responses-wire and `--fast` rows used a
temporary `providers.xai.modelAdapters["grok-4.7"]="openai-responses"` plus
`modelSupportsServiceTier["grok-4.7"]=true` override, applied through the attested provider reload
(`notifyRunningProxy("xai")`, the path `ocx login` uses) and removed the same way afterwards; the restored maps were
compared against a pre-probe backup. Scratch scripts lived in the gitignored `.tmp/`.

## xAI grok-4.7 (Grok OAuth)

| Probe | Chat wire (provider default) | Responses wire (temporary override) |
|---|---|---|
| effort low / medium / high / xhigh | 200, sent as `reasoning_effort` | 200 on all four |
| effort max | 400 `Invalid reasoning effort.` | 400 `Invalid reasoning effort.` |
| effort none | 200, but 640 reasoning tokens: the proxy omits the field and the model still reasons | not probed |
| image, user message (3x3 random color grid, 180x180 PNG) | 9/9 | — |
| image, tool result (same grid inside function_call_output) | 9/9 | — |
| caller `service_tier: "priority"` | 200, wire service-tier priority, response tier priority | 200, applied/confirmed, response tier priority |
| `xai/grok-4.7--fast` | — | 200, fastOutcome applied, confirmation confirmed, response tier priority |
| 530,000-word prompt | 400 `context_length_exceeded`: "531243 tokens > 500000 tokens" | — |

Upstream model name on the Responses wire is `grok-4.7-build` (grok-4.6 reports `grok-4.6-build` the same way).

Billing parity: the Responses `cost_in_usd_ticks` fits these per-token rates exactly across every probe, for both models:
default input 6800, cached input 1700, output 20400 ticks; priority input 40000, cached 10000, output 120000 ticks.
grok-4.6 probed in the same window produced identical rates (e.g. 83 uncached + 128 cached input, 58 output =
1,965,200 ticks). The OAuth subscription is not per-token billed, so these ticks are recorded as parity evidence only;
the key-auth prices below come from xAI's published page.

Published (docs.x.ai/developers/models/grok-4.7, read 2026-09-23): 500,000 context; reasoning effort
low/medium/high (default)/xhigh, reasoning cannot be disabled; text+image input; $2.00 input, $0.50 cached,
$6.00 output per 1M; prompts over 200k tokens $4.00 / $1.00 / $12.00; Responses and Chat Completions.
models.dev `xai/grok-4.7`: output limit 500,000 (same as grok-4.6), released 2026-09-21.

## Other providers

| Provider | Evidence | Result |
|---|---|---|
| devin (`grok-4-7`) | live probe 200 at low and xhigh; tool-result grid 9/9; proxy /v1/models from Devin's live catalog: context 500000, input text+image, efforts low/medium/high/xhigh/max, default medium | exposes |
| command-code (`xai/grok-4.7`) | live probe 200; grid 9/9 on user-message and tool-result paths; COMMAND_CODE_TEXT_ONLY_MODELS is empty and the logs show no vision-sidecar request, so the route read the image natively | exposes, native image |
| cursor (`grok-4.7`) | live probe 200 through the cursor adapter; live GetUsableModels lists grok-4.7-{low,medium,high,xhigh} and the same ids with -fast (no cursor- prefix, no max); probes: grok-4.7-low and grok-4.7-xhigh-fast accepted, bare grok-4.7-fast rejected not_found (see 000_plan.md D6) | exposes |
| opencode-go / opencode-zen | public `/zen/go/v1/models` and `/zen/v1/models` list `grok-4.7` | listed (not configured locally, not probed) |
| openrouter | public API `x-ai/grok-4.7`: 500000 ctx, max completion 450000, $1.6/$4.8/$0.4, >=200k $3.2/$9.6/$0.8, text+image+file | listed (not probed) |
| github-copilot | models.dev `grok-4.7`: ctx 500000, input 372000, output 128000 | listed (not configured locally) |
| kilo, vercel | models.dev lists kilo `x-ai/grok-4.7` and vercel `spacexai/grok-4.7` | listed |

Command Code `xai/grok-4.6` is included in `COMMAND_CODE_IMAGE_MODELS`: it read the grids 9/9
(user message) and 8/9 (tool result) without a vision sidecar. The registry accepts native image
input; 8/9 remains the measured limitation on the tool-result path.
