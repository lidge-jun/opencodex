# 260802 2.8.0 Bugfix Loop — 000 Research

Date: 2026-08-02. Root-cause investigations for the six open 2.8.0 bug
issues, produced by six investigator subagents against local dev (e52f4a9e).
GitHub issues: #858, #855, #859, #864, #857, #848.

Local sync note: local dev is ahead 27 / behind 9 vs origin/dev; a
`git pull --rebase` was aborted because another session's docs commit
(7fdb2cb8) conflicts with incoming docs. Bug areas are untouched by the 9
incoming commits, so fixes proceed on the local head; the sync is the
owner's pending decision.

## Summary of root causes

| Issue | Root cause (file) | Fix shape |
|---|---|---|
| 858 | `src/storage/cleanup.ts:571-586` never reads `is_pinned`; filesystem-only selection + locked reload both ignore pins | select is_pinned via columnExists; exclude in preview/exact/policy; re-check under BEGIN IMMEDIATE |
| 855 | `src/codex/catalog/sync.ts:474` treats absent-provider rows as foreign and preserves them (both gather branches) | ownership signature on `description` prefix; drop OCX-authored rows whose provider is gone |
| 859 | `ocx claude desktop apply` builds the alias reverse-map only in the short-lived CLI process; serving daemon never rebuilds it (static mode never calls /v1/models) | route apply through the authenticated management API so `writeDesktop3pConfig()` installs the map in the daemon |
| 864 | v2.7.43 image_gen aliasing forces `needsClientRewrite`, pushing Windows onto the Bun#32111-unsafe pull/tee SSE chain; terminal block never reaches the client | route `win32 && needsClientRewrite` through the eager single-reader relay with inline rewrite |
| 857 | app-server caches catalog in memory (StaticModelsManager, offline validation); ocx warns only during sync | shared stale-state collector (catalog mtime vs process start) surfaced in doctor/agent status/api; suppress model guidance when stale |
| 848 | PR #861 macOS CI failure is the Bun isolate segfault fixed on dev by #849; branch predates it | diagnosed; author asked to rebase past 18352b4f (comment 5154392437) — DONE |

## Per-bug fix docs

- `010_fix_858_pinned_cleanup.md`
- `020_fix_855_ghost_models.md`
- `030_fix_859_desktop_alias.md`
- `040_fix_864_ws_terminal.md`
- `050_fix_857_stale_roster.md`
- `060_fix_848_pr861_unblock.md` (resolved at research time)
