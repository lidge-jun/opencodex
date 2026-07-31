# 100.30 — Tool Mode and Multi-Agent Version

## Questions

- What is `tool_mode`?
- What is `multi_agent_version`?
- If opencodex omits or inherits them, what fallback does Codex use?
- Do these fields affect the subagent picker and tool exposure?

## Codex RS Behavior: `tool_mode`

`tool_mode` is an optional per-model runtime selector in Codex's model catalog metadata.

Known values:

```text
direct
code_mode
code_mode_only
```

Relevant upstream definitions:

```text
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:297
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:414
```

Semantics:

- `direct`: expose normal tool specs directly to the model.
- `code_mode`: add code-mode wrapper tools while allowing direct tool exposure where applicable.
- `code_mode_only`: hide nested tools from direct model exposure and force code-mode entrypoints.

Codex computes the effective mode from `model_info.tool_mode` first. If omitted, it falls back to
feature flags: `CodeModeOnly`, then `CodeMode`, then `Direct`.

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/core/src/tools/mod.rs:63
/tmp/opencodex-codex-src/codex-rs/core/src/tools/mod.rs:64
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:272
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:452
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:475
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:987
```

Unknown `tool_mode` strings deserialize as omitted, not as hard errors.

Fallback metadata for unknown model slugs sets:

```text
tool_mode: None
```

## Codex RS Behavior: `multi_agent_version`

`multi_agent_version` is an optional per-model selector for Codex collaboration/subagent tooling.

Known values:

```text
disabled
v1
v2
```

Relevant upstream definitions:

```text
/tmp/opencodex-codex-src/codex-rs/protocol/src/openai_models.rs:420
/tmp/opencodex-codex-src/codex-rs/protocol/src/protocol.rs:2891
```

Semantics:

- `disabled`: no collaboration/subagent tools.
- `v1`: legacy namespaced multi-agent surface.
- `v2`: newer direct or namespaced agent-control surface with richer agent lifecycle tools.

For a real turn, Codex resolves and stores one multi-agent version for the session. Once stored,
later model changes do not necessarily change multi-agent behavior inside the same session.

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/core/src/session/mod.rs:2916
/tmp/opencodex-codex-src/codex-rs/core/src/session/mod.rs:2921
/tmp/opencodex-codex-src/codex-rs/core/src/session/mod.rs:2925
/tmp/opencodex-codex-src/codex-rs/core/src/session/mod.rs:2927
/tmp/opencodex-codex-src/codex-rs/core/src/session/turn_context.rs:727
```

If omitted, Codex falls back to feature flags:

- `multi_agent_v2` enabled -> `V2`
- stable `multi_agent` / `Collab` enabled -> `V1`
- otherwise -> `Disabled`

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/core/src/config/mod.rs:1363
/tmp/opencodex-codex-src/codex-rs/features/src/lib.rs:1011
/tmp/opencodex-codex-src/codex-rs/features/src/lib.rs:1017
```

## Tool-Spec Impact

`multi_agent_version` changes which collaboration tools are exposed:

- V2 can expose `spawn_agent`, `send_message`, `followup_task`, `wait_agent`,
  `interrupt_agent`, and `list_agents`.
- V1 exposes legacy handlers such as `spawn_agent`, `send_input`, `resume_agent`,
  `wait_agent`, and `close_agent`.
- `disabled` suppresses collaboration tools.

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:343
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:347
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:766
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:769
/tmp/opencodex-codex-src/codex-rs/core/src/tools/spec_plan.rs:819
/tmp/opencodex-codex-src/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:48
/tmp/opencodex-codex-src/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:80
```

## Spawn-Agent Model List

`tool_mode` does not decide which models appear in `spawn_agent` descriptions. Spawn-agent model
override descriptions come from available `ModelPreset`s sorted by priority, filtered for picker
visibility, and capped at five entries.

Relevant upstream paths:

```text
/tmp/opencodex-codex-src/codex-rs/models-manager/src/manager.rs:80
/tmp/opencodex-codex-src/codex-rs/models-manager/src/manager.rs:117
/tmp/opencodex-codex-src/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:19
/tmp/opencodex-codex-src/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:747
/tmp/opencodex-codex-src/codex-rs/core/src/tools/handlers/multi_agents_spec.rs:751
```

## Current opencodex Behavior

opencodex derives routed entries by deep-copying a native template:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:82
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:108
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:118
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:128
```

Live `/v1/models?client_version=...` and on-disk catalog sync both use the same derived entries:

```text
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:473
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:480
/Users/jun/Developer/new/700_projects/opencodex/src/server.ts:484
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:273
/Users/jun/Developer/new/700_projects/opencodex/src/codex-catalog.ts:292
```

The routed entries currently do not normalize:

- `tool_mode`
- `multi_agent_version`

## Gap

If the chosen native template has `tool_mode = "code_mode"` or `"code_mode_only"`, every routed
model inherits that tool-exposure behavior.

If the template has `multi_agent_version = "v2"` or `"disabled"`, every routed model inherits that
collaboration behavior. A model marked `v2` can expose V2 tools even when the feature flag is off.
A model marked `disabled` can suppress collaboration even when the feature is on.

Because Codex stores resolved multi-agent version on the first real turn, metadata fixes may require
a new Codex session to take effect.

## Phase 100 Recommendation

Normalize both fields deliberately in `deriveEntry()`:

1. For native OpenAI passthrough entries, preserve native `tool_mode` and `multi_agent_version`.
2. For non-OpenAI routed entries, either delete both fields and let Codex feature defaults apply, or
   set a project-wide explicit policy.
3. Prefer deletion first unless opencodex has a strong reason to force code-mode or V2 for routed
   models. Deletion does not disable the user's configured/default multi-agent behavior; it lets
   Codex resolve the feature default (including V2 when the user has enabled V2) instead of letting
   the cloned native template force a selector.
4. Add catalog snapshot tests proving routed entries do not inherit these selectors accidentally.
