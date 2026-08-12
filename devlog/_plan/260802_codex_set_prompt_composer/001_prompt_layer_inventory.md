# 001 — The Codex prompt stack, layer by layer

Researcher: Noether (read-only). Upstream HEAD `2b5bdcf67`.
Every row below was read in `/Users/jun/developer/codex/121_openai-codex`.

## 1. Assembly order

Sections are registered by `add_section()` in `codex-rs/core/src/session/world_state.rs`.
Initial-context rendering preserves that order with two exceptions: model-switch
moves to the front and multi-agent mode to the back of the developer-message
sequence (`session/mod.rs:3528-3538`).

Classes are the five defined in §4. This table uses that vocabulary and no
other. An earlier draft used an ad-hoc ALWAYS-ON/TOGGLE/FEATURE split that
contradicted §4; two audit rounds flagged it, and the second was still correct
because the fix had not actually landed on this block.

| # | Layer | Tag | Role | Gate | Default | Class |
|---:|---|---|---|---|---|---|
| 1 | Model **switch** | `<model_switch>` | dev | model changed + instructions non-empty | — | `runtime-conditional` |
| 2 | Personality | `<personality_spec>` | dev | `[features] personality` | on | `feature-gated` |
| 3 | Context-window guidance | `<context_window_guidance>` | dev | `[features] token_budget` | off | `feature-gated` |
| 4 | Realtime | `<realtime_conversation>` | dev | realtime activation state | — | `runtime-conditional` |
| 5 | AGENTS.md | `<INSTRUCTIONS>` | user | discovered content exists | — | `runtime-conditional` |
| 6 | Permissions | `<permissions instructions>` | dev | `include_permissions_instructions` | on | `config-toggle` |
| 7 | Collaboration mode | `<collaboration_mode>` | dev | `include_collaboration_mode_instructions` | on | `config-toggle` |
| 8 | Environment context | `<environment_context>` | user | `include_environment_context` | on | `config-toggle` |
| 9 | Environments instructions | `<environments_instructions>` | dev | `include_environment_context` AND `[features] deferred_executor` | off | `feature-gated` |
| 10 | Apps | `<apps_instructions>` | dev | `include_apps_instructions` + connector present | on | `config-toggle` |
| 11 | Plugins | `<plugins_instructions>` | dev | `plugins_available` at turn build — see §Plugins | — | `runtime-conditional` |
| 12 | Tools | `<tools>` | dev | `[features] deferred_tool_world_state` | off | `feature-gated` |
| 13 | Skills (extension) | `<skills_instructions>` | dev | `[skills] include_instructions` | on | `config-toggle` |
| 14 | Multi-agent mode | `<multi_agent_mode>` | dev | `[features.multi_agent_v2] enabled` | off | `feature-gated` |

**Base/model instructions are not in this table.** They are class `base` and
travel in the request's `instructions` field, not as a world-state section
(`client.rs:861-887`). Row 1 is the model-*switch* transition — a different
thing that an earlier draft conflated with it.

Line references, in registration order: `world_state.rs:61`, `:66`, `:88`,
`:99`, `:113`, `:114`, `:139`, `:149`, `:168`, `:175`, `:187`, `:190`, `:208`,
`:228`.

Ordering caveat: Skills is an *extension* contribution, so its position among
other extensions depends on registration order. Statically guaranteed is only
that all extension contributions land between Tools and Multi-agent mode
(`world_state.rs:187`, `:208`, `:228`). The UI must therefore not promise an
exact index for Skills.

## 2. The five direct off-switches

These are the only keys that turn a layer off without side effects. All five
default to on when unset.

| Key | TOML position | Resolves at |
|---|---|---|
| `include_permissions_instructions` | root | `config/mod.rs:3836` |
| `include_apps_instructions` | root | `config/mod.rs:3837` |
| `include_collaboration_mode_instructions` | root | `config/mod.rs:3838` |
| `include_environment_context` | root | `config/mod.rs:3845` |
| `[skills] include_instructions` | `[skills]` table | `config/mod.rs:3840` |

Declared as `Option<bool>` at `config_toml.rs:220-229` and `skills_config.rs:30`;
`unwrap_or(true)` at the resolve sites above.

