# 003 — Locked contract index (plan revision r5)

The decade docs grew "r2–r5 amendments" sections during reflection and audit. Where a later amendment and earlier text
in the same doc disagree, **the later amendment wins**. This index is the short authoritative list; read it before a
decade doc.

## Shared names (all phases)

| Thing | Final shape | Defined in |
|---|---|---|
| ESM evidence | `{kind:"desktop", runtimePid, supervisorPid, app, proxy}` · `{kind:"none"}` · `{kind:"unknown", reason, desktopSeen}` · `{kind:"unsupported"}` | `src/service/desktop-supervision.mjs` + `.d.mts` (010 r4) |
| Inspector | `inspectDesktopSupervision({ targetPid?, platform?, run?, proc?, readPid?, readRuntimePortPid? })`; any two of target / pid file / runtime-port pid that differ → `unknown` (`pid-mismatch`); runtime-port secret never read into the result | 010 r2 §2, r3 §2 |
| Latch | `createSupervisionLatch()` in the same `.mjs`; blocks on `desktop` or `unknown && desktopSeen`; only a later positive `none` clears it | 020 r3, r4 F1 |
| Diagnostic | `DesktopStartupDiagnostic.supervisor?: { supervisorPid, runtimePid, app }` — unowned branch only for ownership `kind === "none"` | 010 r3 §3, r4 F5 |
| Protection | `desktopEffective` requires `(owned || supervisor !== undefined) && loginEnabled && running && viable`, darwin/linux, not stale | 010 r4 F4 |
| Guidance | `StartupHealth.recommendedAction?: string | null` (sentence, never a command); `recommendedCommand` null whenever `desktop` is present with local routing | 010, r2 §5 |
| Status | `CliStatusJson.startupSource: "live" | "local" | "local-supervision-override"`; one shared selector used by status, its service summary and doctor | 010 r2 §1, r3 §1, r5 |
| Resolve | `ResolveJson.supervisor?: { kind, supervisorPid?, runtimePid?, app? }`, only when live; exit code never changes on probe failure | 010 r4 F5 |
| GUI | `StartupHealthData.desktop.supervisor?`, `recommendedAction?`; predicate `desktopManagesStartup(health)`; new key `startup.desktopSupervisedRecovery` in all 11 locales; PR needs a screenshot | 010 r2 §4, r4 F5 |

## Per phase

- **wp2 / PR A (010):** evidence module, desktop-startup unowned branch, autostart-health, startup-health-cache stale path,
  status validator + selector + summary, doctor, resolve, GUI. Verifier = 010 r4 F6 list + `tests/codex-integration/doctor.test.ts` (r5).
  structure/runtime.md is at its 600-line cap: replace text there.
- **wp5 / PR B (020, stacked on A):** guards for service install/repair/start/restart, update (initial, **pre-stop** in
  `src/update/index.ts` and `bin/ocx.mjs`, recovery, refresh), dashboard restart veto; stop notice ("may"); start/restart
  wording; bypass ledger (020 r4 F7). Node proof per 020 r5.
- **wp3 / PR C (030):** PATH Bun fallback (same major, minor ≥ pinned; identity probe via `-e`; POSIX writable rejection),
  failure text names the Desktop CLI on macOS, lifecycle-only neutral skew notice, provenance test in
  `tests/ci-workflows/bun-runtime.test.ts`; source assertion scoped to `resolveBun`/`fail` bodies.
- **wp4 (040):** decision record + closeout.

