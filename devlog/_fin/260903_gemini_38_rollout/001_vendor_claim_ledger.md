# 001 — Gemini 3.8 Flash: vendor claim ledger

Research snapshot 2026-09-03 (KST), collected by an independent read-only research lane on
`gpt-5.6-sol` at high reasoning effort. Every row was verified by opening the linked official
page. Unprovable fields say `NOT PROVEN` rather than borrowing 3.7's value.

| Claim | Value | Source | Page date |
|-------|-------|--------|-----------|
| Canonical Developer API id | `gemini-3.8-flash` | ai.google.dev/gemini-api/docs/models/gemini-3.8-flash | 2026-09-02 |
| Published aliases | stable id only; `-preview`/dated/`-latest` NOT PROVEN | same + docs/models | 2026-09-02 |
| Release date | 2026-09-02 | deepmind.google model card; docs.cloud.google.com | 2026-09-02 |
| Availability | GA, production-ready (not Preview) | latest-model guide | 2026-09-02 |
| Context window | 1,048,576 input tokens | model page | 2026-09-02 |
| Max output | 65,536 tokens | model page | 2026-09-02 |
| Input price | $0.75 / 1M through 2026-12-31, $1.50 / 1M from 2027-01-01 | Developer API pricing | 2026-09-02 |
| Output price (incl. thinking) | $3.75 / 1M through 2026-12-31, $7.50 / 1M from 2027-01-01 | Developer API pricing | 2026-09-02 |
| Separate thinking price | none — thinking billed as output | pricing | 2026-09-02 |
| Cache read | $0.075 / 1M through 2026-12-31, then $0.15 | pricing | 2026-09-02 |
| Cache storage | $0.50 / 1M tokens/hour through 2026-12-31, then $1.00 | pricing | 2026-09-02 |
| Batch / Flex | half of standard input and output | pricing | 2026-09-02 |
| Priority | $1.35 in / $6.75 out per 1M through 2026-12-31 | pricing | 2026-09-02 |
| Thinking parameter | `generation_config.thinking_level` (replaces `thinking_budget`) | latest-model | 2026-09-02 |
| Thinking values | `low` / `medium` / `high`, default `medium` | latest-model; Cloud guide | 2026-09-02 |
| `minimal` | unsupported — setting it returns a validation error | model page; Cloud guide | 2026-09-02 |
| Inputs | text, image, video, audio, PDF | model page | 2026-09-02 |
| Outputs | text only (no image/audio generation, no Live API) | model page | 2026-09-02 |
| Knowledge cutoff | March 2026 (some domains still January 2025) | DeepMind model card | 2026-09-02 |
| Antigravity default | proven for the Managed Agents agent and the Antigravity SDK; the desktop/CCA backend default is NOT PROVEN | latest-model | 2026-09-02 |
| Vertex / Agent Platform id | `gemini-3.8-flash`, `publishers/google/models/gemini-3.8-flash:generateContent` | Cloud developer guide | 2026-09-02 |
| **3.7 Flash deprecated?** | **No — Google says 3.7 Flash "remains fully supported" and still lists it Stable** | latest-model; models catalog | 2026-09-02 |
| CCA billing equivalence | NOT PROVEN — the listed prices are Developer API prices | pricing | 2026-09-02 |

## Other providers OpenCodex integrates

| Provider | 3.8 model id published? | Source |
|---|---|---|
| OpenRouter | YES — `google/gemini-3.8-flash` | openrouter.ai model page |
| Cursor | NO — models page and changelog still stop at 3.7 Flash | cursor.com/docs/models-and-pricing; /changelog |
| GitHub Copilot | NO — supported-model table lists 3.5/3.6/3.7 only | docs.github.com Copilot supported models |

## Unprovable fields

- 3.8-specific preview, dated, or `-latest` aliases.
- A standalone `blog.google` launch post (the date rests on the DeepMind card and the Cloud record).
- Cloud Code Assist billing equivalence to Developer API list prices.
- Cursor and GitHub Copilot 3.8 model ids.

## Why the pricing row cannot be `verified` for Antigravity

OpenCodex routes this model through CCA, and the pricing page distinguishes Developer API,
Enterprise Agent Platform, and managed Antigravity-agent pricing without proving equivalence
for the Cloud Code Assist backend. This is exactly the provenance caveat the 3.7 unit already
recorded, and `src/usage/expected-prices.ts` already has the right enum member for it:
`verified-derived`. Only a `google`-provider row may claim `verified`.
