# ADR-0013 — Codex home

- Contract owner: [codex-home.md](../codex-home.md#codex-home)

## Decision record

- 목적과 의도: Bound the durable spill directory in aggregate so demoted continuation state cannot consume the host disk.
- 기존 구현 및 제약 조건: The resident map has an unconditional byte cap and demotes past it, but the disk it demotes onto had only a per-file ceiling and the shared 1000-entry count cap. Retention itself worked — the hour-long TTL did evict — so the gap was a missing budget, not a leak.
- 검토한 주요 대안: Lower the per-file ceiling; shorten the TTL; sweep the directory on a timer; add a configurable budget key; carry a running byte counter.
- 선택한 방식: A constant aggregate ceiling checked at the end of the existing prune, evicting oldest-first, with the total recomputed per prune rather than carried as a counter.
- 다른 대안 대신 이 방식을 선택한 이유: Per-file or TTL changes alter retention semantics other bounds depend on; a timer adds a second owner for eviction; a config key would surface a knob the sibling bounds (count, TTL, per-file) do not have; and a running counter could silently disable the cap if any of the several insertion paths missed an increment, where a walk over at most 1000 entries cannot drift.
- 장점, 단점 및 영향: Disk use stops tracking client request rate. Ordinary traffic is unaffected because the count cap binds at a comparable point for median-sized payloads; a workload of unusually large continuations loses its oldest spills earlier than the TTL would, surfacing as the existing `previous_response_not_found` continuation miss.
