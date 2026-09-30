# 030 Done (wp2): Sonnet 5.5 catalog, pricing and adapter contract

## Outcome

- Snapshot rows (15), regenerated `src/generated/model-metadata.ts`: anthropic `claude-sonnet-5-5`;
  Bedrock `anthropic.`, `global.` (2 / 10 / 0.2 / 2.5) and `us.`, `eu.`, `jp.`, `au.` (1.1x:
  2.2 / 11 / 0.22 / 2.75); openrouter, vercel-ai-gateway, kilo `anthropic/claude-sonnet-5.5`; venice
  `claude-sonnet-5-5` (3.75 / 18.75 / 0.375 / 4.6875); github-copilot `claude-sonnet-5-5`; preemptive
  opencode-zen `claude-sonnet-5-5`, zenmux `anthropic/claude-sonnet-5.5`, cloudflare-ai-gateway
  `anthropic/claude-sonnet-5-5`. All 1M / 128K.
- Seeds: `ANTHROPIC_MODELS` and context map (also reaches claude-cli and the native Anthropic catalog),
  Devin seed and context (preemptive), Kiro `claude-sonnet-5.5` (preemptive), Cursor capability and
  effort tier (regular-only flat ids until the live roster lists it), Claude Desktop picker suggestion.
- Price overlays: anthropic, anthropic-apikey, cursor (verified); devin, devin-cli (verified-derived,
  preemptive). Venice, Kiro, Command Code and Opper resolve through the Anthropic vendor row, as Opus
  5.5 already does.
- Adapter: new `src/adapters/anthropic-model-contract.ts` owns the per-family rules. Sonnet 5.5
  reasoning `none` sends `between_tools`; forced tool choice degrades to `auto`; temperature/top_p
  are dropped. The web-search and vision sidecars use the same module for their thinking-off field.

## Live evidence (2026-09-29, api.anthropic.com, OAuth, adapter-built bodies)

| Request | Before | After |
|---|---:|---:|
| `claude-sonnet-5-5`, reasoning none | 400 (`thinking.type.disabled` not supported) | 200 (`between_tools`) |
| `claude-sonnet-5-5`, temperature 0.2 | 400 (`temperature` is deprecated for this model) | 200 (stripped) |
| `claude-sonnet-5-5`, tool choice required | 400 (`any` not supported) | 200 (`auto`) |
| `claude-sonnet-5-5`, effort medium and max | 200 | 200 |
| `claude-sonnet-5`, reasoning none (control) | 200 (`disabled`) | 200 (unchanged) |

## Residuals

- Dotted Bedrock ids (`us.anthropic.claude-sonnet-5-5`) do not parse as a Claude family, so the rules
  above do not apply on that id shape; true for every family today.
- Messages-native passthrough forwards the caller's `thinking` and sampling fields unchanged.
- Rows marked preemptive (Devin, Kiro, opencode-zen, ZenMux, Cloudflare, Bedrock regional) are inert
  until each provider lists the model; Kiro and Devin show the id in their static pickers, so a call can
  fail upstream until they ship it.
- The Cursor row is re-shaped once the live GetUsableModels roster lists `claude-sonnet-5-5`.