## 3. Feature-gated layers

Reachable from config.toml, but through `[features]` rather than an `include_*`
key, and turning them off changes more than prompt text. The Prompt section
shows these as **status rows, not switches** — flipping `multi_agent_v2` from a
prompt page would silently reconfigure subagent concurrency.

`personality` (default on, `features/lib.rs:1373`), `token_budget` (off,
`:1337`), `deferred_executor` (off, `:883`),
`deferred_tool_world_state` (off, `:1151`), `multi_agent_v2` (off, `:1097`).

`[features] plugins` (on, `:1181`) is deliberately **not** in this list: it
influences plugin loading but does not gate the `<plugins_instructions>`
section, which follows a runtime OR. See §Plugins.

## 4. The canonical taxonomy — five classes, not two

An earlier draft of this section carried a single "cannot be turned off" list.
An independent audit found it self-contradictory: it listed Plugins as
feature-gated in §3 and simultaneously as non-disableable here, and it conflated
"has no `include_*` key" with "cannot be suppressed at all". Both errors would
have propagated straight into the API's response.

Every layer belongs to exactly **one** of these classes. This taxonomy is the
single source for `020`'s response and `040`'s row kinds; a contract test
asserts the partition is total and disjoint.

### Class A — `base` — the request's own instruction field

| id | Layer | Why it is class A |
|---|---|---|
| `base-instructions` | base/model instructions | base instructions travel in the Responses `instructions` field, or as a leading developer message under Responses Lite (`client.rs:861-887`). **No `include_base_instructions` key exists anywhere in the schema.** Content is replaceable via `model_instructions_file`; the field itself is not user-suppressible. |

Exactly one member. It is not a world-state section at all.

The audit judged an earlier wording — "the request always carries non-empty base
instructions" — overstated, since `client.rs:861-887` shows *how* they are sent
rather than proving they are never empty. Narrowed accordingly: what class A
asserts is the absence of an off-switch, which is exactly what the schema shows.

### Class B — `config-toggle` — a direct boolean in config.toml

`permissions`, `collaboration`, `environment`, `apps`, `skills`. The five keys
of §2. **These are the only rows that get a switch.**

### Class C — `feature-gated` — reachable, but through `[features]`

| id | Governing key | Default |
|---|---|---|
| `personality` | `[features] personality` | on |
| `context-window-guidance` | `[features] token_budget` | off |
| `environments-instructions` | `[features] deferred_executor` | off |
| `tools` | `[features] deferred_tool_world_state` | off |
| `multi-agent-mode` | `[features.multi_agent_v2] enabled` | off |

Class C rows get **no switch** — flipping `multi_agent_v2` from a prompt page
would silently reconfigure subagent concurrency — but they are honestly labelled
as configurable elsewhere, with a link to the setting that owns them.

**Plugins is not in this class**, though two earlier drafts put it here. See
§Plugins below.

### Class D — `runtime-conditional` — no config gate, presence follows state

| id | Emits when | Evidence |
|---|---|---|
| `model-switch` | the model changed and instructions are non-empty | `model.rs:44-58` |
| `agents-md` | discovered project docs produced content | `world_state.rs:113`, `agents_md.rs:89-110` |
| `realtime` | entering or leaving active realtime | `realtime.rs:43-66` |
| `plugins` | `plugins_available` is true at turn build | `mcp.rs:200-202`, `world_state.rs:187-189` |

### Plugins — why it took three tries

Draft 1 called this layer impossible to disable. Draft 2 moved it to
`feature-gated`. Both overstated the source, and an audit round proved it by
opening the code:

```rust
// core/src/mcp.rs:200-202
let plugins_available =
    selected_plugin_available || !loaded_plugins.capability_summaries().is_empty();
```

`Feature::Plugins` feeds `plugins_config_input()`, which governs ordinary plugin
loading — the right operand. But `selected_plugin_available` is an **independent
OR path** that can make the section emit regardless of the loaded set. The
feature flag *influences* emission; it does not gate it.

The citation earlier drafts leaned on, `session/mod.rs:3422-3430`, gates
*recommended plugin candidates* — adjacent machinery, not this section. The
section receives `step_context.mcp.plugins_available()`
(`world_state.rs:187-189`).

