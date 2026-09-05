# 010 Export catalog visibility

Loop: spec-satisfaction repair; trigger: selectedModels ignored by export projection. Goal: Pi/Aside export obeys the same provider allowlist, blocklist, pending selection as routed catalog. No change to full management catalog or routing authorization.

MODIFY src/server/management/model-rows.ts: import filterCatalogVisibleModels. In loadExportModels compute visible routed row identities from filterCatalogVisibleModels(rows.filter(row => !row.native), config); return only !row.disabled and (row.native || visible set contains row), then map toExportModel. Preserve native visibility semantics.
MODIFY src/cli/opencode.ts: use same canonical filter once for rows with non-native provider/id identity, then exclude those not retained before seen.add. Do not infer provider identities for legacy rows missing them; keep existing disabled and Direct-native checks. Preserve order, custom/combo aliases and per-row metadata; do not duplicate allowlist matching.
MODIFY tests/server/management-client-config-route.test.ts and tests/cli/cli-export-command.test.ts: fixtures with xai selectedModels=[grok-4.6], full three-model roster, blocklist override, empty allowlist, slash-bearing ids, disabled duplicate. Render both pi and aside through production loader and CLI projection. Expect only selected ids; management still offers all ids.
MODIFY docs-site/src/content/docs/guides/integrations.md: explain selected list applies to generated catalogs.

Verifier: standalone synthetic imports of loadExportModels/exportModelsFromProxyRows plus Pi/Aside serializers; no bun:test. CI runs existing focused regressions, typecheck and full platform suite. Before C record exact source SHA and probe output. Stop after export boundaries agree; next cycle refreshes old owned files.
