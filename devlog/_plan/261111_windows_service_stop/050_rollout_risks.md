# 050 — Risks, compatibility, rollout

## Risks

- Killing the wrong process: only wrapper images are ever terminated; the proxy child keeps the graceful stop and its refusal rule. Per-installation binding with an image-name allowlist, lineage, a creation time read at bind time and re-checked on the same handle that terminates. Residual: a process that perfectly impersonates this home's wrapper (image, command line, lineage and creation time) cannot be told apart; the guarded takeover already carries that residual.
- Elevated tasks: an unelevated stop cannot terminate an elevated wrapper → `denied` with guidance; no automatic elevation.
- Trigger races: a new instance during the stop is `survived`, not retried without bound.
- Windows ARM64: the recommended fallback keeps today's ability to end a wrapper with a small accepted window between the in-script check and `Kill()`. If the owner prefers the strict variant (no kill without the handle primitive), ARM64 regresses from today: `ocx stop` and `ocx uninstall` report `unknown` wherever a wrapper survives.
- Not persistent: the proxy returns at the next logon/unlock trigger; stated in output text.
- Behavior change for scripts: `ocx stop`, `ocx service stop`, `ocx uninstall` and `/api/stop` report failure where they used to report success over a respawning wrapper.

## Compatibility

- Existing installations keep their wrappers; no reinstall needed for B1.
- `ocx-stop/1` and `/api/stop` change only additively; mixed Desktop/CLI versions keep today's behavior where a field is missing.
- macOS/Linux unchanged.

## Rollout

1. Implement the creation-time reader and handle terminate with hermetic tests.
2. Implement `stopWindowsServiceChecked` and wire all four callers from 030, including the updater variant.
3. Run the device matrix (040) on Windows 11 x64 (npm and bundled) and one elevated-task setup; attach redacted evidence.
4. Desktop text for the additive fields in the same release.
5. Consider C for newly generated wrappers afterwards.
