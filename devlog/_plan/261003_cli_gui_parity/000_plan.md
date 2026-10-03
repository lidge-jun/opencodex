# Make dashboard workflows usable from the terminal

OpenCodex already implements many dashboard operations in its CLI, but discovery omits working commands and several workflows expose only some GUI fields. This unit completes the eligible task gaps, makes existing commands discoverable, and gives the shipped ocx skill verified task recipes. Operators keep the same management validation and consent boundaries, with explicit local/live target selection where those effects differ.

Reader: maintainers reviewing the six-layer manual PR stack; they need the scope, exact command contracts and proof for each layer.

## Loop contract

- Archetype: satisfy a fixed, source-audited task inventory, followed by residual accounting.
- Trigger: user requested near-GUI CLI parity, improved shipped skill, inherited-model subagents, repeated PABCD and a published stack.
- Goal: every eligible GUI task has a named command/sequence, useful help, safe output, documented target and behavioral evidence; genuine exclusions and duplicate views remain explicit.
- Non-goals: GUI redesign, provider routing redesign, new auth authority, raw API/config escape hatches, live-user operation, native GitHub stacks, merging, release or deployment.
- Verifier: numbered phase acceptance tests plus the baseline/QA strategy in 003_verification_strategy.md; a docs checker observes these exact plan files and task ownership before B.
- Stop: six open, reviewable PRs with successful current-head hosted CI; all task ledger rows closed as verified, alias or justified exclusion, with no unexplained UNKNOWN.
- Durable artifacts: this unit, 008_task_ledger.json and ignored command/QA receipts under this session.
- Outcomes: DONE requires implementation, synchronized skill/docs, independent reviews and CI. Real unsupported prerequisites/authority are reported under host blocked rules; workload or compaction is not completion.
- Escalation: main resolves source/architecture conflicts; ask the user only for genuinely new authority. Failed delegates follow the bounded retry/retirement owner; do not swap models silently.
- Resources: no user token/cost/time cap. Tool scope is repository editing, isolated local fixtures and GitHub PR/CI for this repository. No real accounts, credentials, running services, paid upstream calls or destructive user files are QA targets.

## Baseline and source owners

Baseline dev is 9f89b7265b754eb681215ad327fc9459af37b9e1. The initial inventories contain 176 task-entry rows, with two additional embedded dashboard setting groups subsequently found (memory models and compaction routing). Duplicate entry points are retained as aliases rather than silently dropped. Source-coverage labels in 004/005 are not passing runtime evidence. Executable 010..080 decisions supersede earlier source-join syntax proposals; the private audit record retains their history.

The tree remains Bun TypeScript: src/cli owns domain handlers and pure help/capability data; existing server management modules own validation/live mutation; tests/cli plus domain server tests own proof; skills/ocx and docs-site own operating guidance; structure owns current contracts. Existing structure/manifest.json maps src/cli to runtime/config/integration/Desktop/release docs. Only affected owners are updated.

## Dependency-ordered work phases and PR layers

| Phase | Executable document | Dependency | Output / PR layer |
| --- | --- | --- | --- |
| wp0 | This roadmap, inventories and UX contract | none | Docs-only audit; locks the remaining designs before source edits |
| wp1 | 010_discovery_foundation.md | wp0 | Pure metadata and generated-document capacity; layer 1 |
| wp2 | 020_existing_workflow_discovery.md | wp1 | Accurate existing task discovery and skill routing; finish layer 1 |
| wp3 | 030_provider_management.md | wp2 | Bounded input and exact provider live workflows; layer 2 |
| wp4 | 040_models_routing.md | wp3 | Models, picker order, combos and routing profile edits; layer 3 |
| wp5 | 050_accounts_runtime_settings.md | wp4 | Account policies, explicit auth options, agent/settings/v2 parity; layer 4 |
| wp6 | 060_integrations_maintenance.md | wp5 | Live Desktop profile, integration recovery, storage and Hub reads; layer 5 |
| wp7 | 070_observation_api_tools.md | wp6 | Timeline/log fidelity, scoped usage and chosen-key/audio tools; layer 6 |
| wp8 | 080_acceptance_publication.md | wp7 | Residual task proof, final skill/docs and all exact-head PR receipts; finish layer 6 |

Every work phase runs a full P→A→B→C→D cycle. wp0 is code-free. Later P revalidates its existing decade doc and quotes the previous D conclusion; changes to decisions return to the same architect before A. Branch names: codex/cli-parity-foundation → codex/cli-parity-providers → codex/cli-parity-models → codex/cli-parity-accounts → codex/cli-parity-integrations → codex/cli-parity-observation. The bottom targets dev; each child targets its open parent. No native stack registration or merge is authorized.

## Coverage and decisions

- 002_terminal_ux.md defines terminal behavior and progressive disclosure.
- 003_verification_strategy.md records real baseline checks and verification scope.
- 004_settings_coverage.md and 005_operations_coverage.md preserve field-level source joins.
- 007_architecture_decisions.md records proposal dispositions, additive field chain and target boundaries.
- 008_task_ledger.json assigns every row to a phase; historical labels are retained while current status/evidence advance.

Source comparison established that local provider/custom-model/v2/logout effects differ from live management receipts. --live is therefore explicit and never inferred from proxy availability or --json. Existing local behavior remains available. Browser-session identity actions stay outside automated parity; data-plane API testing is included with the same data-plane admission authority.

## Alternatives rejected

A generic API request command would expose routes without usable task contracts. Generic config writes would bypass existing live validation and completion receipts. A new command framework would duplicate the existing Capability/domain-handler architecture. Declaring routes that local commands never fetch would make coverage appear complete while remaining false. None is used.

## Phase records

wp0 roadmap was locked after independent audits passed. Inventory corrections already folded: existing v2 verbs are real local implementations, not absent agent verbs; model preset custom is disabled in the GUI; Lab local commands must not acquire fictitious HTTP coverage; memory-model and compaction-routing controls need explicit rows. Whole-plan architect reflection is ALIGNED at a095a4e514d6d8e5a37dbf05a66b2c9156ebaeeb28a8e0fb878bc76f931c27b1; the serializer and data-plane contract amendments were audited independently and passed. See 009_roadmap_lock.md.
