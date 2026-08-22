# Lane A — upstream multi-agent v2 wire surface

Research baseline: upstream checkout `/Users/jun/Developer/codex/121_openai-codex`, branch `main`, HEAD `9dd22890f5ff47e4af128c20e32b9758a61d78d2` (2026-08-12). OPENCODEX baseline: `/Users/jun/.codex/worktrees/e80c/opencodex`, detached worktree HEAD as inspected on 2026-08-16. Both repositories were read-only during research; this file is the only write.

## Executive result

Multi-agent runtime selection is **per model**, then made sticky per thread. The provider catalog wire is `models[].multi_agent_version` (snake case); app-server JSON-RPC `model/list` exposes the same value as `data[].multiAgentVersion` (camel case), with values `"disabled" | "v1" | "v2" | null`.

The decisive upstream change is `6d4d9442c7142c08ac5c5098dfd6e82d8cd9f65a`: a v2 parent may target every catalog model except one explicitly marked `disabled`. A target marked `v2` can recursively delegate; a target marked `v1` or with the field absent/null runs as a **leaf worker** and receives no collaboration tools. Thus `gpt-5.6-luna` (`multi_agent_version: "v1"`) is a valid child of a v2 parent, but is a leaf.

OPENCODEX already carries the catalog field, but its default-mode implementation still encodes the superseded pre-`6d4d9442` equality rule: when the v2 feature is enabled it stamps every unpinned row as `v2`. That makes routed leaf workers look recursively v2-capable. The first implementation change should remove that blanket stamp in `default` mode while retaining explicit `v1`, `v2`, and `disabled` values.

## Verified commits

All requested anchors resolve in the checkout and were verified with `git show --stat`.

| Commit | Date | Verified relevance |
| --- | --- | --- |
| `51e36d2ec23c0eff710053d28c400d447500a41a` | 2026-08-07 | Adds nullable `multiAgentVersion` to app-server v2 `model/list`, forwarding the model preset value. |
| `6d4d9442c7142c08ac5c5098dfd6e82d8cd9f65a` | 2026-08-04 | Changes v2 target eligibility from “catalog value equals v2” to “catalog value is not disabled”; suppresses collaboration tools for non-v2 child models. |
| `92b83e226df59dc5ec43a49259d7716821e20c85` | 2026-08-06 | Tracks v2 usage-hint hashes in world state so resume/config changes re-emit the right instructions; moves wait guidance into configurable instructions. |
| `0da13c6c993cbb6de3ce88591b316a40cbd411b1` | 2026-07-22 | Tracks effective multi-agent mode instructions as a durable/diffed world-state section. This is prompt/history state, not catalog eligibility. |
| `4462b9deef211723b781b426f5e5d36a5777115f` | 2026-07-23 | Adds default-on `features.multi_agent_v2.wait_agent_enabled`; omits v2 `wait_agent` when false. |
| `c4f42d161ae44a8d696ee9fb595709661979d187` | 2026-08-05 | Uses `gpt-5.6-luna` for API-key Guardian reviews. It does not alter delegation eligibility or tool schemas. |
| `3fe19fcd81559e543ea0747c1927b2d3a36a6885` | 2026-08-12 | Lazily resolves subagent analytics connections. No catalog/tool wire change. |
| `1151b23f01accb19e55c090a3349a32fdf2b4685` | 2026-08-06 | Lazily starts cached MCP servers for subagents. No catalog/tool schema change. |
| `4ffeddcbcc0dd72251433abff1ca9423e8017008` | 2026-08-06 | Fixes TUI subagent MCP startup-status settling. No catalog/tool schema change. |

Supporting provenance: `3f1fb7ed8b641542add19bb841e4e4be5651693e` introduced the runtime metadata types; `92938d880eccbad1242a86a63f819f67780f68c0` added backend-aware spawn-model filtering and the five-model cap; `ea1545628404e448347bae336771eaf649614105` exposed v2 model/effort overrides; `6ddb747e7687e9e6e3a2482631028c07ddc89cb6` renamed v2 `assign_task` to `followup_task`; `8d415050fce4b4ebc6da1ba247379844235fa453` renamed v2 `close_agent` to `interrupt_agent`; `5f4d06ef186b896d316620556e561d59206c3ebf` marked v2 message payloads encrypted.

## 1. Exact catalog and app-server wire shape

### Provider `/models` catalog

