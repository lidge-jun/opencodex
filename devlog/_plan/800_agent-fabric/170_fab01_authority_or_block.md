---
title: FAB-01 Authority or Block
programme_id: OCAF
phase: FAB-00
date: 2026-08-03
---

# 170 -- FAB-01 Authority or Block

## FAB-01 authority status: NOT YET GRANTED (blockers resolved)

FAB-01 (read-only Task Inspector) is **not** yet authorised. The two maintainer-authority blockers are now **resolved** (`120`/`030` on 2026-08-03): language authority = TS-native Supervisor; product placement = opencodex subsystem.

## Remaining prerequisites for FAB-01 authority (all required)

1. Independent FAB-00 acceptance (`PASS`) per the acceptance model (`160`).
2. ~~Maintainer decision on language authority~~ **DONE** -- TS-native Supervisor (`120`).
3. ~~Maintainer decision on product placement~~ **DONE** -- opencodex subsystem (`030` sec.2).
4. Create `AGENTS.md`/`CONTRIBUTING.md` governance for the new subsystem (gap in `010` sec.4).
5. Update master plan sec.7 to record the decided authority (see the FAB-00 correction in `000`).

## Explicit FAB-01 execution authority

Still required from the maintainer before any FAB-01 production code. The FAB-01 branch base is `dev` (not `main`), per the repo integration line and `120` sec.6.

## Exact FAB-01 scope (when authorised)

Fabric database + event store + projections + artifact store + Task CLI + read-only Codex importer + usage correlation + Task Inspector dashboard. **No runtime ownership or handoff** (those are FAB-02+). Inherits the contracts from `060`/`070` (protobuf envelope, normalised events, adapter contract) and the persistence/lease model from `090`.

## Statement

`FAB-01 IS NOT AUTHORISED BY THIS HANDOFF ALONE.`
