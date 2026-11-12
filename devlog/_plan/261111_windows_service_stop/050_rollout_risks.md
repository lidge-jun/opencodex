# 050 — Risks, compatibility, rollout

## Risks

- Killing the wrong process: only wrapper images are ever terminated; the proxy child keeps the graceful stop and its refusal rule. Per-installation binding with an image-name allowlist, lineage, a creation time read at bind time and re-checked on the same handle that terminates. Residual: a process that perfectly impersonates this home's wrapper (image, command line, lineage and creation time) cannot be told apart; the guarded takeover already carries that residual.
- Elevated tasks: an unelevated stop cannot terminate an elevated wrapper → `denied` with guidance; no automatic elevation.
- Trigger races: a new instance during the stop is `survived`, not retried without bound.
- Windows ARM64: the recommended fallback keeps today's ability to end a wrapper with a small accepted window between the in-script check and `Kill()`. If the owner prefers the strict variant (no kill without the handle primitive), ARM64 regresses from today: `ocx stop` and `ocx uninstall` report `unknown` wherever a wrapper survives. A third option closes the window on ARM64 too: an `Add-Type` P/Invoke inside the trusted PowerShell script that opens the process, reads its creation time and terminates it on the same handle. It costs a C# compile per stop (about a second) and can fail under Constrained Language Mode or antivirus; a compile failure would report `unknown`.
- Not persistent: the proxy returns at the next logon/unlock trigger; stated in output text.
- Desktop exit drain: the drain's 30 s deadline cannot hold the worst case of a registered service, so the same release raises it to 75 s on Windows and passes the deadline in `OCX_STOP_DEADLINE_MS` (the CLI also accepts `--deadline-ms`). A configured `shutdownTimeoutMs` well above the default grows the exit-wait row; beyond what 75 s holds, admission refuses the exit drain up front (today that drain already overruns Desktop's wait). An older Desktop with a newer CLI passes no deadline; the CLI then uses 60 s and can outlive Desktop's wait, which Desktop reports as a failed drain. Today's stop can already outlive it, so the pairing is no worse than now.
- Budget refusal: on a slow machine a stop can be refused up front with `unverified-budget` (nothing changed) where today it would have run and maybe overrun; the operator retries from a terminal (60 s).
- Behavior change for scripts: `ocx stop`, `ocx service stop`, `ocx uninstall` and `/api/stop` report failure where they used to report success over a respawning wrapper.

## Compatibility

- Existing installations keep their wrappers; no reinstall needed for B1.
- `ocx-stop/1` and `/api/stop` change only additively; mixed Desktop/CLI versions keep today's behavior where a field is missing.
- macOS/Linux unchanged.

## Rollout

1. Implement the creation-time reader and handle terminate with hermetic tests.
2. Implement part A and part B and wire every call site from 030 (ocx stop both paths, ocx uninstall, /api/stop, ocx service stop, service uninstall/remove, prepareServiceInstall, the updater), including the guarded `bound-stray` state.
3. Run the device matrix (040) on Windows 11 x64 (npm and bundled), one elevated-task setup, and one Windows 11 ARM64 device for the chosen ARM64 variant; attach redacted evidence. If no ARM64 device is available, the owner must explicitly defer that case, and ARM64 then ships with the strict variant (report `unknown`, kill nothing) until it is run.
4. Desktop text for the additive fields in the same release.
5. Consider C for newly generated wrappers afterwards.
