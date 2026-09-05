# Fast discovery and external exports

Class C3; one work phase (wp1), spec-satisfaction repair.
Trigger: Fast selectors require opt-in and do not reach pi/config exports.
Goal: default-on eligible Fast rows on discovery and every shared external export.
Non-goals: global fastMode changes, Ultra Fast, service deployment, new client protocols.
Verifier: GitHub Cross-platform CI on exact PR head; local tests and typecheck are prohibited by user. CI definitions in .github/workflows/ci.yml own runtime/typecheck checks. git diff --check observes the patch; no claim that it verifies behavior.
Stop: passing CI, independent review, authorized admin merge, fetched dev ancestry.
Memory: this unit and session-bound goalplan. Outcome DONE or evidence-backed external blockage.
Scope: existing repository credentials for branch push/PR/merge; no external account or service changes. Two-hour work phase, no paid external AI or additional resource spend. Subagents may inspect/audit and implement disjoint declared slices; parent reclaims after two distinct failed dispatches.

Existing structure: src/server/fast-row.ts owns selectors and canonical Fast eligibility; src/clients/config-export/ owns common metadata and client serializers; src/server/management/model-rows.ts and src/cli/opencode.ts own catalog projections. Reuse these boundaries; no dependency or UI changes. Source of truth: structure/09_client-integrations.md and docs-site configuration reference.

Omission means on; explicit false and malformed hand edits mean off. Native rows additionally require upstream speed-tier metadata. Real complete IDs win over synthetic selectors. Remote catalog authority must survive export without guessing from the local client config. Existing ordinary rows stay selectable.
