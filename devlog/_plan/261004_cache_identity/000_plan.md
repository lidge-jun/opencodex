# Two independent cache-identity fixes

Public callers can provide a conversation marker without the session header consumed downstream, while Devin currently allocates a trajectory for every turn. This unit prepares separate replacements for #6521 and #6488, preserving their useful behavior and adding deterministic identity/lifetime coverage. Maintainers use this record to review coverage and decide future integration; publication is the terminal outcome, not merge or release.

## Scope and completion

Satisfy-spec HOTL, triggered by the next-release cache lane. Class C4 for identity and credential scoping. First lock this docs-only roadmap, then execute `010_caller.md`, then `020_devin.md` serially on independent branches from dev. The serial order avoids shared-checkout branch collisions; neither runtime patch depends on the other.

Allowed: scoped local commits, pushes, two ordinary dev PRs, focused verification, read-only GitHub evidence and gpt-6.1-sol leaf implementation/review through the available V1 tools. Excluded: merges, release/version edits, installed-runtime changes, live upstream/account writes, source closure, branch deletion, native stacks, unrelated edits, outbound peer messages. Security working notes stay in ignored scratch. No token/cost or wall-clock budget was imposed; use local fixtures and ordinary PR CI only, no paid/live provider probes.

DONE requires published attached replacement PRs, source coverage and author trailers, passing focused regressions/static gates, independent review and inspected current-head CI. Missing broad/native/live proof keeps a draft with explicit limits. A material scope conflict returns to main for decision; external blockage is reported truthfully under host rules. Evidence lives in ignored lane scratch and goalplan receipts; public records contain only source provenance and outcomes.

## Source and verification

Baseline: `0818ea1812a028e1c14cd0b0511b44863407bc52`.
- #6521: `011ab507fcf03ae86933098de1994b25ecfd0495`, mayigululu-hash.
- #6488: `a0b199fc6b96367fb174f6488a7a45eb58eccd54`, Hanqing Zhao (@HQ1995).

Original live-cache measurements are author evidence in the source PRs, not new measurements or promised savings. Both source diffs were inspected; neither is an inherited stack. Read-only native membership queries returned empty lists.

Focused baseline command: `bun test tests/providers/devin-prompt-cache.test.ts tests/providers/xai/grok-session-identity.test.ts tests/server/loopback-listener-admission.test.ts`: 59 pass, 0 fail. Dependencies installed with `bun install --frozen-lockfile` (exit 0). Each implementation runs its named behavior tests, typecheck, structure/privacy/layout/ratchet and docs build. Full local and changed suites are impractical during concurrent lanes and release; broader platform coverage belongs to hosted PR checks. CI triggers on every pull request; feature pushes alone do not trigger the main workflow. No manual release workflow is needed.

## Consultation

Architect 01a10493-64d4-76c2-b14e-d1307ad82a43 proposed CS-01..04 and DT-01..04. Main accepts caller principal scoping and promotion before admission, while preserving the original request for Bun timeout ownership. Main accepts the bounded provider-local trajectory store and whole-wire field chain. Own thread headers outrank a parent-derived `_clientThreadId`; direct internal callers without a parent may retain that field as fallback. No idle TTL/logout integration is claimed: fixed capacity bounds retention and credential rotation creates a different key. The executable documents carry the decisions; same-architect reflection and independent audit are required before implementation.

Architect reflection: ALIGNED, with three test refinements accepted: exercise actual combo recall separation; parent-only/direct fallback/session aliases; double release after reacquisition and named retry wire continuity. Baseline typecheck, structure, privacy, layout (18 tests) and ratchet passed. The gate commands are repository scripts/direct test paths and observe the planned target classes. No broad suite was run.

Roadmap D conclusion: independent reviewer 01a1049a-9a43-7ee1-9e7a-58073e8eb9e7 found no blockers (VERDICT: PASS). Fresh-reader check understood answer, evidence, and next action without revision. The docs-only cycle locks the two independent plans. Next: execute caller, then Devin. No cache savings or runtime improvement has been measured in this cycle.