`codex-rs/protocol/src/openai_models.rs:L372-L461` — `ModelInfo` is the backend `/models` row. Its field is:

```json
{
  "models": [
    {
      "slug": "gpt-5.6-luna",
      "multi_agent_version": "v1"
    }
  ]
}
```

- Field: `models[].multi_agent_version`.
- Values: `"disabled"`, `"v1"`, `"v2"`, or omitted/null.
- Enum definition: `codex-rs/protocol/src/protocol.rs:L2822-L2829` — `MultiAgentVersion`, serialized with `#[serde(rename_all = "snake_case")]`.
- Forward compatibility: `ModelInfo.multi_agent_version` uses `deserialize_optional_model_selector` at `openai_models.rs:L322-L331,L455-L460`; an unknown future string becomes `None`, proven by `model_info_treats_unknown_multi_agent_version_as_omitted` at `L1491-L1504`.
- Conversion: `impl From<ModelInfo> for ModelPreset` at `openai_models.rs:L723-L755` copies it unchanged.

### App-server JSON-RPC `model/list`

`codex-rs/app-server-protocol/src/protocol/v2/model.rs:L27-L34,L89-L121` — `MultiAgentVersion` and `Model` serialize with model fields in camel case:

```json
{
  "data": [
    {
      "id": "gpt-5.6-luna",
      "model": "gpt-5.6-luna",
      "multiAgentVersion": "v1"
    }
  ],
  "nextCursor": null
}
```

- Field: `data[].multiAgentVersion`.
- Values: `"disabled" | "v1" | "v2" | null`.
- Mapping: `codex-rs/app-server/src/models.rs:L27-L62` — `model_from_preset`, specifically `preset.multi_agent_version.map(Into::into)`.
- Generated contract: `app-server-protocol/schema/typescript/v2/Model.ts` declares `multiAgentVersion: MultiAgentVersion | null`; `MultiAgentVersion.ts` declares the three strings. The JSON Schema permits the property to be absent for tolerant readers, but Rust serialization emits `null` for `None` because the field has no `skip_serializing_if`.

This is **per-model**, not per-account. Account/auth state can change which models reach the list: `ModelPreset::filter_by_auth` at `openai_models.rs:L786-L795` keeps all models in ChatGPT mode but requires `supported_in_api: true` otherwise. The `multi_agent_version` value itself belongs to each model row; there is no account-level multi-agent field.

## 2. V1 versus V2 decision and precedence

The core decision function is `Config::multi_agent_version_for_model` in `codex-rs/core/src/config/mod.rs:L1543-L1550`:

```rust
self.multi_agent_version_override()
    .or(model_multi_agent_version)
    .unwrap_or_else(|| self.multi_agent_version_from_features())
```

The full precedence is:

1. `features.multi_agent_v2` enabled -> `V2` (`multi_agent_version_override`, `L1523-L1531`). This wins even if `[agents] enabled = false`.
2. Otherwise `[agents] enabled = false` -> `Disabled`.
3. Otherwise use the selected model's catalog `multi_agent_version`, if present.
4. Otherwise stable feature `multi_agent`/`Feature::Collab` -> `V1`; if that feature is disabled -> `Disabled` (`multi_agent_version_from_features`, `L1533-L1541`).

`Feature::Collab` is stable/default-on and `Feature::MultiAgentV2` is stable/default-off at `codex-rs/features/src/lib.rs:L1067-L1078`.

Selection is sticky per thread. `Session::resolve_multi_agent_version_for_model` at `codex-rs/core/src/session/mod.rs:L3402-L3425` reuses the thread's `OnceLock` value if set; otherwise it resolves from the model and stores it. `resolve_multi_agent_version` at `L469-L485` restores persisted/inherited metadata and defaults older resumed/forked threads without metadata to V1. Consequently a mid-thread model switch does not normally switch the collaboration protocol.

## 3. Leaf models in v2

At this HEAD, “leaf” is behavioral, not a separate enum or JSON field.

- Eligibility: `model_supports_multi_agent_backend` at `codex-rs/core/src/tools/handlers/multi_agents_common.rs:L36-L42` allows every model under a v2 parent except `multi_agent_version == Some(Disabled)`.
- Recursion: `collab_tools_enabled` at `codex-rs/core/src/tools/spec_plan.rs:L599-L610` exposes collaboration tools to a v2 root, but for a child (`session_source.get_agent_path().is_some()`) requires the child model's catalog value to be exactly `Some(V2)`.

