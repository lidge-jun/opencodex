# Cache lane roadmap

Three independent fixes address optional helper admission, final OpenCode Go conversation affinity, and explicitly enabled Claude instruction stabilization. Hermes cache observations are investigated separately: missing inbound identity is not proof of proxy loss, and a shared prefix is not a conversation.

Satisfy-spec HOTL, triggered by the authorized cache lane assignment. Scope: PRs #4118/#4050/#4052 and issue #3433. No local tests of any size, build/typecheck/install, service changes, merges, closures, releases, workflow or permission changes. Commits and --no-verify pushes plus ordinary PR creation are authorized. Existing tool/account scope only; no user-set time/token/agent cap. Main implements; inherited-model subagents review. Native architect selection is unavailable; supported independent design review records that limitation.

Verification: git diff --check for textual integrity; independent source review; GitHub hosted Cross-platform CI at each independent final PR tip. Local product checks are NOT RUN. Source/applicability checks do not prove runtime behavior. Stop after concrete dispositions, final hosted evidence and durable handoff; field evidence or review/access gaps remain explicit, never a false fix. Tool gate denial is reported without bypass. Two failed independent reviewer contexts return work to main; implementation remains main-owned.

Existing layout: src/server (wire bridges), src/claude (translator), src/providers (Go transport), tests/{responses,providers,claude-integration,codex-integration}, structure (contracts), docs-site (user guidance). Reuse these owners; no new framework or runtime abstraction.

Work phases, each a full P-A-B-C-D cycle:
- roadmap: docs only; lock all following plans.
- claim: 010, independent dev PR for #4118.
- affinity: 020, independent dev PR for #4050; prerequisite request-lane allocator is already on dev.
- prefix: 030, independent dev PR for #4052 with an actual default-off configuration boundary.
- hermes: 040, independent contract evidence for #3433, no invented identity.
- verify: 050, inspect hosted results, repair confirmed scoped failures in added cycles, hand off exact heads.

The implementation order is a work ledger, not a false PR dependency. No native stack requested. Each independent PR is its own final tip. A repair that depends on a delivered implementation may be a child layer.

Source inventory and raw latest GitHub evidence stay in .tmp/cache-handoff/. Public source PRs are the provenance; measurements are author-reported and are not reproduced here. Unpublished security notes stay in scratch. Source ownership updates accompany each actual patch.

Design disposition: accept CACHE-D01 through D05. D04 uses the existing Claude configuration argument as its single control; no separate conflicting translator option. D05 covers underscore session_id and hyphenated session/thread pair separately. Native architect role not selected; inherited supported subagent performed actual design review.
