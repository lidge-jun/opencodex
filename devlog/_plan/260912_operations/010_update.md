# Pinned child retirement

Class C4: process termination boundary. Dependency: roadmap. Reuse the existing RestartIo and restartAfterUpdate retry loop; no new process supervisor.

MODIFY src/update/job.ts: RestartIo gains injectable spawnDetachedStartFn, preparePortForPinnedStartFn, waitForGhostListenClearFn and killProxyFn, matching existing functions. Replace Date.now in the pinned retry window with existing io.now. Replace both lastChild.pid-only kills with one closure accepting the ChildProcess: return when pid absent, exitCode non-null, or signalCode non-null; otherwise existing isAlive then kill. Capture the exact spawned child and attach once(exit) to clear lastChild only when lastChild === child. Keep healthy-probe early return. No persisted schema or serialization changes; these are process-local IO seams consumed in the retry loop only.

MODIFY tests/update/update-job.test.ts: carry #4185 deterministic fake EventEmitter children through actual three retries, using injected clock and no real kill. Cases: successful exit, nonzero exit, signal exit, event retirement, live timeout cleanup, same-PID late old event, healthy last attempt. MODIFY tests/windows/windows-deploy-close-regressions.test.ts: replace obsolete exact PID-expression oracle with reference to behavior regression; keep wrapper ownership assertions. MODIFY structure/runtime.md to state observed-child retirement. Existing process code is otherwise unchanged.

Exact starting patch: public PR #4185 head 2602f3ceca4b93237436911dcd8dffc35b3b5e57, reviewed source diff retained locally in .tmp/operations/pr-4185.diff. Before: numeric PID may remain after child exit. After: recorded exit/signal or matching exit event retires cleanup authority. This does not make all OS signalling atomic against PID reuse.

Planned hosted activation checks (not yet executed): seven tests in update/update-job.test.ts exercise both cleanup sites. Local execution NOT RUN. Source check: both sites use the same child-aware closure; no unrelated test weakened. Co-authored-by: luvs01 <27862058+luvs01@users.noreply.github.com>.

Follow-up080 extends exact-child retirement to error/close/exit and releases its own handlers; failed spawn error+close without exit is covered separately. Local tests remain NOT RUN.
