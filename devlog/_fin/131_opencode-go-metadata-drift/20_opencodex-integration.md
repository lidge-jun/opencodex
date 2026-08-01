# 131.20 — opencodex Integration Note

## Why There Is No opencodex Runtime Code Patch

Phase 131 retry changes two upstream jawcode/GJC surfaces:

- OpenCode Go endpoint routing: `/v1/chat/completions` versus `/v1/messages`.
- OpenCode Go product pricing from `https://opencode.ai/docs/go/#usage-limits`.

opencodex does not consume either field. Its Codex catalog integration consumes only the
generated jawcode metadata fields represented in
`src/generated/jawcode-model-metadata.ts`:

- `contextWindow`
- `maxTokens`
- `input`
- `reasoning`
- optional `wireModelId`

Those are the fields Codex needs for `context_window`, `max_context_window`,
`auto_compact_token_limit`, and `input_modalities`.

## Existing Guards

The opencodex-side regression surface is already covered by
`tests/codex-catalog.test.ts`:

- `opencode-go high-risk models use official jawcode metadata in the Codex catalog`
  locks `glm-5.2`, `qwen3.5-plus`, `kimi-k2.7-code`, `minimax-m3`, and `hy3-preview`.
- `opencode-go catalog sync appends official rows missing from /v1/models` verifies that
  generated jawcode rows are appended for configured `opencode-go`, even when the live
  provider `/v1/models` endpoint omits them.

The runtime smoke in `10_verification.md` then verifies the same path through real `ocx start`
and `GET /v1/models?client_version=0.141.0`.

## Generated Metadata Result

Regenerating opencodex metadata from the patched jawcode worktree was tested with:

`JAWCODE_MODELS_JSON=/Users/jun/Developer/new/700_projects/jawcode/devlog/_worktrees/opencode-go-contract/packages/ai/src/models.json bun run generate:jawcode-metadata`

The relevant `opencode-go` context/output/modalities rows did not change compared with the
existing committed snapshot. The retry's meaningful payload therefore lives in jawcode/GJC,
while opencodex records the source-of-truth split and verifies the live catalog behavior.

To avoid unrelated dynamic provider churn, no generated metadata diff is committed in
opencodex for this retry.
