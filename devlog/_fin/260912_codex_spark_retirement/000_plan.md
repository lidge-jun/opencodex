# Spark retirement preparation

Prepare an unmerged draft PR for removing GPT-5.3-Codex-Spark after its announced retirement. Tibo's September 11 announcement says next week, without an exact cutoff. Deployment timing stays with the maintainer; this branch contains the future removal and must not be merged now.

## Loop contract
- Archetype: satisfy-spec; trigger: user requested complete Spark removal PR including usage quota and UI.
- Goal: one cohesive retirement patch covering membership, quota/route semantics and settings/UI.
- Class: C3 with C4 care for quota isolation, persisted evidence and management settings.
- Non-goals: no merge/auto-merge/deploy/live config changes; no historical usage deletion; no Meta Muse Spark or vendor snapshot retirement.
- Verifier: exact-head Cross-platform CI and independent source review. Local product tests/typecheck/build/install NOT RUN by user instruction. CI workflow runs the relevant Bun tests and gates. UI evidence must be a genuine rendered screenshot, not a waiver invented by the agent.
- Stop: correct reviewed Draft PR, complete head-specific CI with no failures or pending required jobs, remains unmerged.
- Artifact: this unit, 001_source.md, 010_implementation.md, 020_review.md, 030_delivery.md.
- Outcomes: DONE means draft delivery, not retirement deployed. Source-date uncertainty must stay explicit. No invented budget.
- Delegation: inherited model/effort only; independent read-only scout/auditor and three disjoint implementation lanes. Main coordinates, reviews and delivers. Native architect role is not exposed; ordinary inherited read-only source review is recorded as such, not claimed to be that registered role.
- Escalation: investigate actual correctness conflicts; reclaim remaining work only after inspecting failed agent state. No shared role configuration edits.

## Single work-phase
One P-A-B-C-D cycle for a single user-visible outcome. Backend, API and UI are subtasks in dependency order; no partial retirement can be considered complete alone. This avoids the previous task's retrospective phase attestations.

## Decisions
D1: remove Spark native membership AND add the exact slug to the existing retired set. Preserve unknown/new account-native observations.
D2: remove Spark-only quota collection, routing scope and show/hide preference. A narrow tombstone for old persisted Spark quota rows is allowed; such evidence must neither display nor affect shared/Reserve capacity. Do not delete generic custom windows.
D3: reject or ignore retired Spark response quota evidence so it cannot be reclassified as shared account quota.
D4: preserve shared/Reserve affinity, account selection, probe leases and cooldown isolation. Replace old Spark positive-control tests with existing Reserve/shared coverage or real retirement negatives, not blind slug substitutions.
D5: remove Spark compatibility branches where exclusive to Codex Spark; preserve general Responses Lite, namespace scrubbing and other-provider behavior.
D6: remove GUI toggle/state/i18n/CSS and settings API/type/schema field together. Old config documents remain loadable; a legacy-only settings update must not revive the switch.
D7: preserve historical costs/benchmark data/vendor slugs and maintained general fixtures; document each remaining active-source Spark match.

