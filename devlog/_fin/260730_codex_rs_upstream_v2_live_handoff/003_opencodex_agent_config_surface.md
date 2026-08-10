# 003 — OpenCodex agent / subagent config surface as it stands

Research only. No diffs. Read at branch `dev`, HEAD `959e9ff11`.

## Files that own this surface

| File | Lines | Role |
|---|---|---|
| `src/codex/features.ts` | 450 | Reads/writes `features.multi_agent_v2` and `[agents]` TOML; owns the v1↔v2 transition |
| `src/codex/subagent-defaults.ts` | 550 | Marker-owned TOML transform for `[agents].default_subagent_*` |
| `src/codex/subagent-model-fallback.ts` | 457 | Fallback model chain; unrelated to upstream default keys |
| `src/codex/inject.ts` | 799 | Maps OpenCodex JSON config onto native TOML |
| `src/server/management/agent-settings-routes.ts` | 885 | 18 management routes; `/api/v2` is the only v2 mutation surface |
| `src/types.ts` | 1191 | `OcxConfig` field declarations |
| `src/cli/v2.ts` | 164 | `ocx v2` status/on/off/mode/threads |
| `src/cli/help.ts` | 319 | Help text for `ocx v2` and `ocx agent` |

## What OpenCodex already does

`features.ts` is a genuine TOML reader/writer, not a passthrough. It handles the
dedicated `[features.multi_agent_v2]` table, the inline
`multi_agent_v2 = { ... }` form, and the legacy `[agents].max_threads` key, and it
performs the v1↔v2 migration atomically with rollback on failure. Dotted forms such as
`agents.max_threads` and `features.multi_agent_v2.*` are explicitly refused for
automatic migration.

`subagent-defaults.ts` writes `[agents].default_subagent_model` and
`default_subagent_reasoning_effort` under an ownership marker, so a user's own
unmarked values are preserved and reported as conflicts rather than overwritten. The
values are derived from OpenCodex's `injectionModel` / `injectionEffort` when
`syncCodexSubagentDefaults` is on; they are not independently configurable.

`agent-settings-routes.ts` exposes `GET`/`PUT /api/v2` returning and accepting
`enabled`, `maxConcurrentThreadsPerSession`, and `multiAgentMode`, plus
`agentsMaxThreadsConflict` on read. No PUT route enforces a closed key set: unknown
JSON members are ignored rather than rejected.

## Upstream key coverage

| Upstream key | OpenCodex status | Where it would live |
|---|---|---|
| `agents.enabled` | **Missing** — no occurrence anywhere in the surface | `features.ts` beside the `[agents]` readers; `OcxConfig`; `/api/v2` |
| `agents.max_concurrent_threads_per_session` | **Supported, but semantics diverge** — stored under `features.multi_agent_v2`, and the `[agents]` variant is treated as an equal alternative rather than an `N+1` input | `features.ts` `getLogicalMaxThreads` and the transition |
| `agents.default_subagent_model` | **Partial** — written only as a mirror of `injectionModel` under an opt-in flag | `subagent-defaults.ts`, `inject.ts` |
| `agents.default_subagent_reasoning_effort` | **Partial** — same, mirrors `injectionEffort` | same |
| `agents.max_depth` | **Missing** | `subagent-defaults.ts` key set, if V1 semantics are wanted |
| `features.multi_agent_v2.subagent_developer_instructions` | **Missing** — `multiAgentGuidanceEnabled` / `injectionPrompt` is proxy-authored guidance, a different thing | `features.ts` plus `/api/v2` |

## The concurrency divergence, precisely

`features.ts:317`:

```
getLogicalMaxThreads = v2Enabled
  ? getMaxConcurrentThreads() ?? getAgentsMaxThreads()
  : getAgentsMaxThreads() ?? getMaxConcurrentThreads()
```

Both branches treat the two keys as interchangeable numbers. Upstream
(`config/mod.rs:2674`) does not: the `[agents]` value feeds V2 as `N + 1`.

Consequence, concretely. A user with `[agents].max_threads = 3` under V1 gets a V2
limit of 4 from upstream once V2 turns on. OpenCodex's `ocx v2 on` migrates that 3
into `features.multi_agent_v2.max_concurrent_threads_per_session = 3`, so upstream
reads a V2 limit of 3. The user silently loses one concurrent slot across the
migration, and gains one going back.

This is a real behavioral defect rather than a cosmetic parity gap, which is why it is
work-phase 1 rather than part of the general parity phase.

## Adjacent OpenCodex-only concepts (do not conflate)

- `multiAgentMode: "v1" | "default" | "v2"` — an OpenCodex JSON field, not an upstream
  TOML key.
- `subagentModels`, `subagentModelFallback`, `subagentModelFallbackPollMs` — OpenCodex
  fallback routing, no upstream equivalent.
- `effortCap`, `subagentEffortCap` — OpenCodex effort clamping.
- `injectionPrompt`, `multiAgentGuidanceEnabled` — proxy-authored guidance text.

These are deliberately OpenCodex's own surface. Nothing in this unit proposes
replacing them with upstream keys; the parity work is additive.
