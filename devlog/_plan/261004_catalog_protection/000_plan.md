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

A1 implementation: complete #6530 production carry; added seeded cache-byte preservation for missing/enabling/unreadable/salvaged configuration. Before source changes, targeted incident cases gave 2 pass/6 fail; after changes six focused files gave 107 pass/0 fail (555 assertions). Typecheck, structure and privacy pass; layout/tooling/ratchet group 27 pass/0 fail. Existing tests resolved the installed Codex CLI for read-only version/catalog observation; no installed runtime was restarted or modified, and no paid/live provider acceptance is claimed. Final independent code review is pending.

A1 independent implementation/security review PASS with no actionable findings. Restore regression file also passes (see ignored command log). A1 is ready for draft publication; wider hosted and native evidence remain required before integration.

A1 published as draft #6553, head e46a6936909f1bf89898a7b67ceb4b1fcee2ae09. Hosted Cross-platform CI run 37169942164, pull_request event, attempt 1, completed success at that head. Native-scoped jobs not selected by its path filters remain unexecuted, not passing native acceptance. Later dev movement was the separate 2.78.0 version opening; this lane retains its recorded source baseline and no version edits.

A2 completed locally: writer/core 170 pass; ownership/lifecycle/journal/restore/removal/API set 150 pass; repair batch 57 passing and four failed test-injection attempts corrected by installing the filesystem spy before module import, then all four injected EPERM cases passed with exactly one denied unlink. Typecheck, structure, privacy, ratchet and 18 layout guards pass. Independent reviewer resolved two restore-release findings and returned PASS. Intentional changed-profile preservation and failure compensation remain distinct. A2 retains all useful source ownership/intent/no-op behaviors, with unknown evidence now refusing and corrupt journals preserved rather than deleted.

A2 published draft #6558 at b7793b5e73fe9b3a9fd696b848d8ec69768428a7, base #6553. Current-head pull_request CI 37171092833 started. A3 P consumes 030 final C1–C5 design: actual A2 serializer still owns K, live permit context and foreign/unknown refusal, so the reviewed insertion points remain applicable. Architect reflection ALIGNED and independent A3 audit PASS are recorded in 030; no design amendment is needed at entry. Previous D directs bounded audit next.

A3 verification: new audit suite 28 pass; integrated audit/intent/owner/serialization/convergence/retained set 133 pass, 0 fail. Typecheck/structure/privacy/ratchet pass; layout guards 18 pass. Privacy fixture changed to generic example home and focused projection case passed. Independent implementation/security review PASS, no findings. Contention proof uses separate SQLite connections; native Windows and live installed acceptance remain unverified. Next cycle implements owner healer from final 040.

A3 published draft #6560 at 0d13d9a3ee26983a55186581adf293e175695911, base #6558. Current-head pull_request CI 37171843941 started. A4 revalidation consumes final 040 H1–H4/R1: A3 writer still returns explicit written/unchanged/refused results, management convergence retains its lifecycle parameter, and native restore has a committed native boundary. Approved observer/guard insertion points remain applicable; no timer enters admission. Previous D directs A4.

Steering: after A4 checkpoint, refresh the entire manual chain onto dev87e3156339, carrying its existing four-file 2.78.0 version pre-move unchanged. Cascade all dependent heads and require actual per-PR current-head checks. This narrow upstream-base refresh supersedes the earlier boundary against version-file movement; no new version policy or release changes are made.

A4 local verification: 53 new tests and 213 adjacent regressions pass; typecheck/structure/privacy/ratchet/layout18 pass. Independent review's three recovery findings were fixed with target binding, file-config authority and unavailable-journal state preservation. Final coverage fix moved expected-path assertion outside the caught convergence callback; focused assertion test passes. Source #6537 healer behaviors are retained with explicit idle gate and release fences. Proceed to chain refresh after checkpoint; no merge/release action.
