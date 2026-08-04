# 013 — OpenCodex impact matrix (live src)

Measured against OpenCodex tree at worktime on 2026-07-23. No product patches in this goal.

| Area | Live OpenCodex anchor | Upstream contract | Status | Severity | Action |
| --- | --- | --- | --- | --- | --- |
| Featured first-5 spawn overrides | `src/codex/catalog.ts` (`MAX_SPAWN_AGENT_MODEL_OVERRIDES = 5`, priority rank 0..4) | `MAX_SPAWN_AGENT_MODEL_OVERRIDES=5` + picker-visible filter | Handled | High | Keep; verify featured routed models also pass backend pin filter |
| multi_agent_version override mode | `structure/03_catalog-and-subagents.md`, `catalog.ts` multiAgentMode v1/default/v2 | model pins sol/terra v2, luna v1 | Handled | High | Keep default mode; document force-v2 for routed overrides |
| max concurrent threads | `src/codex/features.ts` read/write `max_concurrent_threads_per_session` | multi_agent_v2 config | Handled | Med | Keep migration safety |
| wait_agent_enabled | **absent** in `src/codex/features.ts` / management-api | default true; can disable on tip | Gap | Med | Future: expose read/status; not blocking while default true |
| expose_spawn_agent_model_overrides / hide metadata | not managed by OpenCodex config helpers | defaults expose overrides=true, hide metadata=true | Gap/Observability | Med | Guidance text must not claim fields always hidden |
| injection guidance | `src/server/responses.ts` multi_agent guidance + fork_turns none | override + fork rules | Partial | High | Ensure roster eligibility uses v2-compatible first-5, not mere catalog presence (#295 family) |
| /v1 unknown endpoints | `src/server/index.ts` JSON 404 for unknown `/v1/*` | realtime/memories clients need clean errors | Handled | Med | Keep |
| Realtime proxying | no realtime data plane | app-server experimental realtime | Out-of-scope | Low | Document boundary only |
| Item ID / store:false | adapters/history work (existing units) | response item id assignment hardening | Ongoing | High | Separate unit; not this sweep |
| upstream-models pins | `src/codex/data/upstream-models.json` | models.json pins | Match on measured tip for sol/terra/luna | Med | Re-sync when pins change |

## Practical OpenCodex risks from this pull

1. **V2 roster mismatch:** featuring Luna (v1 pin) on a v2 turn yields spawn rejection even if catalog lists it.
2. **Guidance schema drift:** defaults expose model/effort overrides; absolute "hidden args" wording is stale when expose flag true.
3. **wait_agent disable:** rare user config can remove wait tool; OpenCodex guidance currently assumes wait exists.
4. **Realtime:** no implementation work needed; only avoid false support claims and keep 404 hygiene.
