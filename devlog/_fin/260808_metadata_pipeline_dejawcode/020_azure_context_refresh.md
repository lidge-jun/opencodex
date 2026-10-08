# Azure context metadata refresh — 2026-10-08

The public `openai` snapshot had 373,000-token windows for GPT-5.6, its Luna/Sol/Terra
variants, GPT-6 Luna/Sol and GPT-6.1 Sol, while the canonical `openai-apikey` registry
declared 1,050,000. Align those seven snapshot windows with the registry and add the
missing GPT-6 Astra row (1,050,000 context, 128,000 output).

Public metadata cross-check: `https://openrouter.ai/api/v1/models`, read on 2026-10-08,
reported 1,050,000 context and 128,000 maximum output for the seven named variants
above, including Astra. Astra prices per million tokens were input 10, output 50,
cache read 1 and cache write 12.5. The plain `gpt-5.6` window follows the existing
canonical API registry seed; it was not independently listed by this source.
The `openai-codex` and `openrouter` snapshot bundles retain their separate contracts.

This is model metadata, not proof of an individual Azure deployment's capacity. The
destination-gated catalog fallback runs only when reported/configured limits are absent.
Regression coverage includes serialized catalog context and compaction, case matching,
unknown aliases, non-Azure destinations, explicit limits and provider caps.

The same catalog fallback fills missing input modalities and output limits. The public
`https://models.dev/api.json` Azure provider rows were read on 2026-10-08: 96 models
in a 5,362,373-byte catalog. Azure `gpt-6.1-sol` reports text/image/pdf input,
1,050,000 context and 128,000 output; Azure `deepseek-v4-flash` reports text-only
input, 1,000,000 context and 384,000 output. The direct-vendor DeepSeek row differs,
so published Azure fields take precedence over vendor fallback. Codex accepts only
text/image/audio input values; unsupported values such as pdf are filtered.

Discovery refreshes and caches the public Azure subset for 24 hours, with a two-second
deadline and 16 MiB byte ceiling, without sending provider credentials. Missing or
malformed metadata keeps discovery working; stale data remains usable offline. New
published ids can acquire image metadata without a bundled-data release. Azure inference
capability flags alone do not identify modalities, and arbitrary deployment aliases are
not guessed. Explicit declarations, reported modalities and sidecar behavior remain intact.
