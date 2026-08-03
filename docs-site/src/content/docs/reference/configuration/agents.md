---
title: Agent Configuration
description: Multi-agent surfaces, delegation guidance, preferred models, fallback chains, native-default sync, and effort caps.
---

Agent settings control which Codex collaboration surface is advertised and how opencodex guides,
routes, and limits delegated work.

## Agent fields

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `multiAgentMode?` | `"v1" \| "default" \| "v2"` | `"default"` | `v1` stamps every catalog model as v1; `v2` stamps every model as v2. `default` restores upstream pins (Sol/Terra v2, Luna v1) and otherwise follows the native `multi_agent_v2` flag. Applies to new sessions. |
| `subagentModels?` | `string[]` | `gpt-5.5`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.4-mini` | Up to five native or routed ids featured first in the sub-agent picker. An explicit empty list is preserved. |
| `injectionModel?` | `string` | — | Preferred native or routed sub-agent model used in proxy-authored v2 delegation guidance. |
| `injectionEffort?` | `string` | — | Preferred effort (`low` through `ultra`), meaningful only with `injectionModel`. |
| `injectionPrompt?` | `string` | — | Replaces the built-in guidance body. Supports `{{model}}`, `{{effort}}`, `{{roster}}`, and `{{fallback}}`. Firing gates remain unchanged. |
| `multiAgentGuidanceEnabled?` | `boolean` | `true` | Controls only opencodex-authored v1/v2 developer guidance; it does not change native agent defaults, tools, routing, rosters, or effort caps. |
| `syncCodexSubagentDefaults?` | `boolean` | `false` | Opt into writing `injectionModel` and optional `injectionEffort` as Codex's native defaults during sync/restart. Requires `injectionModel`. |
| `subagentModelFallback?` | `string[]` | `[]` | Priority-ordered global fallback models for spawned child turns. |
| `subagentModelFallbackPollMs?` | `number` | `60000` | Availability-probe cache interval. Values below 1000 ms fall back to the default. |
| `effortCap?` | `string` | — | Hard ceiling for qualifying v2 main turns and marked spawned-child turns. Accepts `low` through `ultra`. |
| `subagentEffortCap?` | `string` | — | Additional ceiling for spawned-child turns only. When both caps apply, the lower wins. |

Manage the surface with the dashboard or `ocx v2 status|on|off|mode <v1|default|v2>|threads <n>`.
Mode changes apply to new sessions. `maxConcurrentThreadsPerSession` is a `PUT /api/v2` field, not a
`config.json` key; `ocx v2 threads <n>` writes `max_concurrent_threads_per_session` under
`[features.multi_agent_v2]` in Codex's `$CODEX_HOME/config.toml` after v2 is enabled.

The management API exposes `GET`/`PUT /api/v2`, `/api/injection-model`, `/api/effort-caps`,
`/api/subagent-models`, and `/api/subagent-model-fallback`. Injection-model updates are partial;
the custom prompt is the `prompt` field on that API.

The Codex Auth page can also toggle Codex's own `default_mode_request_user_input`
feature flag (`GET`/`PUT /api/codex-auth/features/default-mode-request-user-input`). Enabling it
adds `[features] default_mode_request_user_input = true` to Codex's
`$CODEX_HOME/config.toml` through the official `codex features enable|disable` CLI
(format-preserving edit, removed again when disabled), which lets Codex pause a
Default-mode session and ask you questions with the `request_user_input` tool. The
flag is under development upstream and only applies to new sessions; the toggle fails
loudly when the installed Codex build does not know the flag yet.

## Roster and guidance

The effective v2 roster is the configured, picker-visible, priority-sorted first five models that
are compatible with v2 and present in the injected catalog. V2 eligibility treats an explicit `"v2"`,
`null`, or absent upstream pin as eligible; a real `"v1"` pin is excluded. Excluded entries remain in
configuration so they can become eligible later.

Surface detection uses tool shape. A namespaced `spawn_agent` with `send_input`, `resume_agent`, or
`close_agent` is v1. A flat `spawn_agent` with `send_message`, `followup_task`, `interrupt_agent`, or
`list_agents` is v2.

V1 guidance is proactive text only at `max` or `ultra`. V2 receives a proxy-authored developer
message only when a preferred model, eligible roster, or fallback chain exists. Built-in v2 guidance
has a 700-character budget and drops the roster first if necessary. Guidance is deduplicated across
replay prefixes and inserted before a trailing `compaction_trigger`.

`injectionModel` and `injectionEffort` are advisory unless native-default sync is enabled. The built-in
v2 text asks Codex to pass supported model/effort overrides to `spawn_agent` with
`fork_turns: "none"`. A custom `injectionPrompt` substitutes missing values with an empty string.

## Native Codex default sync

When enabled, `syncCodexSubagentDefaults` writes marker-owned
`[agents] default_subagent_model` and `default_subagent_reasoning_effort` fields. Existing unmarked
user-owned target fields are treated as conflicts and remain authoritative; partial or ambiguous TOML
writes fail closed. Clearing `injectionModel` also clears the opt-in. These defaults affect newly
created Codex tasks and do not cause delegation by themselves.

## Fallback chain

Spawned-child fallback order is:

1. the requested primary model;
2. role-level `model_fallback` from `$CODEX_HOME/agents/*.toml`; then
3. global `subagentModelFallback` entries.

opencodex skips disabled, unroutable, unhealthy, cooling-down, or quota-threshold candidates. The
availability snapshot is cached for `subagentModelFallbackPollMs`. Encrypted child tasks can restrict
the chain to canonical native ChatGPT targets; if none can read the encrypted payload, the request
fails instead of routing unreadable ciphertext elsewhere.

```json
{
  "multiAgentMode": "v2",
  "subagentModels": ["gpt-5.5", "anthropic/claude-sonnet-5"],
  "injectionModel": "gpt-5.5",
  "injectionEffort": "high",
  "syncCodexSubagentDefaults": true,
  "subagentModelFallback": ["gpt-5.4-mini"],
  "subagentModelFallbackPollMs": 60000,
  "subagentEffortCap": "high"
}
```

## Effort caps

Caps apply only to the v2 collaboration feature: a main turn qualifies when its tools expose v2,
while a child qualifies when it carries exact codex-rs `x-openai-subagent: collab_spawn` or
`"subagent_kind": "thread_spawn"` markers in `x-codex-turn-metadata`, even
if leaf tools no longer expose collaboration. V1 main turns, `multiAgentMode: "v1"`, compaction,
review, and memory-consolidation turns bypass caps.

Caps only lower effort. They snap to the highest advertised rung at or below the cap. If a model has
no effort control or no supported rung fits, opencodex removes the effort and lets the provider default
apply. `max` and `ultra` are accepted, while the dashboard offers `low` through `xhigh`.

For a beginner-oriented explanation of v1, default, and v2 behavior, see
[Sub-agent surfaces](/guides/sub-agent-surface/).
