---
title: Codex Prompt Layers
description: Read what Codex actually sends, switch off the parts you do not need, and append your own instructions as layers.
---

Codex assembles its prompt from layers: its own base instructions, your project
docs, permission and environment context, the skills you have installed, and
more. **Codex Set → Prompt** shows that stack, tells you what each layer costs,
and lets you switch off the parts you do not want.

## What the list shows

Each row carries its position in the assembly order, the config key that governs
it when there is one, and the size of what it actually sent.

The positions have gaps. That is deliberate: the numbers are the real assembly
indices, and two of them are listed further down under **Transition notices**.
Renumbering each group from one would show an order Codex does not use.

### Five kinds of layer

| Kind | What you can do |
|---|---|
| Switchable here | A real switch. Writes a key in `config.toml`. |
| Configured under `[features]` | Real, but changed from the feature settings rather than this page. |
| Always on | No off-switch anywhere in Codex. |
| Fires on change | Announces a transition, so it appears only when something changes. |
| Extension layers | Cannot be listed. Codex does not expose them. |

A layer with no off-switch shows no switch at all rather than a disabled one. A
greyed control would suggest the capability exists and is temporarily
unavailable, which is not the case.

## Reading a layer

Click a layer name to see the text it sends. The dialog reads it from
`codex debug prompt-input`, so it is the real thing rather than a description.

Sometimes there is nothing to show, and the dialog says which reason applies:

- **The file exists but is empty.** Your `~/.codex/AGENTS.md` is zero bytes, so
  the layer has nothing to send. The dialog names the path.
- **It sent nothing on the turn we read.** Layers are only re-sent when they
  change, so an unchanged layer is absent from a single sample.
- **The base prompt comes from your model catalog.** Codex sends it outside the
  readable list, so the dialog reads it from the selected model's catalog row —
  or from the file named by `model_instructions_file` when you have set one. A
  row that publishes only an unexpanded template is reported as not shown,
  because that text is not what Codex sends.
- **The prompt could not be read.** The probe failed on this machine.

The reading is taken from your global Codex home (`~/.codex`), not from whatever
directory the dashboard happens to be running in.

## Custom layers

**+ Add layer** appends your own instructions. Custom layers compose into
`developer_instructions`, which is additive — Codex keeps its own instructions
and yours are added to them.

:::note
This is deliberately not `model_instructions_file`. That key REPLACES the base
prompt rather than adding to it, so wiring **+** to it would delete Codex's own
instructions the first time you saved a layer. If replacing the base prompt is
what you want, that is what [Base prompt variants](#base-prompt-variants) is for
— a separate, named decision rather than a side effect of adding a layer.
:::

Custom layers are numbered among themselves because they are joined into one
section in that order — they do not interleave with the built-in layers.

Reorder with the arrows on the row, or with `Alt` + `Up` / `Alt` + `Down` from
anywhere in the row. Order is composition order.

### Presets

**+ Add layer** offers five starting points: concise output, plan before editing,
explain reasoning, test first, and Korean replies. Each opens the ordinary editor
pre-filled and fully editable — a preset is a starting point, and what you save is
an ordinary custom layer.

The presets are our own text, written to distil an approach rather than to copy
anyone's prompt. Each names its source.

### Moving between layers while editing

The editor has prev/next controls and a position indicator. Unsaved edits are kept
while you move, so you can compare two layers mid-edit and come back without
losing what you typed.
Closing with edits on another layer asks before discarding them. Saving one layer also asks before
discarding edits parked on other layers; the confirmation's **Save** button saves only the displayed layer.

### Compatibility warnings

The editor warns when a layer says something that will not work as written —
claiming a different identity, naming a tool the registry defines, using template
placeholders nothing expands, or stating environment facts Codex generates later.

These are warnings and never block a save. If you mean to override Codex, you can;
the warning only makes it a decision rather than an accident.

## Commit attribution

The **Commit attribution** row tells the model to add a `Co-authored-by: Codex`
trailer to commits it writes, and a `Generated with Codex.` line to pull requests it
opens.

There is no switch for it here, and none under `[features]` either: Codex resolves it
from your account's attribution policy. Turning it off at the account level does not
remove the layer — Codex sends the **opposite** instruction instead, telling the model
not to add the trailer. Either way something is sent, which is why the row is listed
as set by your account rather than as always on.

## Base prompt variants

The base prompt is the one layer you cannot switch off, because a model with no
base prompt is not a working agent. You can **substitute** it, though, and the
switch on the **Base instructions** row is what does that.

Open the row to see the picker. Move between options by swiping sideways, with the
left and right arrow keys, or with the arrow buttons — the buttons are also what a
screen reader announces, so the page stays operable without a touchpad.

| Option | What it is | Editable |
|---|---|---|
| Codex's own base prompt | `model_instructions_file` is absent from your config | never |
| Your variant | a prompt you write, stored in `~/.codex/opencodex-prompt-base/` | yes |
| A second variant | the same, up to two | yes |

The first option has nothing to edit and no **Save** button, and the dialog says why
rather than showing greyed-out controls. The default is not a copy of Codex's prompt
that we store — it is the **absence** of the key. So there is no text to change and
none to delete, and choosing it simply removes `model_instructions_file` from your
config again.

:::caution
A variant **replaces** Codex's base instructions rather than adding to them. A
three-line variant gives you a model with three lines of instructions: no tool
discipline, no verification habits, none of what Codex normally brings. If you want
to *add* guidance, use a [custom layer](#custom-layers) instead — those are additive.
:::

### If something else already replaced your base prompt

If `model_instructions_file` points at a file opencodex did not write, the picker
refuses to act and says where the key points. It will not silently retarget a key
you or another tool set. Clear it yourself first, then choose here.

This is the same principle as importing `developer_instructions`: the panel reports
what it finds, and you decide.

Switching applies to newly started sessions, like every other change on this page.

## Instructions written outside opencodex

If `developer_instructions` already exists and opencodex did not write it, the
panel will not overwrite it. Instead it offers to import the text as a layer:
you see the existing value first, and nothing is written until you confirm.

## When something is out of sync

If the saved layers and the value in `config.toml` disagree, the panel says so and
offers **Repair** rather than fixing it silently. Two of the repair paths rewrite
text you wrote, so they stay deliberate. Where a layer file has gone missing, the
repair writes a backup before it touches anything.

## When changes take effect

Changes apply to newly started sessions. A session already running keeps the
prompt settings it started with.

## What this page reads, and what it does not

opencodex reads one configuration file — your `config.toml`. Codex resolves its
settings from several layers, so a value here is what YOUR file says, not
necessarily what Codex finally computes.

## The keys this page writes

These live in your Codex `config.toml`, not in opencodex's own configuration.

| Key | Default | Layer |
|---|---|---|
| `include_permissions_instructions` | `true` | Permissions |
| `include_collaboration_mode_instructions` | `true` | Collaboration mode |
| `include_environment_context` | `true` | Environment context |
| `include_apps_instructions` | `true` | Apps |
| `skills.include_instructions` | `true` | Skills |
| `developer_instructions` | unset | Your custom layers, joined in order |
| `model_instructions_file` | unset | Base prompt, when a variant is selected |

Writes are line edits: your comments and formatting survive, and a key opencodex
does not recognise is left alone rather than removed.

An absent key reads as its default rather than as `false`. The panel shows the
value your file actually holds, and says when a key is not set.
