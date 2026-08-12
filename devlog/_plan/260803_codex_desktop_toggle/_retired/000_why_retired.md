# Why these two are retired

`020_codex_toggle.md` and `030_desktop_toggle.md` were written against the
durable operation-state design this unit was originally scoped around: a
versioned discriminated journal entry, prepare/commit with restart
reconciliation, and a field-scoped config writer.

That design was dropped after the research cycle recorded in `../001`-`../004`.
Two of its premises did not survive contact with the code:

- **`020` assumed Codex needed a captured pre-state.** `ocx restore` already
  restores native Codex without stopping the proxy (`src/cli/help.ts:18`), and
  `ocx restore back` is the enable direction. The toggle pair exists; what was
  missing is a switch that remembers being off.
- **`030` assumed Desktop removal was unsafe at any price.** It conflated
  restoring the exact prior selection (still impossible) with returning the user
  to standard Claude, which Anthropic documents as the behavior of a selected
  config with no valid `inferenceProvider`.

They are kept rather than deleted because their factual inventories are still
accurate and their reasoning explains why the replacement designs refuse certain
shortcuts. The live phases are `../040_codex_toggle.md` and
`../050_desktop_toggle.md`.