Therefore:

| Catalog value on target | Offered to v2 parent? | Child receives v2 collaboration tools? | Meaning |
| --- | --- | --- | --- |
| `"v2"` | Yes | Yes | Recursive/delegating v2 model. |
| `"v1"` | Yes | No | Leaf worker under a v2 parent. |
| omitted/null | Yes | No | Leaf worker under a v2 parent. |
| `"disabled"` | No | No | Explicitly ineligible for v2 delegation. |

The checked-in upstream catalog `codex-rs/models-manager/models.json` represents `gpt-5.6-sol` and `gpt-5.6-terra` as `v2`, `gpt-5.6-luna` as `v1`, and gpt-5.5/gpt-5.4/gpt-5.4-mini/gpt-5.2 with the field absent. Luna and the absent-value models are thus leaf targets, not rejected targets.

## 4. Exact tool-surface diff

Tool specifications come from `codex-rs/core/src/tools/handlers/multi_agents_spec.rs`. Every input object schema sets `additionalProperties: false`; all tools set `strict: false`.

### Naming and namespace

- V1 is always the Responses namespace `multi_agent_v1` (`MULTI_AGENT_V1_NAMESPACE`, `L14-L15`). Its members are `spawn_agent`, `send_input`, `resume_agent`, `wait_agent`, and `close_agent`.
- V2's exact spawn name is **`spawn_agent`**, not `spawn`. V2 also has `send_message`, `followup_task`, `wait_agent`, `interrupt_agent`, and `list_agents`.
- V2 defaults to namespace `collaboration` (`DEFAULT_MULTI_AGENT_V2_TOOL_NAMESPACE`, `config/mod.rs:L254`). `multi_agent_v2_handler` at `spec_plan.rs:L1293-L1323` wraps tools in that namespace only when provider namespace tools are enabled and the configured namespace is non-null; otherwise they are flat functions.

### Input schemas

| Tool | Required fields | Optional fields | Notes |
| --- | --- | --- | --- |
| V1 `spawn_agent` | Schema declares none; runtime requires exactly one of `message` or `items`. | `message: string`, `items: UserInput[]`, `agent_type: string`, `fork_context: boolean`, `model: string`, `reasoning_effort: string`, `service_tier: string` | `fork_context=true` means full-history fork. Output `{agent_id, nickname}`. |
| V1 `send_input` | `target: string`; runtime also requires exactly one of `message`/`items`. | `message: string`, `items: UserInput[]`, `interrupt: boolean` | Output `{submission_id}`. `interrupt=true` redirects immediately. |
| V1 `resume_agent` | `id: string` | none | Output `{status}`. |
| V1 `wait_agent` | `targets: string[]` | `timeout_ms: number` | Waits for whichever listed agent finishes; output `{status: {id: AgentStatus}, timed_out}` and may include final content. |
| V1 `close_agent` | `target: string` | none | Shuts down target and descendants; output `{previous_status}`. |
| V2 `spawn_agent` | `task_name: string`, `message: string` | `agent_type: string`, `model: string`, `reasoning_effort: string`, `service_tier: string`, `fork_turns: string` | `message` schema carries `"encrypted": true`. `fork_turns` accepts `none`, `all` (default), or a positive integer string. Output `{task_name}` by default (`hide_spawn_agent_metadata=true`), else `{task_name,nickname}`. |
| V2 `send_message` | `target: string`, `message: string` | none | `message` encrypted; queues promptly but does not trigger a turn. No output schema. |
| V2 `followup_task` | `target: string`, `message: string` | none | `message` encrypted; triggers an idle non-root target or delivers at a boundary. No output schema. |
| V2 `wait_agent` | none | `timeout_ms: number` | Mailbox-wide wait, not target-specific. It returns no agent content: `{message, timed_out}`. |
| V2 `interrupt_agent` | `target: string` | none | Interrupts current turn but leaves the agent available; output `{previous_status}`. |
| V2 `list_agents` | none | `path_prefix: string` | Additional v2 tool omitted from the question's list; output `{agents:[{agent_name,agent_status}]}`. |

V1 property builders are at `multi_agents_spec.rs:L586-L629` and V1 wait parameters at `L848-L874`. V2 properties are at `L631-L673` and v2 wait parameters at `L876-L885`. Output schemas are at `L360-L543`.

