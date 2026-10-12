# 030 — Stall root-cause candidates and reporter checklist

Read-only research on `origin/dev` 7af092ca4f against v2.77.0. No production stack of the
historical stall exists, so every row is a candidate, not a cause. "Reporter" marks evidence
from the issue comments, not reproduction in this unit.

| # | Candidate (blocking operation) | Current dev location | Status |
|---|---|---|---|
| 1 | Synchronous Codex runtime/version probe under the bundled catalog (`execFileSync`, 8 s per candidate, no aggregate bound, 15 s memo) reached from `/v1/models` | `src/codex/runtime.ts:476,486`; 2.77 chain `bundled.ts:518 → :239 → :246 → runtime.ts:468` | Reporter reproduced 23–41 s model-list stalls and ≥20 s health read deadlines in isolation. Removed from request and timer paths by #6796 (`202b516b5a`): `readCurrentCatalogOrCache` uses the snapshot with async single-flight refresh. One synchronous version probe remains on `PUT /api/v2` mode-hint updates (`agent-settings-routes.ts:412 → features.ts:1157`), a management path. |
| 2 | Spend-journal synchronous append/checkpoint and Windows ACL hardening (`Bun.spawnSync`, 30 s hardening budget) | `src/lib/spend-reservation-ledger.ts:534,562,568,581`; `src/lib/windows-secret-acl.ts:372` | Source-plausible, still present. Reporter observed one production checkpoint with 0–174 ms health, which argues against it as the usual cause. |
| 3 | Inbound synchronous inflate/gunzip/zstd, decode, `JSON.parse`/`stringify`; caps are per request, not aggregate | `src/server/request-decompress.ts:253–276,327–335` | Source-plausible, unchanged since 2.77. Reporter's 32 MiB × 20 control peaked at 1.4 s health latency, not 20 s. Compressed bodies untested. |
| 4 | Response spill stringify/hash/`writeSync`/`fsyncSync` | `src/responses/spill-store.ts:325,332,502–505` | Source-plausible; the Windows ACL step is already async. |
| 5 | Catalog timer: PowerShell process enumeration `execFileSync` (8 s) and synchronous backup ACL | `src/codex/app-server-processes.ts:504`; `internal/catalog-writer.ts:99` | Hourly; bounded per call. |
| 6 | Coding-agent cleanup `taskkill /T /F` with no timeout | `src/adapters/coding-agent/turn.ts:60` | Unbounded but only for coding-agent turns; not shown in the reporter's OAuth traffic. |
| 7 | Bun runtime: Windows fetch streaming regression (#6684, fixed in Bun 1.4.1+, shipped 1.4.2 by #6713 `8d30945d50`), GC/external-memory pressure | — | A hung awaited stream alone would not block `/healthz`; global starvation needs stack evidence. Unresolved. |

## What the reporter should collect on the release that bundles Bun 1.4.2

- The runtime: `ocx observe memory --json` and `ocx system health --json` (authenticated
  `/api/system/memory`, `/api/system/health`) report OpenCodex version, Bun version/revision/source,
  pid/uptime, RSS/heap/external/arrayBuffers, app-owned/response/spill counters, active turns and
  watchdog timestamps. Sample them periodically, not only after a failure (they time out too
  during a stall).
- Externally, per `/healthz` probe: start/end, connect versus read failure, pid and process
  creation time, Windows build, CPU time, private bytes and working set.
- Load at the time: request concurrency, body sizes and `Content-Encoding`, and whether any
  `/v1/models` or management `PUT /api/v2` call was in flight.
- On recurrence, before killing: a thread stack or ETW sample of the bun.exe process. This is the
  only evidence that names the blocking frame.
- Whether the stall recurs at all on Bun 1.4.2, and whether the opt-in health sentinel (020)
  recovered it (its log line names the pid, streak and unhealthy span).

There is no event-loop-delay endpoint today; the memory watchdog's 60 s tick gaps are the only
in-process proxy for it. Raw heap dumps, request bodies and unredacted logs stay out of the
public issue.

