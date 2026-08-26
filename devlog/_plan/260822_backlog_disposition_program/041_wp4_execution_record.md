# 041 — WP4 execution: #2292, and the audit that arrived after it was retired

`--restart-desktop-app` landed as PR #2382 (`84ee2e284`), with all ten CI checks
green including the Windows shards. Issue #2292 is addressed.

The part worth recording is not the feature. It is that this work-phase almost
shipped two ways to kill the wrong process.

## The auditor was retired, then returned

The plan auditor produced nothing across four wait cycles (~20 minutes), so it was
retired under DISPATCH-RETIRE-01 and the main agent audited the plan directly. That
direct audit answered all seven questions and returned **zero blockers**.

Then the lane returned. Following the rule recorded in `090` — *retirement is not a
verdict* — its result was re-read against what had already been concluded, and it
returned **FAIL with 5 High blockers**. Two were real safety holes in code that was
already written:

**Cross-user termination.** The probe matched `ChatGPT.exe` under the discovered
`InstallLocation`. An MSIX package directory under `WindowsApps` is **shared between
accounts**, so on a multi-user machine another user's Codex desktop matches the same
path and would have been closed or force-killed. The fix is the same bar the
app-server collector already pays for: `Invoke-CimMethod GetOwner` compared against
the current `WindowsIdentity`.

**PID recycling.** A root was listed, given a 15-second graceful window, then
`taskkill /PID <pid> /T /F`. Windows can recycle a PID inside that window, and `/T`
tears down the *new* process's whole tree. The fix re-verifies `CreationDate`
immediately before the graceful close and again before the forced pass.

Two more were real, if less dangerous:

**`process.ppid` is not ancestry.** A terminal hosted inside the desktop app sits
several hops below `ChatGPT.exe`, so a one-level parent check misses precisely the
case the self-kill guard exists for. Now a bounded CIM walk, and an unreadable chain
fails closed rather than reading as "not our ancestor".

**The hint does not fan out.** The plan claimed editing `STALE_CODEX_APP_SERVER_HINT`
would update the warning, doctor, and dashboard. It does not:
`formatStaleCodexAppServerWarning` and the doctor action line hardcode their own
strings. Without fixing them, a Windows user would still be pointed only at the flag
that cannot refresh their picker.

## Why the direct audit missed them

It verified everything the *plan* said and confirmed each pointer against real code.
What it did not do was ask what the plan had left out — specifically, what the
existing app-server collector guards against that the new code did not. The lane
found the omissions by comparing the new design against the established one
(`GetOwner` at `app-server-processes.ts:361-429`, identity re-resolution at
`:1016-1030`), which is a different question from "is the plan accurate".

Both audits were honest. Only one was adversarial.

## What shipped

Kill authority is bounded on four axes, each proved by an injected test rather than a
comment: runtime package discovery (never a hardcoded AUMID, since the beta family
changes per build), current-user ownership, `CreationDate` re-verification, and a
bounded CIM ancestry walk. Discovery failure, self-ancestry, an unreadable chain, and
any surviving target all skip the relaunch and tell the user to restart manually.

`--restart-codex` cannot imply the new flag, and that is locked by a source test
rather than left to review.

## Verification

```
bun x tsc --noEmit                                 exit 0
bun test tests/desktop-app-restart.test.ts         16 pass / 0 fail
bun test tests/codex-app-server-processes.test.ts  46 pass / 1 skip / 0 fail
bun test tests/cli-dispatch.test.ts                 9 pass / 0 fail
bun run privacy:scan                               Privacy scan passed
PR #2382 CI                                        10/10 checks pass
```

Every guard is verified on macOS through the `DesktopAppRestartIo` seam and
`setTrustedWindowsElevationExecutablesForTests`, including the recycled-PID case (the
third listing returns a different `CreationDate`; `taskkill` is never called) and the
multi-hop ancestry case.

**Not claimed:** the end-to-end picker refresh needs a real Windows host. This proves
the kill/relaunch contract and its refusals, not that the renderer re-reads the
catalog on a live machine. That distinction is why the issue is referenced rather
than closed.

