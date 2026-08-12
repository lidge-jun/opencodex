# 001 — Upstream config schema and feature-flag delta

Research only. No diffs, no implementation instructions.

Range: fork point `1f0566d3f` → `origin/main` `5a1097ed2`, read-only in
`/Users/jun/developer/codex/121_openai-codex`.

## 1. `[agents]` table changes

Upstream restructured the `[agents]` table. Current definition lives in
`codex-rs/config/src/config_toml.rs:681` (`AgentsToml`).

| Change | Key | Shape | Upstream description |
|---|---|---|---|
| Added | `enabled` | `boolean` | Whether multi-agent tools are enabled. Defaults to true. An enabled `features.multi_agent_v2` takes precedence. |
| Added | `max_concurrent_threads_per_session` | `integer`, `uint`, min 1 | Max spawned agent threads open concurrently per session. Unset means the backend default. |
| Added | `default_subagent_model` | `string` | Default model for spawned subagents when the spawn call does not select one. |
| Added | `default_subagent_reasoning_effort` | `ReasoningEffort` | Same, for reasoning effort. |
| Removed | `max_threads` | `integer` | Superseded; retained as a deserialize alias. |
| Removed | `job_max_runtime_seconds` | `integer` | Agent-job setting; still present in the struct as a `#[schemars(skip)]` no-op. |
| Changed | `max_depth` | min-1 constraint dropped | Was "max nesting depth for spawned agent threads". Now "Maximum nesting depth for V1 agent threads. Ignored by V2." |

Introduced by `03bb3b123` (Unify multi-agent settings under `agents`, #33550).

## 2. Backend selection precedence

`multi_agent_version_override` establishes a three-way precedence:

1. `features.multi_agent_v2` enabled → V2, unconditionally.
2. Otherwise `[agents].enabled = false` → multi-agent disabled.
3. Otherwise model metadata or legacy `collab` selects the backend.

So `agents.enabled` is a user-facing off switch that an explicitly enabled V2 feature
flag overrides. It is not a mirror of the feature flag.

## 3. The concurrency translation (load-bearing)

`resolve_multi_agent_v2_config` in `codex-rs/core/src/config/mod.rs:2674` reads the
V2-native key first, and only falls back to the `[agents]` key with
`saturating_add(1)`:

- `features.multi_agent_v2.max_concurrent_threads_per_session = N` → V2 limit `N`.
- `[agents].max_concurrent_threads_per_session = N` (no V2 key) → V2 limit `N + 1`.

The `+1` exists because the V2 limit counts the root agent's own slot, while the
`[agents]` number counts spawned children. The two keys are therefore **not**
interchangeable, which is the root of the defect documented in `010`.

## 4. `multi_agent_v2` feature-config additions

`MultiAgentV2ConfigToml` lives in `codex-rs/features/src/feature_configs.rs:72`, not in
the config crate. New fields in range:

| Key | Shape | Purpose |
|---|---|---|
| `subagent_developer_instructions` | `string` | Overrides inherited developer instructions for subagents without role-specific instructions. |
| `expose_spawn_agent_model_overrides` | `boolean` | Exposes `model` and `reasoning_effort` on the v2 spawn tool; adds matching usage-hint guidance. |
| `wait_agent_enabled` | `boolean` | Exposes the v2 `wait_agent` tool. |

The struct carries `#[serde(deny_unknown_fields)]`, so an unrecognized key under
`[features.multi_agent_v2]` is a hard parse error rather than an ignored value.

## 5. Feature-flag stage and default changes

No `Feature` enum variants were removed in range. Added and stage-changed:

| Variant | Key | Old stage | New stage | Default |
|---|---|---|---|---|
| `MultiAgentV2` | `multi_agent_v2` | UnderDevelopment | **Stable** | `false` |
| `SpawnCsv` | `enable_fanout` | UnderDevelopment | **Removed** | `false` |
| `ItemIds` | `item_ids` | UnderDevelopment | **Removed** | `true` |
| `CodeModeBufferedExec` | `code_mode_buffered_exec` | — | UnderDevelopment | `false` |
| `ExternalAgentMemoryImport` | `external_agent_memory_import` | — | UnderDevelopment | `false` |
| `Mcp20260728` | `mcp_2026_07_28` | — | UnderDevelopment | `false` |
| `DeferredToolWorldState` | `deferred_tool_world_state` | — | UnderDevelopment | `false` |
| `ExecutorCapabilityDiscovery` | `executor_capability_discovery` | — | UnderDevelopment | `false` |
| `GuardianV2` | `guardianv2` | — | UnderDevelopment | `false` |
| `RecommendedPlugins` | `recommended_plugins` | — | Stable | `false` |
| `InAppUpdates` | `in_app_updates` | — | Stable | `true` |
| `SkillSearch` | `skill_search` | — | Stable | `true` |

`Removed` flags are silently skipped during parse rather than rejected, so a stale
`enable_fanout` or `item_ids` in a user's config is inert, not an error.

## 6. `code_mode_host` shape change

`features.code_mode_host` changed from a bare `boolean` to
`FeatureToml<CodeModeHostConfigToml>`, i.e. either a boolean or a table with
`enabled` and `disable_in_process_fallback`. Any consumer that assumes boolean-only
will mis-handle the table form.

## 7. Alias registry

`codex-rs/config/src/key_aliases.rs` holds the complete alias registry:

| Legacy key | Canonical key |
|---|---|
| `[agents].max_threads` | `[agents].max_concurrent_threads_per_session` |
| `[memories].no_memories_if_mcp_or_web_search` | `[memories].disable_on_external_context` |

Normalization removes the legacy key and inserts the canonical one only when the
canonical key is absent, so an explicit canonical value always wins. There is
additionally a field-level `#[serde(alias = "max_threads")]` on the struct field, so
the alias is honored at two layers.

## 8. Realtime version enum

`RealtimeConversationVersion` went from `["v1", "v2"]` to `["v1", "v2", "v3"]`.
Details in `002`.

## Verified SHAs

```
03bb3b123 Unify multi-agent settings under `agents` (#33550)
b00c9b2e1 Mark multi-agent v2 as stable (#34383)
49025589b Add configurable developer instructions for v2 subagents (#35708)
ea1545628 Expose model overrides for multi-agent v2 spawns (#32749)
4462b9dee Allow disabling the multi-agent wait tool (#34887)
687f05cb9 Remove CSV-backed agent jobs (#34413)
4a443994b Always assign response item IDs (#34645)
99efeef65 Add buffered code-mode exec yields (#34441)
cba0e2701 Allow disabling the in-process code-mode host fallback (#35266)
65ae4c26e Register the MCP 2026-07-28 feature flag (#34747)
1d4b58f32 Track deferred tool namespaces in world state (#35063)
bb24b67d3 Register the Guardian V2 feature flag (#35049)
08e30a2e4 Add batched executor capability discovery (#33852)
3a797496f Decouple recommended plugins from tool suggestions (#35839)
95637f705 Add managed policy for in-app updates (#35537)
4477b2071 Enable skill search shadow selection by default (#32780)
7d1218a99 Add external agent memory migration (#33444)
2e1607ee2 Add Frameless Bidi support for realtime conversations (#33261)
```
