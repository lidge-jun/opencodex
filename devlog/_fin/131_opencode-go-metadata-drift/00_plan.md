# 131.00 — Plan: OpenCode Go Metadata Drift Closure

## Goal

Close OpenCode Go model metadata drift across the three places that now matter:

1. GJC upstream clone on `dev` at `/Users/jun/Developer/new/700_projects/jawcode/devlog/_upstream_gjc`.
2. jawcode at `/Users/jun/Developer/new/700_projects/jawcode`.
3. opencodex generated jawcode metadata at `/Users/jun/Developer/new/700_projects/opencodex`.

The user-facing bug is that Codex receives wrong context/output limits for routed OpenCode Go
models. The root cause is that OpenCode Go's `/v1/models` endpoint only exposes
`id/object/created/owned_by`, while the exact `context/output/modalities` values live in
OpenCode's official `/data/...` catalog pages.

## Retry Update: Web SOT Split

The first upstream GJC PR (#914) was closed after review because it treated every tracked
OpenCode Go id as `/v1/chat/completions` and reused generic data-page prices for rows where
the Go product page publishes a different contract. The retry uses a split source of truth:

- `https://opencode.ai/docs/go/#endpoints` is authoritative for the OpenCode Go gateway
  endpoint/API SDK path.
- `https://opencode.ai/docs/go/#usage-limits` is authoritative for current Go product
  prices when the row appears in that table.
- `https://opencode.ai/data/...` pages remain authoritative for context/output/modalities.
- `https://opencode.ai/zen/go/v1/models` is existence-only for this work because it returns
  model ids without context/output/pricing metadata.

This means MiniMax M2.5/M2.7/M3 and Qwen3.6/3.7 Plus/Max must route to
`anthropic-messages` on `https://opencode.ai/zen/go`, while GLM/Kimi/DeepSeek/MiMo rows in
the endpoint table route to `openai-completions` on `https://opencode.ai/zen/go/v1`.
Qwen Plus rows have tiered prices in the Go usage table; generated rows advertise a 1M
context window, so the retry encodes the `> 256K tokens` tier.

## Official Source Values

These are the Phase 131 source-of-truth values verified from official OpenCode data pages on
2026-06-20. The jawcode/GJC model type can only represent `text` and `image`, so `video`,
`audio`, and `pdf` are recorded here as source facts but cannot be emitted until the upstream
`Model.input` contract expands.

| Model | Context | Output | Official input | Represented input |
|---|---:|---:|---|---|
| `deepseek-v4-flash` | 1000000 | 384000 | text | text |
| `deepseek-v4-pro` | 1000000 | 384000 | text | text |
| `glm-5` | 204800 | 131072 | text | text |
| `glm-5.1` | 200000 | 131072 | text | text |
| `glm-5.2` | 1000000 | 131072 | text | text |
| `kimi-k2.5` | 262144 | 262144 | text, image, video | text, image |
| `kimi-k2.6` | 262144 | 262144 | text, image, video | text, image |
| `kimi-k2.7-code` | 262144 | 262144 | text, image, video | text, image |
| `minimax-m2.5` | 204800 | 131072 | text | text |
| `minimax-m2.7` | 204800 | 131072 | text | text |
| `minimax-m3` | 512000 | 128000 | text, image, video | text, image |
| `qwen3.5-plus` | 1000000 | 65536 | text, image, video | text, image |
| `qwen3.6-plus` | 1000000 | 65536 | text, image, video | text, image |
| `qwen3.7-max` | 1000000 | 65536 | text | text |
| `qwen3.7-plus` | 1000000 | 64000 | text, image | text, image |
| `mimo-v2-omni` | 262144 | 131072 | text, image, audio, video, pdf | text, image |
| `mimo-v2-pro` | 1048576 | 131072 | text | text |
| `mimo-v2.5` | 1048576 | 131072 | text, image, audio, video | text, image |
| `mimo-v2.5-pro` | 1048576 | 131072 | text | text |
| `hy3-preview` | 256000 | 64000 | text | text |

Official evidence pages:

- `https://opencode.ai/docs/go/`
- `https://opencode.ai/data/deepseek/deepseek-v4-flash`
- `https://opencode.ai/data/zhipu/glm-5-2`
- `https://opencode.ai/data/moonshot/kimi-k2-7-code`
- `https://opencode.ai/data/minimax/minimax-m3`
- `https://opencode.ai/data/qwen/qwen3-5-plus`
- `https://opencode.ai/data/xiaomi/mimo-v2-5`
- `https://opencode.ai/data/tencent/hy3-preview`
- `https://opencode.ai/zen/go/v1/models`

## PABCD Cycle Map

### Cycle 1 — Documentation

Create this `131` devlog folder and record the root cause, source values, and exact patch path.

### Cycle 2 — GJC `dev`

Modify:

- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_upstream_gjc/packages/ai/src/provider-models/openai-compat.ts`
- `/Users/jun/Developer/new/700_projects/jawcode/devlog/_upstream_gjc/packages/ai/test/issue-887-repro.test.ts`
- generated: `/Users/jun/Developer/new/700_projects/jawcode/devlog/_upstream_gjc/packages/ai/src/models.json`

Plan:

- Add an OpenCode Go official metadata override table in `openai-compat.ts`.
- Make OpenCode Go dynamic discovery map `/v1/models` ids through that table.
- Add descriptor-level appended official rows so models absent from `models.dev` still enter generated `models.json`.
- Expand the issue 887 test from routing-only to routing + metadata + missing-row coverage.
- Run `bun --cwd=packages/ai run generate-models`, targeted test, and package check.

### Cycle 3 — jawcode

Apply the same generator-safe patch to:

- `/Users/jun/Developer/new/700_projects/jawcode/packages/ai/src/provider-models/openai-compat.ts`
- `/Users/jun/Developer/new/700_projects/jawcode/packages/ai/test/issue-887-repro.test.ts`
- generated: `/Users/jun/Developer/new/700_projects/jawcode/packages/ai/src/models.json`

Run the same targeted and package gates.

### Cycle 4 — opencodex

Modify:

- `/Users/jun/Developer/new/700_projects/opencodex/src/generated/jawcode-model-metadata.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/codex-catalog.test.ts`
- this devlog folder's verification record

Plan:

- Regenerate opencodex jawcode metadata from patched jawcode using
  `bun run generate:jawcode-metadata`.
- Add/adjust catalog tests for high-risk OpenCode Go entries:
  `glm-5.2`, `qwen3.5-plus`, `kimi-k2.7-code`, `minimax-m3`, `hy3-preview`.
- Run opencodex targeted tests, full test suite, typecheck, and a local catalog smoke.

## Acceptance Criteria

- GJC `opencode-go` generated rows match official context/output for the 20 tracked models.
- jawcode `opencode-go` generated rows match official context/output for the 20 tracked models.
- opencodex generated metadata exposes the corrected rows.
- Codex catalog entries built by opencodex carry the corrected `context_window`,
  `max_context_window`, and `auto_compact_token_limit`.
- No token values are printed.
- No unrelated dirty worktree changes are reverted.
