# 041 — wp4 P re-verification

Re-read 2026-09-05 at `origin/dev` = `760eddee1`. `merge-tree`: #3447 CLEAN, #2783 CONFLICT
(semantic in `src/providers/quota.ts`, per 040), #2973 CONFLICT (five mechanical files, the fifth
added by #3518's test relocation). Layers 1 and 3 were pre-built during wp3's CI wait:

| Layer | Branch | Head | Evidence |
|-------|--------|------|----------|
| 1 (#3447) | codex/260905-antigravity-ollama-quota | 7fa078b81 (cherry-pick) + ba3960408 (F1 fix) | RED 117/4 → GREEN 121/0 provider-quota; account-quota 18/0; layout 17/0; repo-hygiene 14/0; tc 0 |
| 3 (#2973) | codex/260905-quota-window-activation | e5743424e | RED1 1/2 → 3/0 (sweeper displacement), RED2 module-missing → 9/0, RED3 schema 2 fail → 9/0; quota-bars-rows 13/0; core-lab-boundary 17/0; layout 17/0; lint:gui 0; privacy:scan 0; tc 0 |

**Verifier rule (006 override):** no `test:changed` in this work-phase; the two lanes' runs were
killed before producing output. Local = typecheck + named files; hosted CI = everything else.

**Layer 2 (#2783)** is built next, from layer 1's head, per 040 §3.2 (six bounded fixes B1-B6
for the three maintainer blockers; `MIN_INTERVAL_MS` and `MIN_POLL_SECONDS` raised together).
Author is the maintainer — no trailer. Its test-destination deviation from layer 3 applies:
`tests/codex/` does not exist; `codex-quota-*` basenames map to `tests/codex-integration/`.

Trailers: layer 1 `hualiny <82697947+hualiny@users.noreply.github.com>`, layer 3
`terrytan95 <10609214+terrytan95@users.noreply.github.com>` (both in branch commits).

Stack: layer 1 → dev; layer 2 → layer 1; layer 3 → dev (independent). Layer 1 and 3 PRs open
now; layer 2 PR opens when its lane finishes.

DOCEOF; cp /Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260905_open_work_closeout/041_wp4_reverify.md /private/tmp/ocx-closeout.xomWAA/wt/devlog/_plan/260905_open_work_closeout/
## Audit fold (wp4 A round 1 — claude-opus-5, GO-WITH-FIXES blockers=5; report 042)

1. **Layer 2 test layout (High):** seven of #2783's test basenames resolve to `null` (incl.
   `quota-reset-account-key`, `quota-reset-core-boundary`). Layer 2 lane registers all of them in
   `scripts/test-layout/layout.json` + `tests/fixtures/test-layout-expected.json` under the
   `usage` domain (or the domain the resolver's siblings use) and moves the files there.
2. **Stale verifier paths (High):** `tests/server/server-background-lifecycle.test.ts`,
   `tests/ci-workflows/repo-hygiene.test.ts`; a non-matching path exits non-zero — every lane
   `ls`-checks paths first. `tests/lab/core-lab-boundary.test.ts` delta in #2783 is a rename
   artifact: take dev's version verbatim, no union.
3. **Layer 1 docs (Medium):** folded — `464bb27b6` adds the pinned-host statement to `providers.md`.
4. **Author identity (Medium):** the main checkout's `.git/config` carries a placeholder
   `t <a@b.com>` (user-local; not touched). Both layers re-authored with `--reset-author` under
   the maintainer's own `-c user.name` / `-c user.email` pair; layer-2 lane uses the same `-c` flags.
   Merged squashes on dev are attributed by GitHub to the PR author, so no landed commit is affected.
5. **Trailer ids (Low):** confirmed via `gh api users/<login>`: hualiny 82697947, terrytan95 10609214.

Post-rebase finding (not in 042): after F1 moved the summary probe off `globalThis.fetch`, the
multi-provider test `returns active provider quota rows…` made a **real** request to Google —
sandboxed DNS failure masked it as a silent fallthrough, unsandboxed it returned 401 and dropped
the Antigravity row. Fixed in `4a721e459` by injecting the pinned-transport seam with a 404 so the
`fetchAvailableModels` fallback is what the test exercises, as it did before. Layer 1 final:
156 pass / 0 fail unsandboxed, typecheck 0.

DOCEOF; cp /private/tmp/ocx-closeout.xomWAA/wt/devlog/_plan/260905_open_work_closeout/042_audit_wp4.md /Users/jun/Developer/new/700_projects/opencodex/devlog/_plan/260905_open_work_closeout/
