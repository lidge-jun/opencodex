# 005 — Prompt section: the design

Depends on `001` (what is toggleable), `002` (what may be written), `003`
(when it applies), `004` (what to build on).

## The page

```
Codex Set                                    #codex-set
┌──────────────┬──────────┐
│  Multi-auth  │  Prompt  │   ← exclusive tabpanels, Logs-shaped
└──────────────┴──────────┘
```

`#codex-set` → Multi-auth (today's account pool, moved whole).
`#codex-set/prompt` → Prompt. Prompt lazy-mounts on first visit and stays
mounted, exactly as Debug does (`Logs.tsx:551`).

Why exclusive panels rather than a scrolling page: Multi-auth polls
`/api/codex-auth/*` every 30s and owns modal login flows. Those should not run
underneath a prompt editor, and a user scrolling from account cards into prompt
rows is a worse read than a deliberate switch.

## The Prompt panel

```
Prompt                                     [ + Add layer ]
새 세션부터 적용됩니다. 실행 중인 세션은 현재 설정을 유지합니다.

BUILT-IN
  🔒  Model instructions           always on    [view]
  🔒  AGENTS.md                    always on    [view]
      Permissions              [ ●─ ] on        [view]
      Collaboration mode       [ ●─ ] on        [view]
      Environment context      [ ●─ ] on        [view]
      Apps                     [ ●─ ] on        [view]
      Skills                   [ ●─ ] on        [view]
  🔒  Plugins                      availability [view]
  ⚙   Personality                  feature      [view]
  ⚙   Multi-agent mode             feature      [view]

CUSTOM
      My house rules           [ ●─ ] on        [edit] [×]
      Claude Code style        [ ─○ ] off       [edit] [×]
```

Three row kinds, three affordance sets:

| Kind | Switch | Dialog | Delete |
|---|---|---|---|
| 🔒 locked built-in | **absent** | read-only | never |
| toggleable built-in | present | read-only | never |
| ⚙ feature-gated | **absent**, links to its real setting | read-only | never |
| custom | present | **editable** | yes |

The lock icon is not a disabled switch. `001` §4 proves these layers have no
off-switch anywhere in Codex; rendering a greyed-out toggle would imply the
capability exists and is merely unavailable. A switch that cannot exist should
not be drawn. This is ask item 9, and WP4 asserts it in a test.

Feature-gated rows (`001` §3) also get no switch, but for a different reason:
flipping `multi_agent_v2` from a prompt page would silently reconfigure subagent
concurrency. The row states the governing key and links to where it is owned.

## Ordering

Rows follow the assembly order in `001` §1, so the list reads as the prompt is
built. Skills carries a quiet note that its exact position among extensions is
registration-dependent (`001` ordering caveat) — the UI must not overpromise.

Custom layers form a second group below. Within it, order is the composition
order written into `developer_instructions`, and it is reorderable.

## Dialogs

Built-in rows open **read-only**: the layer's purpose, its class, the exact
config key where one exists, its default, and this file's value. Copy button, no
editor. Ask item 8.

Two things the dialog does **not** show, because nothing produces them:

- **The rendered prompt text.** Codex exposes no API for it, and reconstructing
  it would mean reimplementing `world_state.rs` against a moving target
  (`001` §6). `040` says the same.
- **The effective value.** opencodex reads one of the eight config layers in
  `003` §1, so it reports `defaultedUserValue` — this file's value — and claims
  nothing about what the running Codex resolved.

Custom rows open an **editor**: title, body textarea, live compatibility
warnings (`002` §6), Save, Cancel. Escape cancels and returns focus, matching
`client-config-panel.test.tsx:204-222`.

## The `+` flow

`+ Add layer` offers:

- **Blank** — empty editor.
- **From preset** — a picker of the WP6 presets, each with a provenance line.

Either way the result is a custom row: editable, toggleable, deletable.

## What custom rows actually write

Every layer — enabled or not — lives in `$CODEX_HOME/opencodex-prompt.json`,
which opencodex owns outright. `config.toml` receives a generated projection of
the **enabled** subset, in row order, as exactly two lines:

```toml
# Auto-injected by opencodex
developer_instructions = "escaped composition of enabled layers"
```

A disabled layer keeps its body in the JSON and is simply absent from the
projection, so switching it off removes it from the prompt without losing it.

`010` §Canonical physical form fixes the shape: always a single-line basic
string, always directly under the marker. Replacement is "find marker, replace
next line" — not a search for a value span.

If `developer_instructions` exists without our marker, opencodex refuses to
write it and offers an explicit **Adopt** flow that shows the existing text and
imports it as a custom layer on confirmation (`010` §Ownership). Nothing is
overwritten or deleted silently.

### Accepted characters

Bodies accept printable Unicode, spaces, and newlines. Tabs are normalized to
four spaces; CRLF is normalized to LF. Control characters are rejected with a
precise message.

This is not fussiness. `010` records a measured defect in `Bun.TOML.parse` on
Bun 1.3.14 — it transposes `\t` and `\f`, and rejects `\u0007` — so an encoding
we could verify locally is not necessarily the encoding Codex's Rust parser
reads. Restricting the character set makes the escaping total and unambiguous
with three rules, which no parser defect can undermine.

`model_instructions_file` is never written here. `002` §3 explains why. When
something else has set it, the Prompt panel shows a warning row: the base prompt
has been replaced, by a file opencodex does not manage.

## Honest status, not optimistic status

Three places where the UI must resist claiming more than it knows:

1. **Timing.** "새 세션부터 적용됩니다" (`003` §3). Never "즉시 적용", never
   "재시작 필요" — neither is proven.
2. **Scope of what we read.** opencodex reads one of the eight config layers in
   `003` §1, so the panel says "이 파일의 설정" and never claims the running
   Codex agrees. Managed-override detection is deferred, not approximated.
3. **Completeness.** Third-party extensions can add layers we cannot enumerate
   (`001` needs-verification). The list is labelled as the layers opencodex
   knows about, not as every layer that exists.

## Empty and error states

- **No `~/.codex/config.toml`:** rows render at documented defaults and switches
  are **live**. The first toggle creates the file (`010` §First write). An
  earlier draft disabled the switches while promising creation "on first
  change", which an audit correctly called a contradiction — a disabled switch
  makes that first change impossible.
- **Unreadable or malformed config:** the panel refuses to write and says so.
  `003` §4 — Codex cannot parse malformed TOML either, so writing would compound
  the failure rather than recover from it.
- **`developer_instructions` exists without our marker:** built-in toggles keep
  working; the custom group offers **Adopt**, which previews the original line
  and the exact decoded body, offers a copy, and imports it only on
  confirmation (`010` §Ownership).
- **Our line exists but is malformed:** `drift: "owned-malformed"`, handled the
  same way — preview, copy, confirmed re-adopt or replace. Reformatting a line
  we generated must never lock a user out.
- **Store lost with a live projection:** `drift: "store-missing"`. Writes are
  refused until the user salvages the projected text as one layer, with the
  losses listed and a backup written first.
- **No custom layers:** the CUSTOM group shows a one-line invitation, not an
  empty box.

## What the UI does not claim

`010` renames `effective` to `defaultedUserValue` because opencodex reads one
file out of the eight config layers in `003` §1. The panel therefore says
"이 파일의 설정" and never asserts the running Codex agrees.

The managed-override notice from `003` §6 is **deferred with the field**.
Detecting an MDM override needs a resolved-config read path we do not have;
shipping the notice without it would move the overclaim rather than remove it.
