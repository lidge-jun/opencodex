# 050 — WP5: custom layers

The `+` button, the editable dialog, delete, reorder, **and the compatibility
linter**. This is ask items 5, 6, 7 and the half of item 4 that applies to
user-authored rows.

The linter moved here from WP6. An audit found WP5 rendering findings from an
API WP6 owned — a forward dependency. The linter is a pure function with no
dependency on presets, so it belongs in the phase that consumes it; WP6 becomes
presets alone.

## Files

```
gui/src/components/codex-set/CustomLayerRow.tsx      (new)
gui/src/components/codex-set/CustomLayerDialog.tsx   (new)
gui/src/components/codex-set/custom-layer-state.ts   (new — reducer)
gui/src/components/codex-set/prompt-lint.ts          (new — moved from WP6)
```

## Where the text goes

`developer_instructions`, composed by WP1. **Not** `model_instructions_file` —
`002` §3 proves that key replaces the entire base prompt, so wiring `+` to it
would delete Codex's own instructions on first save. `000` records this as the
deliberate deviation from the literal ask.

`010` §Storage settles the mechanics: `opencodex-prompt.json` is the single
source of truth for every layer including disabled bodies, and
`developer_instructions` is a generated projection of the enabled subset, always
in the canonical two-line form. One authority, no reconciliation.

When the key exists without our marker, the custom group offers **Adopt**
(`010` §Ownership): the existing text is shown verbatim, copied if the user
wants, and imported as a custom layer only on explicit confirmation. `+` stays
hidden until ownership is settled, but the user is never told to go delete their
own instructions by hand.

## Row

```
  My house rules              [ ●─ ] on    [edit] [×]
```

Switch, edit, delete — all three, unlike built-ins which never get delete
(ask item 6). Drag handle for reorder; order is composition order.

## Dialog — editable

Ask item 7. Title input, body textarea, live compatibility warnings, Save,
Cancel. Same dialog scaffolding as WP4's read-only one; the difference is the
editor and the Save action, not a separate component family.

Escape cancels, discards, returns focus. When the body is dirty, Escape asks
first — a textarea the user has typed into is not the same as a read-only
dialog they glanced at.

## The `+` flow

WP5 ships a single action: `+ Add layer` opens an empty editor. **No preset
submenu exists yet** — an empty menu is worse than no menu, and the audit was
right that shipping one is a forward dependency on WP6. WP6 adds the submenu
together with the presets that fill it.

## Client-side validation

Mirrors `020`'s server rules so the user sees the problem while typing rather
than on Save:

| Rule | Message |
|---|---|
| empty title | "제목을 입력하세요" |
| title > 80 chars | count shown, Save disabled |
| body > 64 KiB | size shown, Save disabled |
| composed total > 128 KiB | which layers overflow |
| > 32 layers | `+` disabled with the reason |
| control character in body | the offending position, Save disabled |

Tabs and CRLF are **normalized, not rejected** — four spaces and LF — with a
quiet note the first time it happens. `010` explains why the character set is
restricted: a measured `Bun.TOML.parse` defect makes local verification
untrustworthy, so the encoding is kept to three unambiguous escapes instead.

The server still enforces every one of these (`020`). Client validation is
courtesy; the API is the boundary.

## The linter

`prompt-lint.ts` — pure, no I/O:

```ts
export function lintPromptLayer(body: string): LintFinding[];
```

Rules and their evidence live in `060`; the implementation ships here. Findings
render inline with the offending span highlighted, **as warnings, never
blocks**. A user who deliberately wants to override Codex's identity may; they
just should not do it by accident.

## Reorder and revisions

Order is composition order. Reordering PUTs the full list — `020`'s endpoint is
full-replacement precisely so ordering needs no separate verb.

Every PUT carries the snapshot revision (`010` §Concurrency). A `409
stale_revision` means another tab or a manual edit moved the file: the editor
re-reads and tells the user their view was stale rather than silently
overwriting someone else's work.

Keyboard reorder must work: up/down buttons alongside the drag handle. A
drag-only affordance is not reachable.

## Delete

Confirms first, because a body can be long and there is no undo. Delete removes
the row and PUTs the remainder; WP1 drops its entry from the JSON and
regenerates the projection without it.

## Tests — `gui/tests/codex-set-custom-layers.test.tsx`

1. `+ Blank` opens an empty editor
2. Save PUTs the full list with the new layer appended
3. edit changes title and body, id is unchanged
4. toggling a custom layer PUTs with `enabled` flipped
5. delete confirms, then PUTs without the row
6. reorder PUTs the new order
7. keyboard reorder works without pointer events
8. dirty Escape asks before discarding
9. clean Escape closes immediately, focus returns
10. each validation rule disables Save with its message
11. a rejected PUT restores the previous list
12. built-in rows still have no delete control
13. stale revision → re-read, no blind retry
14. unowned `developer_instructions` hides `+` and offers Adopt
15. Adopt shows the raw text and requires confirmation before writing
16. Adopt is refused, with path and line, when the value is not a single-line
    basic string
17. a body containing `"` and `\` saves and round-trips unharmed
18. tabs normalize to four spaces; CRLF normalizes to LF
19. a control character is rejected with its position
20. `drift` states render with a Repair action rather than silently self-healing
21. linter: one case per rule, positive and negative
22. clean behavioral text produces zero findings
23. lint spans point at the right substring
24. no rule throws on empty, whitespace-only, or 64 KiB input

Case 12 re-asserts ask item 6 from the custom-layer side: adding delete to one
row family must not leak it into the other.
