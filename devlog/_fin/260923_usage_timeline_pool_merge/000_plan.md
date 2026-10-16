# Usage timeline: one series per provider/model across pool accounts

## Problem

The companion usage chart (native macOS tray, WidgetKit snapshot, and the GUI companion panel)
reads `GET /api/usage/timeline`. `src/usage/timeline.ts` keyed each series on the raw logged
provider, and ChatGPT/OpenAI pool accounts log as `openai-p<hex6>` (older rows as `openai-main`
or `chatgpt`). One model therefore drew one line per account: `openai-p6bc633/gpt-6-astra`,
`openai-pe2d42f/gpt-6-astra`, `openai/gpt-6-astra`, and so on, which also pushed real models into
the folded `other` row. The usage summary already folds these through `baseProviderLabel`.

## Decision

The timeline uses the same label as the summary. The account split stays available through the
existing `modelAccount` grouping.

## Phases

- [010_phase1.md](./010_phase1.md) — timeline normalization and regression test.
