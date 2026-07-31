# 120 — Desktop 3P Compatible Aliases

## Problem

Claude Desktop 3P mode filters `/v1/models` to only show "recognizably Claude" models.
The existing `claude-ocx-{provider}--{model}` aliases are filtered out because Desktop
recognizes the underlying model name (gpt, glm, grok) as non-Claude.

## Goal

Generate model IDs that:
- Look like Claude version strings → pass Desktop's model guard
- Encode the actual routed model deterministically
- Are stable across model additions/removals
- Work for both Desktop 3P auto-discovery AND Claude Code CLI
- Coexist with existing `claude-ocx-*` aliases (CLI keeps working)

## Discovery (2026-07-12)

- Desktop 3P GA: July 9, 2026
- Desktop uses `GET /v1/models` for auto-discovery
- Filters by "recognizably Claude" (stricter than `claude-` prefix)
- `inferenceModels` config overrides discovery (manual, user tested working)
- Manual entries accept opaque IDs with `anthropicFamilyTier` metadata
- User confirmed: `opus-1` with display name "GPT 5.6 Sol" works end-to-end

## Encoding Spec

*(Pending: sol agent Goodall writing detailed spec at 120_desktop_3p_alias_spec.md)*

Key requirements:
- Input: `provider/modelId` (e.g., `native/gpt-5.6-sol`)
- Output: `claude-{tier}-4-{code}` (e.g., `claude-opus-4-s0`)
- Deterministic, stable, collision-resistant for ~50 models
- Tier (opus/sonnet/haiku) assigned by model capability
- Real Claude models pass through without encoding

## Implementation Plan

| File | Change |
|------|--------|
| `src/claude/alias.ts` | Add Desktop alias generation + decode |
| `src/claude/inbound.ts` | `resolveInboundModel` handles new format |
| `src/server/index.ts` | `/v1/models` returns Desktop aliases for 3P clients |
| `src/server/management-api.ts` | GUI export endpoint for Desktop 3P config |
| `gui/src/pages/ClaudeCode.tsx` | "Desktop 3P 설정 내보내기" button |
| `tests/` | Alias generation + decode tests |
| `docs/` | Desktop 3P integration guide |
