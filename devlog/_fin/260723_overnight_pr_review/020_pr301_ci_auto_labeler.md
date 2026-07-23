# 020 — PR #301: ci: PR auto-labeler + auto release notes
- **Author:** Wibias
- **Sol Review:** Sartre — VERDICT: FAIL (1 high, 2 medium, 2 low)
- **Decision:** REBUILD_ON_DEV

## Key Issues
1. High — Depends on nonexistent `chore` label (addLabels will fail)
2. Medium — `--generate-notes` changes release note range behavior (not drop-in replacement)
3. Medium — Label mutations race against title edits, overwrites manual labels
4. Low — Permissions broader than necessary
5. Low — No contract tests

## Rebuild: create required labels first, explicit range with --notes-start-tag, refetch live title before mutation
