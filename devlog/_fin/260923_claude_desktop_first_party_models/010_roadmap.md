# 010 — Roadmap and decisions

Status: locked at the end of wp1 (reviewer PASS, architect ALIGNED on revision r2).

Order follows the build dependency: the binding has to resolve on the request path before any
surface can edit it, and the live proof needs both.

1. wp2 — storage, request-path resolution, API, CLI, dashboard, docs ([020](020_wp2_first_party_bindings.md)).
2. wp3 — live Desktop proof with screenshots and the PR ([030](030_wp3_live_proof_and_pr.md)).

## Architect proposal (handle 01a0cda6) and dispositions

| ID | Proposal | Disposition |
| --- | --- | --- |
| D1 storage | New `claudeCode.intercept.modelMap`; global `modelMap` stays untouched | Accepted. |
| D1 plumbing | Build a shallow `{...config, claudeCode: {...}}` copy in serve-options for intercept requests | Amended. A config copy can reach `saveConfig`/live-reconcile helpers keyed on the config object and would persist the merged map. Instead serve-options passes `claudeIntercept: true` to the two handlers, and the handlers derive a request-scoped `claudeCode` view (`claudeCodeForIngress`) that only the model-resolution calls read. |
| D2 matching | Reuse `resolveInboundModel` unchanged (exact, date-stripped, `[1m]`, `--fast`) | Accepted; the view overlays `modelMap` so every existing rule applies. Amended after audit round 1: intercept targets written as `native/<slug>` are normalized to the bare slug inside the view, because `resolveInboundModel` returns map values verbatim; global `modelMap` values are not normalized. |
| D3 surfaces | CLI `bind`/`unbind`, API, GUI first-party card, schema, docs | Accepted with a dedicated `PUT /api/claude-desktop/first-party-bindings` route instead of widening the gateway profile PUT, which carries conflict checks unrelated to bindings. The CLI drives that route so the running proxy adopts the change immediately. |
| D4 constraints | No capped file touched; register any new test file in both layout maps; lab boundary untouched | Accepted. |
| D5 honesty | Show "picker id → served route"; never claim the Desktop label changes | Accepted; docs and GUI copy say the picker keeps Anthropic's label. |
| Risk (c) | A picker id that is also an alias resolves alias-first | Accepted as is; picker ids are genuine Anthropic ids. |
| Risk (d) | Picker ids can change | Documented; the dashboard offers the observed ids as suggestions and accepts any `claude-` id. |
