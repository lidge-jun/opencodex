# Phase 50 — Smart model-name normalization

## Problem
mapModelId (kiro.ts 56-58) only strips a "kiro-" prefix. Gateway
(model_resolver.py normalize_model_name) maps versioned/dashed slugs
(claude-sonnet-4-5-20250929, claude-3-7-sonnet, claude-4.5-sonnet-high) to
canonical Kiro model ids. opencodex can mis-route versioned slugs.

## Plan (finalized in this phase's P)
- Add normalizeKiroModelId covering: date-suffix stripping (-YYYYMMDD),
  dashed-version -> dotted (4-5 -> 4.5), family reordering where gateway does it,
  and effort suffix stripping (-high/-low) since effort is a separate field here.
- Keep "auto"/"kiro-auto" handling. Map to the registry's canonical KIRO_MODELS id.
- Pure function + table-driven; no network.

## Tests (mirror gateway docstring cases)
- claude-sonnet-4-5-20250929 -> claude-sonnet-4.5
- claude-3-7-sonnet -> claude-3.7-sonnet (if in catalog) else passthrough
- claude-4.5-sonnet-high -> claude-sonnet-4.5 (effort stripped)
- already-canonical id -> unchanged
- auto -> auto

## Commit
feat(kiro): normalize versioned model slugs to canonical ids (gateway parity)
