# 000 — 260721-alibaba-token-plan-hardening: Plan

> DIFFLEVEL-ROADMAP-01: write this doc to full diff-level precision (exact paths,
> NEW/MODIFY/DELETE, before/after diffs) BEFORE P -> A. An empty scaffold does not
> satisfy the rule; the A-phase reviewer FAILS outline-only phase docs.

## Objective

(fill in: the concrete outcome, the observed failure, the evidence base)

## Loop-spec

- Loop archetype: (verifier-defined | judged)
- Write scope / out-of-scope:
- Budget / bounds:

## Work-phase map (one phase = one full PABCD cycle)

| WP | Doc | Slice | Depends on |
|----|-----|-------|------------|

## Accept criteria

- (mirror into the goalplan criteria[])
# 260721 Alibaba Token Plan Hardening

## Objective

Harden both Alibaba Token Plan provider entries (`alibaba-token-plan` Beijing,
`alibaba-token-plan-intl` Singapore), add `qwen3.8-max-preview` to the
International entry, and make the `preview` branch merge-ready into `main`.

## Current State

- `dev` branch is 2 commits ahead of `preview` (alibaba-token-plan-intl fixes + soft-avoid pool)
- Beijing entry has `qwen3.8-max-preview` but missing noVisionModels, context windows
- International entry missing `qwen3.8-max-preview` and 4 chat models
- Sol adversarial review completed with CRITICAL and IMPORTANT findings

## Sol Adversarial Review Summary

### CRITICAL
1. `minimal` reasoning sends `thinking_budget: 0` (Alibaba requires positive integer)
   - Out of scope for this pass (cross-cutting change)
2. PAYG endpoint mixing in intl entry — documented, no change (architectural decision)

### IMPORTANT — In Scope
1. Intl missing 4 chat models: `kimi-k2.6`, `kimi-k2.5`, `glm-5.1`, `glm-5`
2. `kimi-k2.7-code` vision metadata wrong (should be text+image)
3. `preserveReasoningContentModels` incomplete for Qwen models
4. Context windows substantially incomplete (Beijing has none)
5. `qwen3.8-max-preview` missing from intl

### IMPORTANT — Deferred
- `noReasoningModels` reclassification (needs wire-specific thinking control)
- `minimal` budget fix (cross-cutting, affects all thinking_budget models)

## Work Phases

### WP0: Docs-only research (this cycle)
- Verify official model lists via Tier 2 sources
- Document findings in 001_research.md
- Write implementation plan in 010_implementation.md

### WP1: Implementation
- Add `qwen3.8-max-preview` to intl model list, qwen models, input modalities
- Add 4 missing chat models to intl
- Fix kimi-k2.7-code vision metadata
- Add Beijing noVisionModels and context windows
- Expand preserveReasoningContentModels
- Update tests
- Run typecheck + test suite

### WP2: Merge-ready
- Merge dev into preview
- Run full test suite on preview
- Verify fast-forward into main

## File Change Scope

- `src/providers/registry.ts` — model lists, configs
- `src/providers/base-url-choices.ts` — no change expected
- `tests/alibaba-intl-token-plan.test.ts` — update model count, add qwen3.8 checks
- `tests/qwen38-preserve-reasoning.test.ts` — verify intl coverage
- `devlog/_plan/260721_*/` — research + implementation docs