### Dynamic schema controls

`create_spawn_agent_tool_v2` at `multi_agents_spec.rs:L102-L146` changes the exposed fields:

- `features.multi_agent_v2.expose_spawn_agent_model_overrides=false` removes `model` and `reasoning_effort` (default is true).
- If no agent roles exist, `agent_type` is removed.
- `hide_spawn_agent_metadata=true` (default) removes `service_tier` and hides nickname in output; current code still exposes model/reasoning when their separate flag is true.
- `wait_agent_enabled=false` omits v2 `wait_agent` entirely (`spec_plan.rs:L1166-L1173`).

Default guidance at `config/mod.rs:L253` tells the model not to combine model/effort overrides with a full-history fork, but this is **guidance, not a runtime rejection at this HEAD**. `handle_spawn_agent` applies requested overrides before forking (`multi_agents_v2/spawn.rs:L39-L99`), and `spawned_full_history_v2_child_uses_model_precedence_without_dropping_context` (`core/tests/suite/subagent_notifications.rs:L1040-L1087`) proves an explicit override with `fork_turns:"all"` is honored. The hard parser rules are narrower: `SpawnAgentArgs::fork_mode` at `multi_agents_v2/spawn.rs:L191-L238` rejects legacy `fork_context` and validates `fork_turns` as `none`, `all`, or a positive integer string.

### `deny_unknown_fields`

- Every v2 runtime argument struct has `#[serde(deny_unknown_fields)]`: spawn (`multi_agents_v2/spawn.rs:L191-L202`), send/followup (`message_tool.rs:L26-L40`), wait (`wait.rs:L123-L127`), interrupt (`interrupt_agent.rs:L104-L108`), and list (`list_agents.rs:L57-L61`). Unknown input keys fail parsing.
- V1 runtime structs do **not** use `deny_unknown_fields`: spawn (`multi_agents/spawn.rs:L234-L244`), send (`send_input.rs:L130-L137`), wait (`wait.rs:L273-L278`), close (`close_agent.rs:L161-L164`), resume (`resume_agent.rs:L163-L166`). Their published schemas still say `additionalProperties:false`, but serde will ignore an unknown key if it reaches the runtime. This is a real behavioral difference.
- V2 `SpawnAgentArgs` deliberately includes `fork_context: Option<bool>` even though it is absent from the schema, solely to emit the specific migration error “use fork_turns instead”; it is therefore a recognized-but-rejected legacy key, not an unknown key.

## 5. Config and feature gates

Primary gates and defaults:

- `[features] multi_agent_v2 = true` or `[features.multi_agent_v2] enabled = true`: force V2. Stable feature, default false.
- `[features] multi_agent = ...`: legacy V1 feature (`Feature::Collab`), stable/default true.
- `[agents] enabled = false`: disables collaboration only when v2 is not explicitly enabled.
- `features.multi_agent_v2.wait_agent_enabled`: default true; controls only v2 `wait_agent`.
- `features.multi_agent_v2.expose_spawn_agent_model_overrides`: default true.
- `features.multi_agent_v2.hide_spawn_agent_metadata`: default true.
- `features.multi_agent_v2.tool_namespace`: default `"collaboration"`.
- `features.multi_agent_v2.non_code_mode_only`: default true (direct-model-only exposure).
- Other v2 config fields include min/max/default wait timeouts, usage/root/subagent hints, `subagent_developer_instructions`, and `multi_agent_mode_hint_text`. The TOML struct is `MultiAgentV2ConfigToml` at `codex-rs/features/src/feature_configs.rs:L74-L119`, with `deny_unknown_fields`.

Runtime defaults are in `MultiAgentV2Config::defaults_for_max_concurrency` at `core/src/config/mod.rs:L1291-L1325`; parsing/default resolution is `resolve_multi_agent_v2_config` at `L2678-L2777`.

### Concurrency semantics

