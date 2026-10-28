# 000 — OCX-10: passive service status JSON and install-method verdict

Producer side of the GOAT hub inventory (goat-si/goat#684, design §5 detection steps 3–4).
GOAT reads an adopted OpenCodex install over SSH and must not change it.

## Scope

1. `ocx service status --json`: one stable document built from the same reads the text
   status already performs — `diagnoseService()` (launchd / systemd user unit / Task Scheduler
   / WinSW) and, when a registration exists, the loopback serving probe. It is answered before
   `platformOps()` resolves, so no install, start, stop, repair or migration code is reachable.
   The text output is unchanged.
2. `ocx status --json` gains an additive `install` field mapped from the existing
   `detectInstallOwnership()` (`src/update/install-detection.mjs`), with the evidence basis and
   no new paths.

## Shape decisions

- `running` is the service manager's verdict (the value `startup.serviceRunning` already
  carries); `serving` says separately whether a proxy answers on the installed port.
- `backend` names the manager holding a registration: `launchd`, `systemd`, `schtasks`,
  `winsw`, or `none` when nothing is registered or the platform is unsupported.
- `install.method` adds `standalone` to the requested set because the existing detector already
  distinguishes the compiled desktop sidecar; `unknown` is reserved for a detector failure.

## Verification

Platform shape snapshots with mocked managers, a passive guard over every spawn entry point on
darwin/linux/win32, an install-method matrix, typecheck, test:changed, skill surface, structure,
privacy and the full suite.
