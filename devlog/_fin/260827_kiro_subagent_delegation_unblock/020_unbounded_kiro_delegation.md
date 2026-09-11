# wp2 — allow unbounded parallel Kiro delegation

Unit: `260827_kiro_subagent_delegation_unblock` · work-phase `wp2`

Depends on wp1. Lifting a ceiling the parent cannot see changes nothing.

## Owner intent

> kiro 서브에이전트 무한 병렬 파견을 허용할께

Read as two separate limits, because they are enforced in different places:

- **depth** — can a spawned child spawn again? Today: no.
- **width** — how many children may run at once? Today: an upstream default.

## Measured starting state

`ocx v2 status` / `ocx agent` on this host:

```text
multi_agent_v2:      OFF
multi_agent_mode:    v1  — ALL models forced to v1 surface
agents.enabled:      (unset — upstream default true)
agents.max_depth:    (unset — upstream default 1)
max_threads:         (unset — codex default)
```

`agents.max_depth` is V1-only upstream (`src/codex/features.ts:334`), and this
host runs the V1 surface, so it is live rather than ignored.

Depth 1 is why the first probe was inconclusive: a spawned child (`Nash`)
correctly had no spawn tool. That was the ceiling behaving as configured, not
the bug. The bug only became visible at the **top level**, where depth is not
the constraint and the tool was still missing.

## Levers that already exist

No new subsystem is needed. Every control is implemented:

| lever | reader | writer | CLI |
|---|---|---|---|
| `[agents] max_depth` | `getAgentsMaxDepth()` `src/codex/features.ts:345` | `setAgentsMaxDepth()` :819 | `ocx v2 ...` |
| `[agents] enabled` | `src/codex/features.ts` | same | `ocx agent` |
| concurrent threads | `maxConcurrentThreadsPerSession` | `src/server/management/agent-settings-routes.ts:385` | `ocx v2` |

Validation already bounds `agentsMaxDepth` to signed i32
(`agent-settings-routes.ts:293-296`), so "unbounded" in practice means a large
finite depth, not a null sentinel.

## Decision needed before implementing

**Is unbounded depth global, or Kiro-scoped?**

`[agents] max_depth` is a Codex-global TOML key. It has no provider dimension.
Raising it lifts the ceiling for *every* provider on this host, not only Kiro.

Two options:

1. **Global raise** — set `max_depth` high once. One line, immediate, and
   honest about what it does. Every provider gets it.
2. **Kiro-scoped** — would require a new opencodex-owned gate, since upstream
   has no per-provider depth. Materially more work and a new config surface.

Recommend option 1 unless the owner wants other providers held at depth 1. This
is the one open question in this unit.

## Runaway risk, stated plainly

Unbounded depth × unbounded width is exponential. A depth-5 tree where each
parent spawns 4 children is 1024 leaf agents, each holding Kiro quota.

Two properties make that survivable, and both should be verified rather than
assumed:

- **Width still bounds the tree.** `maxConcurrentThreadsPerSession` caps
  simultaneity even when depth is unlimited. Confirm it applies per-session and
  not per-parent before relying on it.
- **Kiro quota fails closed.** The adapter already has retry/cooldown handling
  (`src/adapters/kiro-retry.ts`); exhaustion should surface as a refused spawn,
  not a wedged tree.

Deliberate non-recommendation: do not add a depth-based safety valve in this
unit. The owner asked for the ceiling removed; adding a different ceiling in its
place would not honor that. Width is the correct place for a bound.

## Implementation

```bash
# after the depth question is answered
ocx v2 status          # capture before-state
# raise [agents] max_depth via the existing writer, then:
ocx v2 status          # prove the new value is persisted
```

Config writes go through `setAgentsMaxDepth()` rather than hand-editing
`~/.codex/config.toml`, so the existing validation and write serialization
apply.

## Exit criterion

`ocx v2 status` reports the raised depth, and a spawned Kiro child can itself
spawn a grandchild. wp3 proves it end to end.
