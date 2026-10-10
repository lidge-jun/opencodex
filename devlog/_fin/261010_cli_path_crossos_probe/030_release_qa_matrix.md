# 030 — Release-QA items and the shared findings matrix

The three release-QA items left open by `261009_desktop_owned_path_cli/049_outcome.md`, plus the matrix both probes
fill. Rows are filled in B of wp2/wp3 with the command and output tail.

| Item | Host | Probe | Result |
|---|---|---|---|
| Fish in a real login shell | lidge | 010 L4/L6/L7 (portable fish 4.9.3 as the probe user's login shell) | works (019 L7); non-interactive fish keeps `/usr/bin/ocx` by design |
| Linux .deb path | lidge | 010 L3/L5/L6/L12 | works for build, install kind, reconcile and rc blocks (019); opt-out unverified |
| New Windows terminal after a real registry write | mini | 020 W3/W4/W6 | works (029 W4): Terminal tab with `--reloadEnvironment`, Explorer-launched and Task Scheduler `cmd` select the Desktop `ocx` first; module-level write, packaged launch unverified |
| Packaged click-through of the CLI page | — | not in this unit's reach without a GUI operator; recorded as unverified unless the Linux Xvfb run exposes the page | pending |

## Matrix

| Surface | Linux (lidge) | Windows (mini) |
|---|---|---|
| PATH installer (#6816) | L1, L2, L6 (packaged deb in overlay) | W1, W3 (module level; packaged launch unverified) |
| New shell / terminal pickup | L7 | W4 |
| Package launcher handoff (#6818) | L8 | W7 (by design: none) |
| status / doctor / resolve (#6802, #6818) | L9 | W7 |
| refuse-to-compete guards (#6809) | L10 | W8 |
| Bun fallback (#6807) / preflight (#6812) | L11 | W9, W10 |
| Opt-out cleanup | L12 | W6 |
