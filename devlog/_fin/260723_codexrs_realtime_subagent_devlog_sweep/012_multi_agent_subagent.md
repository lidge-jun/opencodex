# 012 — Multi-agent / subagent contracts (local codex-rs)

Tip: `4462b9dee`

## Constants / defaults

From `codex-rs/core/src/tools/handlers/multi_agents_common.rs`:

```rust
pub(crate) const MAX_SPAWN_AGENT_MODEL_OVERRIDES: usize = 5;
```

`model_supports_multi_agent_backend`: for V2, model must pin `multi_agent_version == Some(V2)`; non-V2 surfaces accept broader sets.

From `codex-rs/core/src/config/mod.rs` `MultiAgentV2Config` defaults:

- `hide_spawn_agent_metadata: true`
- `expose_spawn_agent_model_overrides: true`
- `wait_agent_enabled: true`
- `max_concurrent_threads_per_session` required >= 1

Tip commit `4462b9dee` (#34887) adds ability to disable `wait_agent` independently of sleep tool.

## Spawn advertisement rule

`spawn_agent_models_description` / `find_spawn_agent_model_name`:

1. filter `show_in_picker`
2. filter backend support for active multi_agent_version
3. `.take(MAX_SPAWN_AGENT_MODEL_OVERRIDES)` (5)

Reasoning effort on spawn is validated against the selected model supported levels; unsupported effort hard-fails with available list.

## Model pins (models.json / OpenCodex upstream snapshot match)

Measured equal pins in:

- `/Users/jun/Developer/codex/120_codex-cli/codex-rs/models-manager/models.json`
- `/Users/jun/Developer/new/700_projects/opencodex/src/codex/data/upstream-models.json`

| slug | multi_agent_version |
| --- | --- |
| gpt-5.6-sol | v2 |
| gpt-5.6-terra | v2 |
| gpt-5.6-luna | v1 |
| others measured null | feature flag decides |

## Fork / override rule (source + issue lead)

Full-history forks inherit parent model/effort and reject overrides; overrides require non-full-history fork (`fork_turns: "none"` or partial). This is reflected in default multi-agent v2 usage hint text in `config/mod.rs` and in upstream issue #20077 (lead).

## Tool surface notes

- V1 tools: spawn/wait/send/close/resume family under multi_agent_v1 naming on product surfaces.
- V2 collaboration tools live under collaboration namespace; cannot be called inside `functions.exec` (default shared usage hint).
- `b00c9b2e1` marks multi-agent v2 stable in features crate.

## Stability / lifecycle leads (not product guarantees)

- Slot leak / need explicit close (issue reports)
- Encrypted spawn args backend mismatches (issue #26753 lead)
