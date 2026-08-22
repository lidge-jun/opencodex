# 010 — Remove the forbidden `-WindowStyle Hidden` argv (F1)

**Depends on:** nothing. This is the entry point of the unit.

## Change

`src/service.ts:2360-2363`, delete the CLI pair only:

```diff
 spawnSync(resolveTrustedWindowsPowerShellExe(), [
-  "-NoProfile", "-NoLogo", "-NonInteractive", "-WindowStyle", "Hidden",
+  "-NoProfile", "-NoLogo", "-NonInteractive",
   "-Command", ps,
 ], { stdio: "ignore", timeout: 5000, windowsHide: true });
```

`windowsHide: true` stays — it is the flag that actually suppresses the console
window (#1278), and it is the one `src/codex/user-identity.ts:225` relies on.

## Widen the guard so it cannot drift back

`tests/windows-deploy-close-regressions.test.ts:43` asserts the bad argv only
against `src/update/job.ts`. Replace the single-file assertion with a sweep over
every `src/**/*.ts` that spawns PowerShell directly, asserting none passes
`-WindowStyle` adjacent to `Hidden` in an argv array. Keep the existing
`update/job.ts` assertion; this adds a family check rather than replacing one.

Note `src/lib/windows-elevation.ts:622,660,687,736`, `src/tray/windows.ts:489`
and `src/update/job.ts:574` use `-WindowStyle Hidden` **inside a PowerShell
script string** passed to `Start-Process`/`ProcessStartInfo`. That is a
different construct and is not affected by #1589. The guard must match the argv
array form specifically, or it will fire on six correct call sites.

## Verify

```powershell
bun run typecheck
bun test tests/windows-deploy-close-regressions.test.ts
bun test tests/service.test.ts
```

Drive it red first: restore the two array elements, confirm the new assertion
fails, then remove them again. An assertion that has never failed is not a
guard.

## Risk

Low. The behavioral surface is one `spawnSync` that already ignores its exit
status. The regression risk is the guard being written loosely enough to match
the six legitimate script-string sites — hence the argv-shape requirement above.
