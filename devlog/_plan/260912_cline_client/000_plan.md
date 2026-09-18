# Cline integration roadmap

Cline users need a reversible connection and routed model list. This unit connects the current Cline CLI storage contract through the existing integration operations and dashboard. Cline stores connection settings and the model catalog separately, so one operation must snapshot and restore both files.

Loop: satisfy-spec, HOTL; trigger: #4214 and delegated lane=cline. Scope: config exporters, integration writer/reader/journal projection, existing CLI/catalog/dashboard registries, translated copy, source fixtures. Non-goals: legacy extension storage migration, Cline process control, user configuration changes during development, merges/releases, new dependencies. All local product suites, builds/typecheck/install are NOT RUN by instruction; regression execution belongs to final-tip GitHub hosted CI. Text checks and independent source audits are allowed. No user token/time/agent caps; existing tool/account scope only.

Outcome: DONE requires source-backed contracts, actual implementation, separate PABCD cycles, independent reviews, final cumulative head CI, PR and durable handoff. Unavailable tools or genuine external blockers are recorded without claiming completion. Main implements; inherited read-only subagents review. Native architect role selection is unavailable; the explicit parent instruction authorizes supported spawn for actual design and reflection reviews. No role installation or settings changes.

Sources: [001_contract.md](001_contract.md). Repository owners: src/clients/config-export.ts, src/integrations/{registry,state,writer,journal,store,config-io}. Existing config builder, exact fragment ownership, atomic file writes and journal are reused. No-op/manual-only configuration cannot meet sync/undo; a separate standalone configuration engine is unnecessary.

| Cycle | Deliverable | Dependency | Design |
| --- | --- | --- | --- |
| roadmap | Audited docs only | none | This roadmap and all decade docs |
| contract | Pure Cline documents, paths, paired journal adapter and regression fixtures | roadmap | 010_contract.md |
| surfaces | Catalog refresh, CLI help and existing dashboard exposure | contract | 020_surfaces.md |
| verification | Independent audit, fixes, PR publication and final-tip hosted CI | surfaces | 030_verification.md |

PR decision: one cohesive Cline PR unless the audited paired-file foundation is independently useful and large enough to split. Ordinary manual chain only if split; no native stacks. Intermediate commits may be pushed without waiting on CI. Parent owns merge.

Verification: git diff --check (text only), source review, final-head Cross-platform CI (tests/typecheck/GUI build/lint). Source tests use temporary home/store; no real Cline data. Fixture cases: missing/partial install; malformed, non-regular or foreign edited files; wrong version; foreign provider preserved; owned model removal/port change; second-file failure; bookkeeping failure; interrupted transaction and drift; exact two-file restore including absence. A Cline restart is required after externally written catalogs. Live client process behavior is source-backed, not a claimed local canary.

Public source docs update structure/clients/integrations.md plus CLI/UI owning docs for changed surfaces; public user workflow resides in docs-site. Unreleased security analysis stays under .tmp/cline. Durable handoff: .tmp/cline/handoff.md.

Design reflection: ALIGNED D09/D10. R02 accepted: no unattended Cline refresh; explicit sync only with stopped-client precondition. R03 accepted: journal presence never blesses a mixed pair or inconsistent ownership. Verify both intended bytes and final record before clearing a committed marker.
