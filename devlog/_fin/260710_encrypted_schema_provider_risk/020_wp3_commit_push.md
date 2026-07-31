# WP3 — Commit hygiene + push (C1)

Goalplan: `ship-remaining-encrypted-marker-hardening-anthro` (wp3, criteria c4/c5).

## Plan

1. Stage ONLY `src/adapters/anthropic.ts` + `tests/anthropic-tool-schema.test.ts`
   (`git add` with explicit paths). Both files contain ONLY wp1 changes — they
   were not in the user-WIP modified set at session start, so no hunk splitting
   is needed.
2. Verify staged diff: `git diff --cached --stat` lists exactly the two files;
   `git status --short` still shows all user WIP as unstaged/untracked.
3. Commit: `fix(anthropic): strip Codex's Responses-only encrypted marker from
   tool input_schema (#85)` — mirrors e335e843's message style.
4. Verify: `git show --stat HEAD` lists only the two files (c4).
5. Push: `git push origin dev` — expect fast-forward incl. e335e843 + new
   commit (c5). If rejected (remote diverged): fetch, inspect, retry
   fast-forward only; never force-push. Persistent rejection → BLOCKED.

## Out of scope

devlog/ and .codexclaw/ are gitignored (verify; exclude if not). No version
bump, no GitHub issue actions, no other files.
