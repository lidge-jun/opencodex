# 050 — PR #299: ci: issue translator workflow
- **Author:** Wibias
- **Sol Review:** Sartre — VERDICT: FAIL (1 high, 2 medium, 3 low)
- **Decision:** REBUILD_ON_DEV

## Key Issues
1. High — No deterministic translation-before-dedup sequencing
2. Medium — Job-level concurrency not reliable whole-workflow lock
3. Medium — Prompt injection can produce trusted-looking bot content (title mutation)
4. Low — Permissions correctly minimal (best of the three PRs)
5. Low — Idempotency generally sound
6. Low — No adversarial tests

## Rebuild: combine with deduplicator, workflow-level concurrency, require maintainer label before title mutation, BOM removal
