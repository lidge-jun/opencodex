# 020 — Options

| Option | What it does | Fixes the port | Main cost / risk |
|---|---|---|---|
| B1. Checked stop over existing primitives | One operation: bind manager, wrapper and child identities; `/end`; terminate only the bound wrapper PIDs and child; re-observe until the port is free or a bounded deadline; report an explicit outcome | Yes for the common case | Needs a terminate primitive with identity revalidation immediately before each kill; native tests for elevated tasks |
| B2. B1 plus disabling the task during the stop | As B1, but `schtasks /change /disable` first so logon/session triggers and restart-on-failure cannot start a new instance mid-stop; re-enable on `service start` | Yes, including trigger races | Changes the registered task state; an interrupted stop must not leave the service disabled silently (needs a durable marker and recovery) |
| C. Cooperative intentional-stop handshake | The wrapper checks an authenticated stop file or exit code before relaunching | Yes for new wrappers | New cross-process protocol; legacy wrappers already installed still need B1 |
| A only (status quo) | Diagnostics and guidance only | No | The dead end in #7771 remains |

Not considered acceptable: blanket `taskkill /T /F` by image name, port-owner killing without installation identity, or automatic elevation from Desktop. A task name, process name, port or path token alone is not kill authority (the #5443 consent boundary).
