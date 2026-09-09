# Full-format closeout

Depends on030/040/050; wp6. No new runtime features. Main owns all external writes.

## Diagnosed CI prerequisite (test-only, no production storage changes)

Additional CI fixture correction:3591job101240765762 failed loopback startup with
EADDRINUSE40895. The log cannot identify the owner of that port. Eleven fixtures used
rawstartServer(0), bypassing the existing reserved-port allocator used by the rollback
test. Reuse findAvailablePort with reservedPort for those public listener draws via one
local helper. No startup retry, productionlistener/auth change, or assertion removal.
Keep no-loopback/explicit-port/intentional-bind-failure tests unchanged. This removes a
reachable fixture self-collision; it does not claim everyexternal bindrace is solved.

PR3589 job101236091166 on7783355f9 fails the late-async-spill ordering test before
its overwrite assertions: outer fallback uses real Date.now despite frozen inner
clocks, so its80ms reserve can expire during real cleanup. Images aren't in this
isolated batch. Do not blindly retry or weaken budgets/assertions.

MODIFY only tests/responses/responses-state.test.ts: import existing spyOn and
awaitResponseSpillPublicationTailForTests; after `await started` in this single
late-completion test, capture Date.now and spy it to return that captured value.
Keep all assertions and40ms real drain timer. In finally restore spy FIRST, then
release the blocked writer and await the existing publication-tail barrier.
Do not freeze timers or other deadline/exhaustion tests. Existing superseded flag,
file-identity and replay assertions prove ordering independently of clock progression.
Publish correction on layer2, cascade all own higher branches with explicit leases,
and re-run exact-head CI; no new production clock hook/export. Independent reviewer
must verify scope and teardown. The earlier failed CI is the red evidence.

MODIFY003 audit table with each exact final disposition, test names and CI links;
MODIFY000 continuity with exact commit/PR/reviewer proof. Archive unit _plan -> _fin
only when it describes a public outcome. Tests/code may not be weakened for green CI.

Before each merge: refresh exact head, base, full status rollup, reviewer comments,
worktree identity and source ancestry. Resolve actual failures; never assume flakes.
Document user-authorized admin approval bypass. Merge bottom-up, prefer merge commits,
retain parent branches, retarget child to dev only after parent is public. Verify CI
against the exact child head and current base; restack with lease if necessary. Fetch
origin/dev and prove every merge SHA ancestor. No release, deployment or10100 restart.

Local suites remain prohibited. Inspect and stop actual local Bun suite processes as
authorized, not SSH commands merely mentioning a remote suite, dev servers or the proxy.
Success: c-all fully accounted + unchanged c2 CI/review/merge/ancestry criterion met.
Report remaining native file/remote URL/history limitations honestly, separate from
fixed silent losses. Report original ordinary-image OCR mismatch unproven if no new
evidence establishes its cause. Do not equate model tokens or a mock reply with OCR.
