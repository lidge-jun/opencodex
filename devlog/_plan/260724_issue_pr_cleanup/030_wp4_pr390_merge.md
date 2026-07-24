# WP4 — #390 → #382 merge (030)

PR #390 `fix(codex): clear stale weekly quota on WHAM/header refresh` closes
issue #382 (30-day primary-only Codex Auth account showing stale weekly +
30-day simultaneously).

State at plan: draft=true, MERGEABLE/CLEAN, all CI green (macos/ubuntu/windows +
npm-global matrix + react-doctor pass; CodeRabbit skipped as draft).

Files: `src/codex/auth-api.ts` (+12/-25), `src/codex/quota.ts` (+120/-0 new),
`src/server/responses/core.ts` (+7/-19), `tests/codex-auth-api.test.ts` (+39),
`tests/rate-limit-reset-credits.test.ts` (+141).

Security note: touches auth/quota path (`src/codex/**`) — verify no credential
logging/serialization, quota parse is fail-closed, no auth escalation.

Actions:
1. A-gate: Sol reviewer reads the diff, confirms the stale-weekly clearing is
   correct for primary-only 30d accounts, no regression to weekly-bearing
   accounts, and the security boundary is clean.
2. `gh pr ready 390` (mark ready so CodeRabbit + non-draft gates run) — or merge
   directly if maintainer pre-approval covers draft merge. Prefer ready first.
3. Re-check mergeable + CI, then `gh pr merge 390 --squash` targeting dev.
4. Verify: `gh pr view 390 --json state,mergeCommit`; #382 auto-closed or close
   with reference.

Ordering: #390 merges BEFORE #394 (both touch `src/server/responses/core.ts`);
#394 rebases after.

Terminal: DONE = merged SHA + #382 closed. BLOCKED if CI regresses on ready.
