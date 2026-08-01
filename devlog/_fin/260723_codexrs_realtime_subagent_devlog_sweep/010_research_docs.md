# 010 — Write codex-rs / realtime / subagent research docs

## Objective

Create source-backed research artifacts in this unit from live local codex clones and OpenCodex source.

## Files (NEW under this unit)

| Path | Action | Content contract |
| --- | --- | --- |
| `010_local_pull_and_clones.md` | NEW | Absolute clone paths; remotes; pre/post SHAs; branch notes for 120 vs 121; command evidence of pull. |
| `011_realtime_surface.md` | NEW | Realtime API surface from local `codex-rs` + app-server README anchors: methods, versions v1/v2/v3, WebRTC limits, notifications ephemeral, session headers, initial_items. |
| `012_multi_agent_subagent.md` | NEW | `MAX_SPAWN_AGENT_MODEL_OVERRIDES=5`, model pins sol/terra v2 luna v1, expose/hide metadata defaults, `wait_agent_enabled`, fork_turns override rule, tool namespace collaboration. |
| `013_opencodex_impact.md` | NEW | Impact matrix against live OpenCodex files: `src/codex/catalog.ts`, `src/codex/features.ts`, `src/server/responses.ts`, `structure/03_catalog-and-subagents.md`. Mark each as already-handled / gap / out-of-scope. |
| `014_open_leads.md` | NEW | Unverified community/issue leads only; no product claims. |

## Source anchors (must re-verify at B time)

Local:
- `/Users/jun/Developer/codex/120_codex-cli` tip measured at pull: `4462b9dee`
- `/Users/jun/Developer/codex/121_openai-codex` feature branch preserved
- `codex-rs/core/src/tools/handlers/multi_agents_common.rs` (`MAX_SPAWN_AGENT_MODEL_OVERRIDES`)
- `codex-rs/core/src/config/mod.rs` multi_agent_v2 defaults
- `codex-rs/app-server/README.md` realtime section
- `codex-rs/protocol/src/protocol.rs` `RealtimeConversationVersion`
- `codex-rs/models-manager/models.json` multi_agent_version pins

OpenCodex:
- `src/codex/catalog.ts` featured-5 ranking + multiAgentMode
- `src/codex/features.ts` max_concurrent_threads only (no wait_agent_enabled yet)
- `src/server/responses.ts` injection guidance
- `src/server/index.ts` `/v1/*` 404 guard for realtime-ish endpoints

## Accept criteria

- Each doc cites absolute paths and SHAs measured live during B.
- Impact matrix rows have severity High/Med/Low and action (none/doc-only/future code).
- No product code edits.

## Verification

```bash
test -f devlog/_plan/260723_codexrs_realtime_subagent_devlog_sweep/010_local_pull_and_clones.md
rg -n "4462b9dee|MAX_SPAWN_AGENT_MODEL_OVERRIDES|wait_agent_enabled|thread/realtime/start"   devlog/_plan/260723_codexrs_realtime_subagent_devlog_sweep
```


## Execution status (WP1 B)

Artifacts written:

- `010_local_pull_and_clones.md`
- `011_realtime_surface.md`
- `012_multi_agent_subagent.md`
- `013_opencodex_impact.md`
- `014_open_leads.md`

All claims re-measured against clone tip `4462b9dee` and OpenCodex src on 2026-07-23.
