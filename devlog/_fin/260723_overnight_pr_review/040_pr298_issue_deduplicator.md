# 040 — PR #298: ci: issue deduplicator workflow
- **Author:** Wibias
- **Sol Review:** Sartre — VERDICT: FAIL (1 high, 4 medium, 3 low)
- **Decision:** REBUILD_ON_DEV

## Key Issues
1. High — No ordering contract between translation (#299) and deduplication
2. Medium — Prompt injection constrained but not neutralized (500 attacker-controlled issue bodies)
3. Medium — Inference action receives write-capable token (split permissions)
4. Medium — Missing `codex-deduplicate` label
5. Medium — Prompt size unbounded (402K chars theoretical)
6. Low — Wrong action input name (max-completion-tokens vs max-tokens)
7. Low — Failed inference treated as successful rescan
8. Low — Marker ownership too loose

## Rebuild: combine with translator workflow, split inference/mutation permissions, bound prompt size, create required labels, BOM removal
