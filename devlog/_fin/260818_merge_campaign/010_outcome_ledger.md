# 010 — Outcome ledger

Campaign executed 2026-08-18, single session, two merge work-phases plus this
closeout. All merges to `dev`; `main`/`preview` untouched (release train is
maintainer-owned and ran separately as v2.25.0).

## WP1 — Windows stack (DONE)

| PR | merged (UTC) | validation |
|---|---|---|
| #1944 argv fix | 08:36:30 | scratch-merge: windows-popup-fix 7/0 + tsc; grok-4.6 lens: win32-gated argv-only, exact-head CI green |
| #1945 wrapper killer | 08:43:31 | scratch-merge on post-1944 dev: 7/0 + tsc |
| #1946 shared atomic-replace | 08:47:01 | scratch-merge on post-1945 dev: popup+config 158/0 + tsc |
| #1947 retry counters | 08:47:24 | scratch-merge on post-1946 dev: 158/0 + tsc; UNSTABLE state was cancelled duplicate jobs, real ci green |
| #1949 devlog opener | 08:47:29 | docs-only (windows stability program unit) |

Stack order preserved: each child retargeted to `dev` only after its parent
merged. Landed tip verified: 158/0 + tsc on `ca32042a2`.

Note: #1942/#1849 do NOT close with this stack (audit finding) — they need
their own fixes on top of the landed foundation.

## WP2 — FastWire train (DONE)

| PR | outcome | validation |
|---|---|---|
| #1893 A1 refactor | MERGED `c0b556a28` | stale-base residual (275 behind) discharged: scratch-merge onto current dev, 4 suites 279/0 + tsc |
| #1965 B1 capability migration | MERGED `c78f811d1` | GitHub stale-conflict state resolved by pushing the dev merge to the head (0ceb06142); exact pushed head: 5 suites 313/0 + tsc; review threads all resolved |
| #1956 B0 observability | CLOSED superseded | ancestry-proven: B1 head contained B0 head `4d87bce04`; closed to prevent double-landing |
| #1904 chat tier copy | MERGED | post-1965 dev scratch-merge: 112/0 + tsc; hunk overlap with B1 disjoint |
| #1885 xAI Priority | HELD open | untouched behind the #1875 B2 pricing gate, as planned |

Landed tip verified: fastwire family 313/0 + tsc on `237f8c080` (receipt in
session evidence).

## Residual corrections from plan audit

- L1: success-criteria checklist in 000 was written before #1944 landed; this
  ledger is the authoritative record.
- M1 (A1 stale base) and M2 (B0/B1 exclusive-or): both discharged as recorded
  above.

## Terminal outcome

DONE. Nine PRs terminal (8 merged + 1 superseded-closed), hold preserved,
every merge validated at the exact tree that landed.