- V1 default: `DEFAULT_AGENT_MAX_THREADS = 6` (`config/mod.rs:L209`). The root is not counted; this is the maximum spawned/open child threads.
- V2 default: `features.multi_agent_v2.max_concurrent_threads_per_session = 4` (`L210`). The root **is counted**, so `effective_agent_max_threads` subtracts one (`L1552-L1565`), yielding three child slots.
- Current canonical shared key: `[agents] max_concurrent_threads_per_session`; legacy `[agents] max_threads` is a serde/config-normalization alias (`config/src/config_toml.rs:L660-L672`, `config/src/key_aliases.rs:L11-L21`). Under V1 its value is the child limit. When used as the fallback for V2, `resolve_multi_agent_v2_config` adds one (`config/mod.rs:L2680-L2689`) so the same configured N child slots become N+1 total slots.
- A value directly under `[features.multi_agent_v2]` is already the total including root and is not incremented.

## REQUIRED CATALOG CONTRACT

This is the proxy-author implementation contract at upstream HEAD `9dd22890f`.

### A. Transport shape

Return provider catalog JSON as an object with `models: ModelInfo[]`. For each row, use snake-case `multi_agent_version`. Do not send app-server camel-case `multiAgentVersion` to `/models`; that name belongs only in JSON-RPC `model/list` output.

The delegation-specific minimum is:

```json
{
  "slug": "provider/model-id",
  "display_name": "Model name",
  "description": "What the model is for",
  "visibility": "list",
  "supported_in_api": true,
  "priority": 10,
  "supported_reasoning_levels": [
    { "effort": "medium", "description": "Balanced" }
  ],
  "default_reasoning_level": "medium",
  "service_tiers": [],
  "multi_agent_version": "v1"
}
```

That snippet shows delegation-relevant fields, not the entire `ModelInfo` parse contract. A standalone proxy row must also satisfy the non-defaulted `ModelInfo` fields at this HEAD: `shell_type`, `support_verbosity`, `truncation_policy`, `supports_parallel_tool_calls`, and `experimental_supported_tools` (plus the fields above). OPENCODEX's `ensureStrictCatalogFields` already fills most of these on generated rows.

### B. Exact eligibility conditions for being *offered* in `spawn_agent`

The list comes from `TurnContext.available_models`, loaded from `ModelsManager::try_list_models`/`list_models` (`turn_context.rs:L574,L327-L332`). `ModelsManager::build_available_models` (`models-manager/src/manager.rs:L125-L138`) sorts by ascending `priority`, converts to presets, and auth-filters.

A row is described to the model as an available override iff all are true:

1. It survives auth filtering: ChatGPT mode accepts all; non-ChatGPT/API mode requires `supported_in_api: true` (`openai_models.rs:L786-L795`).
2. `visibility == "list"`, which converts to `ModelPreset.show_in_picker=true` (`openai_models.rs:L750`).
3. Under a v2 parent, `multi_agent_version` is not explicit `"disabled"`; under non-v2, this particular backend filter imposes no additional catalog condition (`multi_agents_common.rs:L36-L42`).
4. It falls within the first five eligible rows after ascending-priority ordering: `MAX_SPAWN_AGENT_MODEL_OVERRIDES=5` and `spawn_agent_models_description` at `multi_agents_spec.rs:L781-L846`.
5. V2 model overrides are exposed (`features.multi_agent_v2.expose_spawn_agent_model_overrides=true`). If false, the model list and `model`/`reasoning_effort` fields are absent from the v2 spawn schema (`L102-L119`).

No other capability bit gates the target list. In particular, `supports_parallel_tool_calls`, search support, tool mode, service tiers, and reasoning support do not decide eligibility. Reasoning and service-tier metadata only annotate/validate the selected override.

Runtime selection is slightly broader than “offered”: `find_spawn_agent_model_name` at `multi_agents_common.rs:L431-L456` accepts any exact model present in `available_models` and backend-compatible, even if hidden or beyond the first five; the visible/top-five filter is used only to construct the advertised list and error message. A proxy should not rely on hidden status as an authorization barrier.

### C. Capability values a proxy should emit

- Emit `"v2"` only when the child should receive collaboration tools and may recursively delegate.
- Emit `"v1"` or omit/null when it may be selected as a v2 child but should remain a leaf. Preserve upstream `v1` for Luna.
- Emit `"disabled"` only to exclude the model from v2 delegation entirely.
- Preserve explicit upstream/provider values. Unknown future values are treated as absent by this client, which currently means leaf eligibility under a v2 parent.


---

Evidence only (LEXICO-SPLIT-01). The prescriptive roadmap that once ended this file
lives in [000_plan.md](000_plan.md) and [010_phase1_catalog_capability_contract.md](010_phase1_catalog_capability_contract.md).
