# 050 — Risks, compatibility, rollout

## Risks

- Killing the wrong process: mitigated by per-installation binding, start-time plus command-line digest revalidation immediately before each terminate, and treating unreadable evidence as unknown. Residual: a process that perfectly impersonates this home's wrapper command line and start time cannot be told apart, which already holds for the guarded takeover.
- Elevated tasks: an unelevated stop cannot terminate an elevated wrapper. The design reports `denied` with guidance instead of trying harder; Desktop never auto-elevates.
- Trigger races: reported as `survived`; B2 would close them at the cost of persistent task-state changes.
- Behavior change for scripts: `ocx stop` / `ocx service stop` exit non-zero where they used to print success over a respawning wrapper. That is the intended correction, called out in the release note.

## Compatibility

- Existing installations keep their wrappers; no reinstall is required for B1.
- macOS/Linux unchanged.
- The update path keeps `stopWindowsChecked` until it is migrated in a separate change.

## Rollout

1. Implement B1 behind the shared operation with the hermetic suite.
2. Run the device matrix in 040 on at least Windows 11 x64 (npm and bundled) and one elevated-task setup; attach redacted evidence to the PR.
3. Desktop outcome mapping in the same release.
4. Consider C (wrapper stop token) for newly generated wrappers afterwards.
