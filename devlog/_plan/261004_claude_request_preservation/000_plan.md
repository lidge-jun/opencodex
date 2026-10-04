# Claude request preservation replacement roadmap

Native Claude requests need consistent OAuth tool names, client compatibility and pool dispatch without losing caller content. This unit separates those runtime contracts from the preference that selects them. It refines public sources #6533, #6534 and #6547 into a manual PR chain; source closure remains coordinator-owned.

## Loop specification
- Shape/trigger: satisfy-spec, assigned next-release Claude lane.
- Goal: focused published replacement PRs with complete source behavior accounting and real-author attribution.
- Non-goals: merges, release/version changes, installed runtime writes, account/credential changes, live upstream traffic, source closure, native stacks, unrelated work.
- Verification: focused Bun behavior tests, typecheck, structure/privacy/layout/ratchet gates; GUI tests and observed render for preference; docs build for docs changes. Full/changed local suites excluded by explicit concurrent-release resource contract; wider coverage belongs to current-head hosted CI.
- Stop: all replacement PRs published, independent review addressed, current-head CI inspected, residual native/live gaps honestly draft-bound.
- Artifacts: this numbered unit; ignored `.tmp/claude-lane/` stores source snapshots, verification logs and non-public security reasoning.
- Outcomes: DONE = publication and complete accounting; unresolved evidence stays explicit/draft; blocked capability is reported without invented success.
- Escalation: scope/authorization change or unavailable indispensable capability. Existing scoped commits/push/PR creation are authorized.
- Tool/credential scope: repository filesystem, GitHub repository reads and scoped branch/PR writes, fake/local test endpoints. No real provider credentials or paid upstream calls.
- Token/cost/wall-clock bounds: no user numeric budget supplied; do not invent one. Managed short-yield commands and bounded leaf tasks; keep work within the requested scope.

## Baseline and topology
Base `0818ea1812a028e1c14cd0b0511b44863407bc52` from refreshed dev. Sources: #6533 `8e5c78912222b1616709d664c23de254dd71b7c9`; #6534 `829b203b3e65530a4cdaaa121f2da15484c2c9b7`; #6547 `5f3cf4ed0b4a63604133863442002fb9ac824b16`. Original author: Claire Novotny <claire@novotny.org>. Inherited tool/pool commits are consumed once, never blindly cherry-picked cumulatively.

| Cycle | Output | Dependency |
| --- | --- | --- |
| wp0 | Docs-only reviewed roadmap | none |
| wp1 | B1 typed references and inline tools | roadmap |
| wp2 | B2/B3 client compatibility and pooled native dispatch | B1 |
| wp3 | B4 preference, defaults, API, GUI | B2/B3 |

Existing owners: `src/adapters/anthropic/` shapes the wire; `src/oauth/anthropic-routing.ts` owns pool selection/health; native server modules own physical dispatch; `src/protocols/settings.ts` owns policy resolution; pool settings capability and management routes own validated writes; the existing Anthropic pool component owns UI. Reuse these paths and existing tests. No alternate pool or retry engine.

## Consultation
Read-only architect proposal/reflection and independent audit recorded before implementation. Every later P revalidates its decade document against current parent tip. Leaves are scoped to disjoint files and never branch or run goals/FSM.

Architect handle: 01a10493-1a9a-73d2-96f9-86ef0df9518d. Main accepts CL-A01/A05/A08; amends CL-A02 duplicate carries, CL-A03 session priority, CL-A04 lease-before-charge, CL-A06 malformed protocol salvage, CL-A07 CSS sibling and CL-G01–G04 route race/raw malformed/help/preview coverage. Reflection requested on amended roadmap.
Architect reflection on amended roadmap: ALIGNED; all CL-A02/A03/A04/A06/A07 and CL-G01–G04 resolved. Independent audit remains required. No implementation evidence claimed.
