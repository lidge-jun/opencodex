# 260724 PR Triage — 000 Plan (Track B)

Part of goalplan `opencodex-dev-branch-hardening-loop-hotl-track-a`.
One PR at a time; each PR gets a Sol reviewer subagent report and an
explicit decision: MERGE_AS_IS / MERGE_AND_IMPROVE / REBUILD_ON_DEV /
DEFER / CLOSE. Merge authority: user (maintainer) pre-approved remote
merges for this triage scope. Boundaries: never main/preview; gui/-touching
PRs require fresh explicit approval (DEFER + report); CI green on head
before merge; decision records live here as numbered docs (010, 020, ...).

Queue (dev-target open PRs at loop start): #363, #360, #356, #355, #352,
#336. GUI-touching (DEFER unless user approves): #337, #358.

Decision log:

| PR | Title | Reviewer verdict | Final decision | Executed |
|----|-------|------------------|----------------|----------|
| #363 | Chat tool-call delta duplication | MERGE_AS_IS (Pascal): CI green, single-emit contract + full-frame compat + parallel index tests, clean merge | MERGE_AS_IS | MERGED affc477e 2026-07-24T01:07:45Z |
| #352 | account pool retry | merge-as-is quality (Kuhn); security-boundary note re: auth path | MERGE_AS_IS — security review recorded: auth-context fail-closed, no credential logging, no retry after HTTP 200/SSE, bounded single account switch; merge authority = maintainer pre-approval | MERGED beab5b3e 2026-07-24T01:07:48Z |
| #360 | oversized Responses call ID replay | MERGE_AS_IS (James): deterministic SHA-256 alias, collision-safe, paired call_id preserved, CI green, draft was procedural | MERGE_AS_IS (marked ready, then merged) | MERGED b77cdcb9 2026-07-24 |
| #356 | Codex shim auto-restore | REBUILD_ON_DEV (Hume): 2 High (concurrent restore launcher loss, mtime-only stability check) + 3 Medium (Windows mixed siblings, help-mutates-files, unbounded state read) | DEFER — detailed review posted as PR comment (issuecomment-5065160471); author/Wibias to rebuild on dev, then re-review | comment posted |
| #355 | Gemini inline image (draft) | REBUILD_ON_DEV (Hegel): conflicts with terminal-truth parser, modality scope too broad, 2 known test breaks, memory/privacy residuals | DEFER — detailed review posted as PR comment (issuecomment-5065271325) | comment posted |
| #336 | v2 Fernet guard hardening | MERGE_AND_IMPROVE (Huygens): security-clean (Fernet wire layout, no key handling, no secret logging); ja/ko/ru docs out of sync | MERGE_AND_IMPROVE — merged fd7e97e1 + locale sync commit d0825272 | MERGED |
| #337 | GUI auto-switch threshold | gui-touching — boundary rule | DEFER pending explicit user GUI approval | open, reported |
| #358 | GUI provider discovery UX | gui-touching — boundary rule | DEFER pending explicit user GUI approval | open, reported |
| #369 | kiro progress text nonterminal | MERGE_AS_IS (McClintock): CI green, real terminals preserved, compatible with bridge terminal exactly-once, regression tests RED-valid | MERGE_AS_IS | MERGED 2704747d 2026-07-24 |
| #366 | Cursor store:false continuity | REBUILD_ON_DEV (Hypatia): High isolation bypass, Medium UTF-16 slice vs byte cap, unproven same-id strategy, 27 commits behind | DEFER — detailed review posted as PR comment (issuecomment-5065520056) | comment posted |
| #368 | Go port (39k LOC draft, author lidge-jun) | CLOSE recommended by reviewer (Archimedes): parallel unverified runtime, no packaging/release linkage, CI flake | DEFER — owner's own draft experiment; close/keep decision reserved for user | open draft, reported |

Non-dev-target PRs noted during triage (outside loop scope): #365 (draft,
main-target, already marked WRONG BRANCH), #339 (main-target, needs
retarget by author).