Defensible: there is no `include_plugins_instructions` key, and emission follows
a runtime availability computation. That is `runtime-conditional` — the UI shows
a condition and no switch.

**UNKNOWN:** whether `[features] plugins = false` alone suppresses the section on
every path, given the `selected_plugin_available` operand. Settling it needs a
trace of that variable's producers. The UI renders identically either way, so it
is recorded rather than resolved.

No boolean anywhere suppresses these. They can still be *empty* — a zero
`project_doc_max_bytes` yields no AGENTS.md content — but emptiness is not a
toggle, and the UI must not present it as one.

### Class E — `extension-unknown`

Core iterates registered extension contributors unconditionally
(`world_state.rs:208`), but each extension decides its own availability. So the
honest claim is "no *core* include switch", not "cannot be turned off" — the
audit flagged the stronger wording as overstated and it is.

Skills is the one extension with a known config gate and therefore sits in class
B. Every other extension layer is class E: enumerable only at runtime, if at
all.

### What this means on the wire

`020` serializes **one** array — `inventory`, which is `LAYER_INVENTORY` from
WP1, each entry carrying its `class`. There is no separate `locked` or
`features` array; an earlier draft invented both, and they would have drifted
from this taxonomy within a release.

A row gets a switch **iff** `class === "config-toggle"`. Classes A and D are the
rows where a switch cannot exist; class C is configurable elsewhere; class E is
reported as `extensionLayersEnumerable: false` rather than as a list, because we
cannot enumerate it.

Ask item 9 — "절대 끌 수 없는 프롬프트는 절대 끌 수 없게" — is satisfied by
classes A and D. That is the set the tests in `020` case 5 and `040` case 2
defend, both driven from `inventory` rather than a hand-maintained list.

## 5. Content-override keys

| Key | Position | Semantics |
|---|---|---|
| `model_instructions_file` | root / profile, path | **REPLACES** base instructions (`config/mod.rs:3825-3832`) |
| `instructions` | root, string | legacy base override, below the file key |
| `developer_instructions` | root, string | **ADDS** a developer section before world state (`session/mod.rs:3413`) |
| `experimental_compact_prompt_file` | root / profile, path | replaces the compaction prompt only |
| `experimental_realtime_start_instructions` | root, string | replaces realtime start text |
| `[features.multi_agent_v2] subagent_developer_instructions` | table, string | replaces inherited subagent dev instructions |
| `[features.multi_agent_v2] multi_agent_mode_hint_text` | table, string | empty string suppresses layer 14 |
| `[features.token_budget] guidance_message` | table, string | supplies layer 3's body |
| `[auto_review] policy` | table, string | augments the guardian template |

Not valid config.toml keys at this HEAD: `base_instructions` (runtime override
only, `config/mod.rs:2566`), `experimental_instructions_file` (removed
2026-05-14 in `7dbe1c949`), root `guardian_policy_config` (managed
`requirements.toml` only).

`developer_instructions` is the key WP5 composes into. It is the only root
string that adds a layer instead of replacing one.

## 6. Version sensitivity

This surface is young and still moving. Landing dates from pickaxe history:

- `include_apps_instructions`, `include_permissions_instructions`,
  `include_environment_context` — `8d1964686` / `91ca49e53`, 2026-04-03.
- `include_collaboration_mode_instructions` — `8123bddb1`, 2026-05-12.
- `experimental_instructions_file` **removed** — `7dbe1c949`, 2026-05-14.
- `subagent_developer_instructions` — `49025589b`, 2026-07-28.
- Skills moved out of core to an extension — `0d109f097`, 2026-07-31.
- Environment-context behavior last changed — `9eeac78b3`, 2026-07-30.

Consequence for the implementation: treat every key as possibly-absent. WP1
reads what is there and reports the rest as unknown rather than asserting a
default the running Codex may not share.

## Needs verification

- Skills' index relative to other extensions is registration-order dependent;
  only the Tools→Multi-agent bracket is static.
- Third-party extensions may add further layers with their own gates. The UI
  must not claim its list is exhaustive.
