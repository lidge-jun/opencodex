# 022 — What the layers actually do, measured

`001` classified the layer taxonomy by reading `world_state.rs`. Two of its
conclusions are wrong, and the UI shipped them: `base-instructions` and
`agents-md` were rendered as "no off-switch anywhere in Codex" when both can be
switched off from `config.toml`.

This document records what a live Codex actually sends, captured at the wire.

## Method

A minimal HTTP server on `127.0.0.1:10999` stands in for the model endpoint and
records each `/v1/responses` body. `codex exec` is pointed at it through a
throwaway provider, once per configuration, from a repository that has an
`AGENTS.md`. Measuring the request rather than `codex debug prompt-input`
matters: that command returns `prompt.input` and discards `base_instructions`
(`core/src/prompt_debug.rs:96-104`), so base changes are invisible to it.

## Result

| Configuration | Prompt bytes | Delta |
|---|---|---|
| default | 39,239 | — |
| `model_instructions_file` = one-line file | 21,518 | −17,721 |
| `project_doc_max_bytes = 0` | 23,939 | −15,300 |
| all switches below, together | **2,465** | **−36,774 (94%)** |

## Corrections to `001`

### base-instructions is replaceable, not immovable

`config/mod.rs:3616-3624` resolves `base_instructions` from
`model_instructions_file`, and `client.rs:854` omits the developer message
entirely when the resolved text is empty. So the base prompt is not a fixed
cost: a user can replace all ~17 KB of it.

It cannot be reduced to literally nothing. `try_read_non_empty_file`
(`config/mod.rs:4037-4066`) rejects an empty or whitespace-only file with
`InvalidData`, so the floor is one non-blank line. That is the honest answer to
"turn base off": not a switch, a **replacement**, with a minimum of one line.

### agents-md is gated by a config key

`agents_md.rs:89-93` returns `Ok(None)` when `project_doc_max_bytes` is 0,
before any path resolution. `001` classified this layer as
`runtime-conditional` because `world_state.rs:145` calls `add_section`
unconditionally — but the section renders whatever was loaded, and nothing is
loaded at 0. The gate is real and it is a user-settable key.

### realtime is not conditional on being in a realtime session

`world_state.rs:132` adds `RealtimeState` unconditionally; `realtime_active` is
an argument to it, not a guard around it. The row should not claim the layer
appears "only in a realtime session".

## Measured per-key effect

From a plain directory (16,077 byte baseline), each key alone:

| Key | Delta | Sections removed |
|---|---|---|
| `skills.include_instructions = false` | −10,393 | `skills_instructions` |
| `include_apps_instructions = false` | −646 | `apps_instructions` |
| `include_environment_context = false` | −347 | `environment_context` and its children |
| `include_permissions_instructions = false` | −362 | none — swapped for `CompactPermissionsState` |
| `include_collaboration_mode_instructions = false` | 0 | none in this context |

Two of those deserve care in the UI.

`include_permissions_instructions = false` does not remove the permissions
layer. `world_state.rs:160-180` swaps the full section for
`CompactPermissionsState` — the model still learns the sandbox rules, in fewer
words. Calling that switch "off" overstates it.

`include_collaboration_mode_instructions` measured zero here because the
default collaboration mode contributes nothing in this context. The key is
real (`world_state.rs:183`); its effect is context-dependent.

## What this means for the panel

The five-switch UI understates what a user can control. The corrected picture:

| Layer | Control | Kind |
|---|---|---|
| base-instructions | `model_instructions_file` | replace, one-line floor |
| agents-md | `project_doc_max_bytes = 0` | real off switch |
| permissions | `include_permissions_instructions` | compact, not off |
| collaboration, environment, apps, skills | their `include_*` keys | real off switches |
| personality, token budget, deferred executor, deferred tools, multi-agent | `[features]` | off, elsewhere |
| model-switch, plugins | none | genuinely runtime-conditional |

Only `model-switch` and `plugins` survive as layers with no user-reachable
control, and both are conditional on runtime facts rather than being always on.

## Round 2: three of my own corrections were also wrong

