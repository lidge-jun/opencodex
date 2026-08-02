# 002 — Where user text can legally enter, and what presets cost

Researcher: Herschel (read-only). Upstream HEAD `2b5bdcf67`.

## 1. AGENTS.md discovery

Discovery walks from cwd up to the nearest ancestor holding a
`project_root_markers` entry — `.git` by default — and never above it
(`agents_md.rs:8`). Directories are then read root-to-cwd inclusive
(`agents_md.rs:188`). Per directory the first match wins:
`AGENTS.override.md`, then `AGENTS.md`, then configured fallbacks
(`agents_md.rs:211`, `:234`).

Host-provided instructions come first; the transition into project content is
the literal separator `\n\n--- project-doc ---\n\n`; adjacent project files join
with `\n\n` (`agents_md.rs:319`).

**Budget: 32 KiB aggregate per environment**, consumed root-first. The last
file that fits is byte-truncated and decoded lossily; everything after it is
dropped (`config/mod.rs:204`, `agents_md.rs:95`, `:106`). A budget of zero
disables project docs entirely.

That truncation direction matters for the UI: the *deepest* AGENTS.md — usually
the one the user thinks is most specific — is the first to vanish.

## 2. Rendered shape

```text
# AGENTS.md instructions for <cwd>

<INSTRUCTIONS>
<host instructions>

--- project-doc ---

<root AGENTS content>

<deeper AGENTS content>
</INSTRUCTIONS>
```

Produced by `UserInstructions::body()` (`user_instructions.rs:9-28`). It is a
**user-role** fragment, not part of the system `instructions` field. Base
instructions travel in the Responses `instructions` field, or as a leading
developer message under Responses Lite (`client.rs:861`).

## 3. `model_instructions_file` — why the `+` button must not use it

- Precedence: runtime `base_instructions` > `model_instructions_file` > root
  `instructions` (`config/mod.rs:3832`).
- Once resolved it beats conversation-history instructions and the catalog's
  baked instructions (`session/mod.rs:634`, `:652`).
- It **replaces the base prompt entirely. It does not append.**
- A missing, unreadable, non-UTF-8, or empty file is a hard config-load error,
  not a fallback (`config/mod.rs:4254`).
- Validation stops at "readable and non-empty after trim". No schema, no
  tool-contract check, no size cap (`config/mod.rs:4267`).

So a naive "add a custom layer" that wrote this key would delete Codex's own
instructions, and a bad path would leave Codex refusing to start. Both failure
modes are silent from the GUI's point of view.

`000` §"The finding that reshapes the design" records the consequence:
custom layers compose into `developer_instructions`; this key is surfaced
read-only, as a warning row when something else has set it.

## 4. Bundled prompt assets

At this HEAD none of the six root markdown prompts under `codex-rs/core/` has a
production reference; only `prompt_with_apply_patch_instructions.md` is
referenced, and only by a test (`session/tests.rs:1435`).

| Asset | Bytes | Active selector |
|---|---:|---|
| `gpt_5_1_prompt.md` | 24,204 | NONE at HEAD |
| `gpt_5_2_prompt.md` | 21,652 | NONE at HEAD |
| `gpt-5.1-codex-max_prompt.md` | 7,589 | NONE at HEAD |
| `gpt-5.2-codex_prompt.md` | 7,589 | NONE at HEAD |
| `gpt_5_codex_prompt.md` | 6,647 | NONE at HEAD |
| `prompt_with_apply_patch_instructions.md` | 23,988 | test only |

Live base instructions come from the model catalog instead
(`openai_models.rs:478`). In the bundled snapshot the default is `gpt-5.6-sol`
with instructions embedded in `models-manager/models.json:4`. A remote catalog
refresh can change that, so "the current base prompt" is catalog-dependent and
the UI must read it rather than name it.

## 5. Preset source material — what it actually is

The ask names Claude Code and Grok Build presets. Neither source is a prompt
that can be shipped as-is.

**`002_prompt-context/02_cc_prompt.md`** is not a Claude Code system prompt. It
is a 15,163-byte Korean *analysis document* about one (`:10`, `:44`, `:100`).
Pasting it would inject commentary and source snippets, plus "You are Claude
Code", Claude tool names, `CLAUDE.md`, `<system-reminder>`, and Anthropic
billing semantics.

**`02_gr_prompt.md`** is likewise a dossier — 24,013 bytes mixing current OSS
findings with a binary-analysis appendix (`:8`, `:109`, `:122`). It carries
unresolved `${{ tools.by_kind.* }}` placeholders that only Grok's MiniJinja
renderer expands (`:44`).

**Grok Build's real assets** are `prompt.md` (4,638 B), `apply_patch_prompt.md`
(21,360 B), `subagent_prompt.md` (4,741 B) under
`180_grok-build/crates/codegen/xai-grok-agent/templates/`. The default opens by
identifying the model as "Grok released by xAI" (`prompt.md:1`) and uses
render-time tool placeholders (`context.rs:263`).

Conclusion for WP6: presets are **authored by us**, distilling behavioral intent
from these sources into harness-neutral text. They are never verbatim copies.
Each preset ships with a provenance line naming what it was derived from.

## 6. The compatibility hazards WP6's linter checks

Each is grounded in something read above:

| Hazard | Why it breaks | Evidence |
|---|---|---|
| Identity redefinition ("You are Claude Code" / "You are Grok") | contradicts the selected base identity | `02_cc_prompt.md:44`, Grok `prompt.md:1` |
| Foreign tool names (`Read`/`Edit`/`Bash`) | Codex's registry defines tools, not prose | `model_info.rs:151` |
| Unresolved template placeholders (`${{ ... }}`) | Codex runs no MiniJinja over instruction text | `context.rs:252` |
| Redefining `apply_patch` or prescribing another edit protocol | same registry argument | `model_info.rs:151` |
| Foreign approval vocabulary (`always-approve`, Claude permission modes) | Codex injects its own permission block afterwards | `world_state.rs:114` |
| Claims about cwd, date, network, installed tools | authoritative environment context is generated later | `world_state.rs:149` |

**The 32 KiB budget does not belong on this list.** An earlier draft cited
`agents_md.rs:109` as a reason to warn on long custom layers. That budget
governs **project-document loading** — the AGENTS.md chain — and has no bearing
on root `developer_instructions`, which is read as a plain config string with no
cap (`config_toml.rs:216`). An independent audit flagged the citation as simply
wrong, and it is.

`060`'s size advisory survives, but as declared opencodex policy justified by
request cost, not as an upstream constraint we discovered.

The linter warns; it does not block. A user who wants to override Codex's
identity is allowed to — but not by accident.

## Needs verification

- Historical slug mapping for the six unreferenced markdown assets is UNKNOWN
  without git archaeology; not needed for this unit.
- Whether a live remote catalog currently supersedes `gpt-5.6-sol` is UNKNOWN
  from a static checkout. WP4 reads it at runtime instead of hardcoding.
- Model compliance under deliberately contradictory layers is unproven; static
  ordering is proven, behavior under conflict would need live capture.
