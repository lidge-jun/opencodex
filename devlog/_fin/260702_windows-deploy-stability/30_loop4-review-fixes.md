# Deploy Stability — Loop 4: Independent Review Findings + Fixes

- **Date:** 2026-07-02 · **Branch:** cursor-fixes · **Class:** C2 (review-driven fix batch)
- **Input:** Adversarial Codex review of the combined loop 1-3 diff (`6cb379b..6fa9d95`).
  Verdict: FINDINGS(6) — all fixed in this loop.

| # | Sev | Finding | Fix |
|---|-----|---------|-----|
| 1 | high | Stop-before-update ignored the stop result; npm launcher `configDir()` missed `~` expansion, so the pid gate could check the wrong path | `bin/ocx.mjs` mirrors `expandUserPath`; both update paths abort unless the stop child exits 0 AND the pid file is gone |
| 2 | med | `ocx update` used permanent `ocx stop` semantics against service-managed installs and never restarted the service | Both paths record service presence before stopping and reinstall via the freshly-updated CLI (`service install`) after success |
| 3 | med | `stopProxyGracefully` waited a fixed 8s, hard-killing before a user-configured `shutdownTimeoutMs` drain finished | Default exit wait = `shutdownTimeoutMs + 3000` (8s fallback) |
| 4 | med | `currentOpenCodexHome`/`currentCodexHome` missed `~` expansion → false env-match failures | `currentOpenCodexHome()` delegates to `getConfigDir()`; `currentCodexHome()` uses `expandUserPath` |
| 5 | med | `probeHostname` produced invalid URLs for raw IPv6 hosts (`http://::1:port`) | Bracket raw IPv6 (shared with `gracefulStopHost` semantics) + tests |
| 6 | low | Windows-only shim test still expected the bare Git-Bash launcher untouched (loop 2 now shims it) | Test expects 3 wrappers incl. bare-launcher shim/backup |

Review-confirmed clean areas: OAuth dual-bind port-0 lifecycle, catalog `.cmd` probing,
chcp placement, PATH env-indirection, legacy healthz acceptance breadth.

Gate: `tsc --noEmit` clean; `bun test` 1285 pass / 0 fail.

## Remaining backlog (loop 5+ candidates, medium and below)
Shim wrapper-dir redesign (Homebrew symlink safety, M4) · concurrent-start lock (M5/R7) ·
journal/catalog generation metadata (M6) · Windows rename retry (R9) · `%*` reparse (R10) ·
Linux non-systemd fallback + SSH systemd detection (R12/F9) · WS-enabled CI lane (R13) ·
service log rotation (M7b) · post-`/run` service health verification (R3) · cursor
native-exec `sh -c` on Windows (R15).
