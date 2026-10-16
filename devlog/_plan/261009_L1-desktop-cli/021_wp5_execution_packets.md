# 021 — wp5 execution packets (cycle plan, PR B stacked on #6802)

**Continuity.** wp2 D (019): "evidence + projection shipped as #6802; next wp5 command guards stacked on that branch,
then wp3 launcher from dev." Kept. Re-verification: `git diff c15037b324 fd2032050a` touches none of bin/, src/service,
src/update, src/cli/{index,dispatch,update-restart}.ts, so 020 anchors still hold. Branch
`codex/desktop-sidecar-command-guards` cut from #6802's head in the same lane worktree (the session's source binding).

Contract: 003 + 020 including r2–r5 (later wins). Blocking rule everywhere: `createSupervisionLatch()` from
`src/service/desktop-supervision.mjs` — blocked on `desktop` or `unknown && desktopSeen`, cleared only by `none`.
`desktopServiceRefusal` (020) therefore takes the latch verdict, not just `kind === "desktop"`.

| Worker | Write scope | Notes |
|---|---|---|
| G1 service | NEW `src/service/desktop-command-guard.ts`; MODIFY `src/service/cli.ts`, `src/service/orchestration.ts`, `src/service/repair.ts`; tests `tests/service/service-ownership-handover.test.ts` | refuse install/repair/start/restart before any mutation incl. Windows staging; one latch per command |
| G2 updater | MODIFY `src/update/runtime-ownership.mjs` + `.d.mts`, `bin/ocx.mjs`, `src/update/index.ts`, `src/update/restart-ownership.ts`; tests `tests/update/update-desktop-owner.test.ts`, `tests/update/update-restart-lease.test.ts`, `tests/cli/cli-update-restart.test.ts`, `tests/cli/ocx-launcher-source.test.ts`, `tests/cli/ocx-launcher-runtime.test.ts` | planner `supervision` input; initial + **pre-stop** (index.ts stop block, bin/ocx.mjs stop) + recovery + refresh through one latch; Node proof per 020 r5 |
| G3 CLI wording | NEW `src/cli/desktop-runtime-guidance.ts`; MODIFY `src/cli/index.ts` (net ≤ 0 lines preferred, max +5), `src/cli/dispatch.ts`, `src/cli/update-restart.ts`; tests `tests/cli/cli-stop-json.test.ts`, `tests/cli/cli-restart-health.test.ts` | type-only import from G1's module; stop notice suppressed under --json, wording "may" |
| G4 docs | `structure/desktop-shell.md`, `structure/ops/service-and-sidecars.md`, docs-site desktop guide en + ko | guard paragraph + bypass ledger summary (020 r4 F7), user section from 020 (~:766/:782) |

Verifier (main, after integration): the union of the worker test files plus wp2's nine files (regression),
`bun run typecheck`, `bun scripts/file-size-ratchet.ts`, `bun run structure:check`, `bun run privacy:scan`,
docs-site build, Node import proof `node bin/ocx.mjs update --help`, and a read-only live check: lane CLI
`service install` must refuse on the reporting Mac **without mutating anything** — run it only with
`--dry-run` if the command supports one; otherwise do not run it live (unit tests carry the proof).


Reflection (Kant): MISALIGNED → folded: G4 also owns `structure/runtime.md` (cap 600, replace only) and
`structure/cli-management.md` (020:684, :737); main's verifier adds `tests/cli/cli-dispatch.test.ts`,
`tests/cli/system-restart-client.test.ts`, `tests/cli/system-restart-client-package-tree.test.ts` (020:850).

Audit (reviewer 01a11e4b): GO-WITH-FIXES (blockers=2), folded:
1. `SupervisionInspector = (deps?: Parameters<typeof inspectDesktopSupervision>[0]) => DesktopSupervision` (G1).
   Restart fallback (G3) keeps the restart target pid and calls `inspect({ targetPid })`; an unrelated Desktop pid never
   blocks the target's recovery. Tests: unrelated pid → allowed; target-bound `unknown`+`desktopSeen:true` → blocked.
2. Pre-stop targets (G2): Bun updater uses `targetPid: runtimeTrusted ? livePid : undefined` (src/update/index.ts:522-530);
   the Node launcher passes no `targetPid` and relies on the inspector's own pid-file/runtime-port correlation
   (bin/ocx.mjs:409). Missing target → inspector correlation only; mismatch → `unknown` (latch keeps a prior block).
3. Every `unknown` fixture carries `desktopSeen` explicitly (false for pass-through, true for refusal cases).
Live check: `service` has no `--dry-run` (src/service/cli.ts:169-186) → no live service command is run.


Combined-tree check (030 r4 / 031): scratch branch `codex/l1-combined-check` = PR B head 6653faf382 merged with PR C
head (launcher). Conflict only in `tests/cli/ocx-launcher-runtime.test.ts` (both PRs append a describe block at the end
of the file; resolution keeps both blocks) and in this plan unit (now synced identically to both branches). Result:
typecheck pass; 326 pass / 2 skip / 0 fail across launcher runtime/source, bun-runtime, update-desktop-owner,
version-skew, dispatch, help-recovery; ratchet and structure pass; `node bin/ocx.mjs update --help` exit 0. Whichever of
PR B / PR C merges second needs that one test-file conflict resolved the same way.

