# Catalog protection replacement series

Catalog refresh must preserve routed models when the driving configuration cannot authorize their removal. This series carries public PRs #6530 and #6537 into four reviewable changes: removal admission, writer ownership, bounded audit, and owner healing. Each layer retains its own regression proof and ordinary pull request.

Loop: satisfy-spec, triggered by next-release source refinement. Goal: publish attributed replacements with complete source accounting. Non-goals: merge, source closure, release, live runtime/account changes, native stacks and unrelated edits. Stop: all four PRs published with focused proof and inspected hosted checks; missing native or broad evidence remains explicit and draft. Artifact: this numbered unit and ignored lane evidence. Outcomes: DONE when that publication contract holds; unresolved behavior stays unresolved rather than silently dropped. Escalation: scope or authority expansion only. Resources: no user token/time budget; concurrent lanes prohibit full/changed local suites; one local test process at a time, no paid upstream requests.

## Source and build order

Baseline: dev `0818ea1812a028e1c14cd0b0511b44863407bc52`. Sources refreshed: #6530 `451bcd43e078d811b2bef0455000d48964bb06cd`; #6537 `8e50608319dcd5180e43fa2b9377ed4b3702127b`. #6537 contains #6530; carry once. Source author: `lcxhh521 <59329914+lcxhh521@users.noreply.github.com>`.

1. wp0 locks this roadmap, docs only.
2. wp1/A1: `010_routed_removal.md`, branch suffix a1, base dev.
3. wp2/A2: `020_owner_intent.md`, branch suffix a2, base A1.
4. wp3/A3: `030_write_audit.md`, branch suffix a3, base A2.
5. wp4/A4: `040_owner_healer.md`, branch suffix a4, base A3.

Use ordinary manual dependent PRs. A2/A3 remain separate because intent and owner admission can be correct without audit output. No admission timer. Source-of-truth owner is structure/codex-home.md; review mapped dependent docs, updating only changed local explanations.

## Verification

`bun run typecheck` observes src through tsconfig; baseline initially failed because dependencies were absent, then the locked Bun postinstall needed execution. The dependency lock remains unchanged. Each slice runs explicit test files listed in its decade doc, `bun run structure:check`, `bun run privacy:scan`, `bun test tests/test-layout.test.ts tests/test-layout-tooling.test.ts`, and `bun scripts/file-size-ratchet.ts`. No raised ratchet, removed assertions, or fake passing checks. `.github/workflows/ci.yml` uses pull_request without a base filter; per-PR CI is expected. Native Windows and installed Desktop behavior are not established by local Bun tests.

## Consultation and evidence

Read-only architect proposal/reflection and independent review are recorded when returned. Fresh leaf contexts use requested gpt-6.1-sol; family-level independence is not claimed. Runtime owners remain existing K serialization, config C lock, convergence and journal; do-nothing/config-only options cannot enforce cross-writer admission. No new service or configuration flag is needed.

## Status

Roadmap drafting; implementation not started.

Architect decisions A1–A4 accepted. Four layers preserve independent review; metadata audit remains separate from admission. Main amendments: preserve legacy journals only when readable and structurally valid; unknown evidence refuses without takeover. Owner publication changes notify a small catalog-owned observer, never import the healer; successful empty publication and restore update the baseline. Missing/corrupt catalog repair remains outside the source behavior and is explicitly not claimed. Healing rechecks stop/gates at publication using the existing admission callback where available; no new remote requests beyond ordinary mocked convergence in tests. Architect handle recorded in ignored evidence; reflection pending on this revision.

Architect reflection: ALIGNED A1–A4 after audit-coordination and partial-publication baseline amendments. Main accepted both; no remaining material design gaps reported. Baseline typecheck, structure:check, privacy:scan and file-size ratchet now pass after locked dependency preparation. Independent roadmap audit pending.

Roadmap audit closed: one High retry-state gap accepted and fixed as A4-R1; same reviewer re-audited PASS, architect ALIGNED. Docs-only outcome: four separately reviewable layers, no production edits. The next cycle implements A1 from 010 with source regression coverage. Publication and broad/native behavior remain unproven.
