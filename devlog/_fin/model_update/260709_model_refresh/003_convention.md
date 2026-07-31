# 003 — Recurring model-update record convention

- Every model-catalog refresh gets a NEW dated unit folder: devlog/model_update/YYMMDD_<slug>/
  (e.g. 260709_model_refresh, 260801_grok5_wave). Never edit old units; append new ones.
- Docs use LEXICO numbering: 000_plan (roadmap), 00X research docs (one per provider lane,
  every claim carries a source URL, OFFICIAL vs secondary marked, uncertainty marked UNVERIFIED),
  01X/02X phase diff docs, last doc = D summary with terminal outcome + evidence tails.
- Research lanes run as parallel read-only explorer subagents (gpt-5.5 default); the MAIN session
  writes the record docs from their findings.
- Registry changes require: official source for NEW ids; account-verified reality beats
  official-docs absence for OAuth-plan models; generated files only via their generator script.
- Prefer dynamic discovery (liveModels + fetchProviderModels TTL/stale-fallback) over static list
  growth; static arrays are the logged-out fallback seed.
