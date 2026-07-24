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
| #355 | Gemini inline image output | REBUILD_ON_DEV (Hegel): conflicts with terminal-truth google.ts rewrite; modality scope too broad; 2 deterministic test breaks; memory/privacy bounds | DEFER — detailed review posted as PR comment (issuecomment-5065271325) | comment posted |
| #336 | v2 Fernet guard hardening | MERGE_AND_IMPROVE (Huygens): explicit security review clean (structural Fernet classifier, no key handling, no ciphertext echo, management API still hasApiKey-only); residual = ja/ko/ru docs stale | MERGE_AND_IMPROVE — merged fd7e97e1, then locale docs synced to fail-fast contract | MERGED + improved |
| #337 | GUI auto-switch threshold | not reviewed (gui/ boundary) | DEFER — gui/-touching PR requires fresh explicit user approval per loop boundary | reported to user |
| #358 | GUI provider discovery/fallback UX | not reviewed (gui/ boundary) | DEFER — gui/-touching PR requires fresh explicit user approval per loop boundary | reported to user |

Non-dev-target PRs noted during triage (outside loop scope): #365 (draft,
main-target, already marked WRONG BRANCH), #339 (main-target, needs
retarget by author).
