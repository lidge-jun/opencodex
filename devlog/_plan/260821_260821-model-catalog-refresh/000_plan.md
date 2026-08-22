# 000 — 260821-model-catalog-refresh: Plan

## Objective

Add the OpenRouter stealth model "Ox Alpha" and the DeepSeek vision preview id to
every provider entry that can serve them, and adjust the opencode-side metadata to
the verified specs (1,048,576 context, text+image input). Evidence base: five Luna
research lanes run 2026-08-21 — OpenRouter /api/v1/models (primary), Command Code
changelog v1.31.0 + model profile (primary), OpenCode Zen docs (primary), DeepSeek
API docs community relay (strong lead).

## Loop-spec

- Loop archetype: verifier-defined (typecheck + focused registry/provider suites)
- Write scope: src/providers/registry.ts, src/providers/command-code-efforts.ts
- Out-of-scope: adapter code, live discovery mechanics, GUI
- Budget / bounds: one commit, direct admin push to dev per operator instruction

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|
| wp1 | 010_phase1.md | Registry metadata + efforts table + tests + commit + push | — |

## Accept criteria

- Ox Alpha carries 1M context and text+image on opencode-go/free/zen entries
- openrouter seeds stealth/ox-alpha with context + modalities
- Both Command Code entries advertise stealth/ox-alpha facts (efforts low/high/max)
- deepseek-v4-flash-vision-exp present on deepseek + every v4-flash gateway entry,
  commented as expected to merge into deepseek-v4-flash later
- Focused tests green; committed; pushed to origin/dev

