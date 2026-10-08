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
