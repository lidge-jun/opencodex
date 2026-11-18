# 000 Plan: Aside/Prime developer role and DashScope rejection (#8864)

Aside and Prime send their system prompt as `developer` because the opencodex export never tells them not to, and DashScope (Alibaba Token Plan) rejects that role with a 400 that the proxy reports only as "The provider rejected the request." This unit makes the Aside and Prime exports carry the same developer-role statement Pi has had since #5674, records the fold on both Alibaba presets so any native Chat client is covered, and names a developer-role rejection to the client and in the request log without copying upstream text. Users of Aside or Prime on any destination, and native Chat clients on Alibaba Token Plan, stop hitting the 400; anyone who still hits a role rejection elsewhere sees what to change. Research: [001_research.md](001_research.md).

## Loop spec

- Loop archetype: satisfy-spec, four work phases, docs-first.
- Trigger: lane packet ocx-8864-aside-developer-role and the user's rulings of 2026-11-17 (C1 scope, C2, amended C3).
- Goal: C1-C5 of the goalplan (`cxc loop show --session 01a1e8a0-1729-7693-93c6-d77bf96163ea`).
- Non-goals: copying upstream error text anywhere; session affinity for Aside/Prime; the `alibaba` Coding Plan preset and other unrecorded presets; Responses inbound wording; public error-schema changes; real home state; merge, rebase, lane=all CI, issue comments.
- Verifier: per decade doc; final gates in 030.
- Stop condition: PR open against dev with required checks completed on the exact final head, or a decision.request if C3 needs a schema change.
- Memory artifact: this unit, the goalplan and ledger under `.codexclaw/`, and the PR Verification section.
- Expected terminal outcomes: DONE (C1-C5 evidenced); NEEDS_HUMAN (schema decision or Morph unavailable); BLOCKED (repeated external failure).
- Escalation: decision.request for any public error-schema change; Morph subagent unavailability stops and reports.
- Resource bounds: none stated; host limits apply. Tool scope: local repo, gh for this PR only. Write scope: files listed in 010-030.

## Constraints

- Error-detail invariant (`structure/data-planes/error-detail.md`) wins: closed codes, proxy sentences, no upstream text.
- File-size ratchet: none of the touched source files are in `tests/fixtures/file-size-baseline.json` (checked with rg); new tests go in sibling files.
- New test files register in `scripts/test-layout` and a `tests/fixtures/test-layout-expected*.json` shard as `tests/test-layout*.test.ts` require.
- Subagents run on codex / morph/morph-dsv41flash-1017 / high via GOAT task.create.

## Work-phase map (dependency order)

| Phase | Doc | Depends on | Criteria |
|---|---|---|---|
| wp0 roadmap (this cycle, docs only) | 000, 001, 010, 020, 030 | none | none |
| wp1 export and registry fix | [010_phase1_export_registry.md](010_phase1_export_registry.md) | wp0 | C1, C2 |
| wp2 developer-role rejection diagnostics | [020_phase2_role_rejection_diagnostics.md](020_phase2_role_rejection_diagnostics.md) | wp1 (shares the developer-role vocabulary and the test domain registrations) | C3 |
| wp3 verify and deliver | [030_phase3_verify_deliver.md](030_phase3_verify_deliver.md) | wp2 | C4, C5 |

wp1 precedes wp2 because wp2's client sentence names `foldDeveloperRoleToSystem`, which is only accurate once the Alibaba presets record it, and because both phases add test files to the same layout shards.

## Architect consultation

Recorded in [002_architect.md](002_architect.md).


## Status

- wp0 roadmap: locked after architect reflection and audit round 1 (GO-WITH-FIXES, blockers=0, all findings folded). Implementation starts in wp1 from 010.

