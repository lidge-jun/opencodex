# 100 — wp9: issues resolved without new code (#2292, #1587)

Two of the nine owner issues needed a verdict, not a patch. Both claims were
re-verified against `origin/dev` by the main session rather than taken from the
reviewer's report.

## #2292 — Windows model picker stays stale

Fixed by PR #2382, merged as `84ee2e284` (`a3bbcdb03 feat(cli): add an opt-in
Windows desktop-app restart for a stale model picker`). Verified present in
`origin/dev` history.

The fix is opt-in by design. On Windows the desktop UI caches `model/list` and
invalidates only on `codex-app-server-initialized`, so killing the app-server
child does not refresh the picker — a full app restart does. Making that restart
automatic would kill a user's UI without asking, so it stays behind a flag.

## #1587 — routed first-turn tool catalog 3-5x native Sol

Already fixed by `fcbef381e`, confirmed an ancestor of `origin/dev` via
`git merge-base --is-ancestor`. That commit restored deferred discovery after
measuring the regression: 258,929 characters down to 96,699, recorded at
`structure/03_catalog-and-subagents.md:231`, with MCP reachability preserved.

`normalizeRoutedCatalogEntry()` at `src/codex/catalog/parsing.ts:526` now pairs
`tool_mode: "code_mode_only"` with `supports_search_tool: true`, and
`src/codex/catalog/sync.ts:371` gives template-less routed entries the same
contract. `bun test tests/catalog-cursor-search.test.ts` re-run by the main
session: 5 pass / 0 fail.

One honest caveat: a later comment on the issue describes a Claude Desktop
cache-tail comparison. That is a different client and a different, smaller
question — it is not a reproduction of the original Codex App defect. Closing
#1587 on the original report; the Claude Desktop question earns its own issue if
anyone wants to pursue it, rather than keeping a fixed bug open as a placeholder.


## Execution record

#2292 and #1587 closed 2026-08-23 with the verification evidence posted on each.
The #2152 repair went out as PR #2452 in the same work-phase, since it is the
third issue whose resolution needed no product change.