An audit against `origin/main` `f5420174d` rejected half of the above. The
common mistake, in `001` and in my correction alike: **`add_section` registers
state for diffing, it does not emit text.** A section can be registered every
turn and render nothing.

### agents-md — overstated

`project_doc_max_bytes = 0` stops the filesystem walk, but
`load_project_instructions` seeds `LoadedAgentsMd::from_user_instructions`
BEFORE the byte budget is consulted (`agents_md.rs:53-68`). Host-provided user
instructions therefore survive at zero. It is a **project-document** gate, not
a whole-layer off switch.

The −15,300 measurement stands for what it measured: a repository whose
AGENTS.md is the whole of that layer. It is not a general claim.

### permissions — my correction was worse than the original

I wrote that `false` swaps in a compact restatement. It does not.
`CompactPermissionsState::ID` is `approved_command_prefixes`, and its
`render_diff` returns `None` outright when the previous state is `Absent` or
`Unknown` (`compact_permissions.rs:24-53`). It emits only newly approved command
prefixes on a later diff.

So `false` DOES remove the permissions guidance. "Full versus compact" is
wrong; the honest label is that detailed permissions guidance is omitted, while
later approval updates can still appear.

### realtime — also wrong, in the other direction

Registration is unconditional but rendering is not: inactive or unknown state
renders nothing, start text appears when active, end text on an
active-to-inactive transition (`realtime.rs:43-53`, `:77-90`). Dropping the
condition text would imply the layer is always present, which is false. The
accurate wording is that it is emitted when realtime starts or ends.

### base — a precedence caveat

`model_instructions_file` outranks configured `instructions`, but an explicit
runtime `base_instructions` argument outranks the file
(`config/mod.rs:3842-3857`). The UI must not promise the file is the final
authority.

## What the measurement can and cannot prove

Under Responses Lite the top-level `instructions` field is ALWAYS empty and
base instructions are prepended into `input` as a developer fragment
(`client.rs:890-915`). My capture recorded `instructionsChars: 0` for every
run — that is the transport, not evidence of an absent base. The byte deltas
are sound because they measure the whole body; the empty-`instructions`
observation is an artifact and is withdrawn.

Two more limits worth stating rather than hiding:

- The five `include_*` deltas sum to roughly 11.7 KB. The headline −94% figure
  combines those with base replacement and project-doc suppression, so calling
  it "all switches" was wrong. It is one measured configuration, listed in full.
- Every number is a FIRST-request measurement from a fresh run, against one
  model, catalog, repository, and transport. World-state sections are
  diff-rendered, so these are not per-turn recurring costs.

## Corrected control map

| Layer | Real control | Honest label |
|---|---|---|
| base-instructions | `model_instructions_file` | Replace base instructions — advanced, destructive, one-line floor, runtime override still wins |
| agents-md | `project_doc_max_bytes` | Load project instructions — a byte budget, and host instructions survive at 0 |
| permissions | `include_permissions_instructions` | Detailed permissions guidance — off omits the block; approval updates may still appear |
| realtime | none | Emitted when realtime starts or ends |
| collaboration, environment, apps, skills | their `include_*` keys | real switches, though emission also depends on availability |
| environments-instructions | `include_environment_context` AND `features.deferred_executor` | jointly gated, not the feature alone |
| apps | include flag AND apps enabled AND an accessible connector AND model support | on does not guarantee emission |
| plugins | runtime availability AND model support | genuinely conditional |

## Safety requirements for base replacement

`model_instructions_file` replaces the prompt the model was tuned against, and
upstream itself discourages the field (`config_toml.rs:242-246`). The flow must:

- live behind an advanced, explicitly destructive confirmation naming what can
  degrade — behavior, tool use, safety posture, performance;
- write only an opencodex-owned marked file, never an arbitrary path the user
  already owns;
- update the file and `config.toml` under the existing revision/journal/backup
  machinery, with rollback;
- refuse empty or whitespace-only content before touching disk;
- offer Restore Codex default, which REMOVES the key rather than emptying the
  file;
- stay entirely separate from `developer_instructions`, which is how custom
  layers append without touching base.

