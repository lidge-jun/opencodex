# 030 — wp3 restack onto L3 and final lane verification

Coordinator instruction (2026-10-13): stack order L2 → L1 → L3 → L4; L3's final restacked head is
`d9ce24cdece26cccf23564396fc983cbb737db93` (`codex/rt284-issues-proxy`). The earlier trial base `465207459c` is discarded.

## Steps

1. `git -C /private/tmp/rt284-lanes/L4 rebase --onto d9ce24cdec 3e58c2ce3e codex/rt284-issues-platform` (two commits:
   `fc9d078201` #6853, `88840876ad` #6973).
2. Expected conflict: `scripts/test-layout/layout.json` line 90 (L1's #6996 added
   `service-desktop-login-registration.test.ts` on the line wp1 appends to) — resolve by keeping both entries on the same line;
   check `tests/fixtures/test-layout-expected.json` likewise. `layout.json` must stay < 2000 lines. Any other conflict is
   resolved only by keeping both sides' intent and is reported.
3. Semantic interplay to check: L1's #6996 changes Desktop startup/login (`src/service/desktop-startup.ts`,
   `service-desktop-login-registration`) — wp1's Windows diagnostic must still compile and its tests pass on the union.
4. Commit this plan unit as `docs(devlog): record the L4 lane plan, reviews and outcome for #6853 and #6973`, matching the
   L1/L3 convention.
5. Verify on the union with `OCX_TEST_RUNNER_BUN=/Users/jun/.cache/rt284-bun/bun-darwin-aarch64/bun` (Bun 1.4.3, the pin after #6986):
   typecheck; L4 focused suites (Windows supervision, desktop-startup macOS/Linux/health/login-registration, status startup
   health, macOS runtime, runtime, WSL runtime, prompt probe); union guards (file-size ratchet, test-layout, test-layout-tooling
   incl. pinned runner, repo-hygiene, skill-ocx, structure:check, privacy:scan); `test:changed` against the L3 head.
6. Independent exact-head review of the restacked delta (rebase correctness, no lost hunks: `git range-diff`).
7. Report to the coordinator via the final message and `/private/tmp/rt284-lanes/status/L4.md`. No push/PR/merge.


## Amendments after audit round 1 (Arendt, FAIL → folded)

- **#6959 passive reads (L1).** L1 changed `src/codex/runtime.ts`, `src/codex/catalog/bundled.ts`, startup-health caching and
  `src/cli/status.ts` for Remote Link passive reads. After the restack: (a) confirm by reading the union which passive
  paths can reach `resolveCodexRuntime`/`installedCodexCandidates` and whether a cold passive read can open the app
  `Info.plist`; (b) run `tests/server/link-management-relay.test.ts` and `tests/cli/cli-link-child.test.ts` on the union;
  (c) the plist open uses `O_RDONLY | O_NONBLOCK` on purpose (a FIFO planted at `Info.plist` must not block discovery). If the
  relay test's effect watcher classifies that read-only open as a write, correct the watcher to classify by the write
  bits (`O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND`) rather than `!== O_RDONLY`, in a separate commit with a
  regression assertion for both flag sets, and report it to the coordinator. If a passive read can reach discovery,
  add cold-cache coverage asserting no subprocess and no persistence.
- **#7005 overlap (L2).** `persistEffortClamp()` in `runtime.ts` changed to return whether an observation changed. The
  rebase keeps that behaviour verbatim. Second manifest overlap: `layout.json:684` / `test-layout-expected.json:479`
  (`codex-clamp-notice.test.ts` vs `codex-runtime-macos-desktop.test.ts`) — keep both entries on the same line.
  Run `tests/codex-integration/codex-clamp-notice.test.ts` on the union.
- **Changed-test base.** Use `OCX_TEST_RUNNER_BUN=… bun scripts/test.ts --changed=d9ce24cdece26cccf23564396fc983cbb737db93` and confirm
  its reported comparison commit equals the L3 head.
- **Prose overlaps.** After the restack, read the combined text of `docs-site/.../guides/codex-integration.md`,
  `guides/desktop-app.md` (en/ko), `structure/catalog.md`, `codex-home.md`, `desktop-shell.md`, `runtime.md` for
  contradictions.
- Keep the Node import smoke of `desktop-supervision.mjs` and the real-app prompt-parser check (done during wp2: ok, 4 layers)
  in the final report.


## Outcome (wp3 restack)

Restacked onto L3 `d9ce24cdec`. Conflicts: `layout.json` / `test-layout-expected.json` service line (#6996 login-registration +
#6853 Windows supervision) and codex-runtime line (#7005 clamp-notice + #6973 macOS app runtime), each resolved by keeping both
entries on the same line (`layout.json` 1999 lines). `runtime.ts` merged with #7005 without conflict.

Union finding (#6959 × #6973): a passive `GET /api/settings` on a Mac with the Codex app installed resolves the runtime and opens
`/Applications/ChatGPT.app/Contents/Info.plist` read-only (`O_RDONLY | O_NONBLOCK`); no subprocess or write occurs. The relay
test's effect watcher misclassified that open as a write; fixed in a separate commit
(`test(link): classify passive-read opens by write capability`) with a deterministic predicate assertion.


Union line budget: with L1's additions, `structure/desktop-shell.md` reached 603 lines (> 600); the #6853 Windows paragraph and selector note were folded into fewer lines (599) inside the #6853 commit, content unchanged.
