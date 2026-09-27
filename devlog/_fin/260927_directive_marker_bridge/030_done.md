# 030 — done: Codex App visualization references for routed models

## Outcome

Any routed model can now show a Codex App inline visualization. #6040 (`a1285fc648`) stopped the
citation filter from deleting non-citation directives; #6045 (`dc784d3e6f`) rewrites the private-use
`visualize` reference into the app's own `::codex-inline-vis{…}` directive in the text routed models
read, so a model whose provider drops private-use characters still reads and writes a form the app renders.

## Evidence

- App bundle 26.924.22138: `f2`, `Err` and `i3e` (see 001) render the ASCII directive directly.
- Local app rebuilt from `dc784d3e6f` with a forced standalone sidecar; the installed `ocx` reports
  2.68.0 and contains `codex-inline-vis`; `codesign --verify --deep --strict` passes.
- Live, through the installed proxy: `anthropic/claude-opus-5-5` and `cursor/claude-opus-5-5` answered a
  private-use reference with `::codex-inline-vis{path="/tmp/demo-chart.html"}`; `gpt-6-luna` returned the
  private-use form unchanged; `xai/grok-4.7` received and quoted the private-use form.
- Render: a Claude-routed final answer carrying `::codex-inline-vis{…}` rendered as an interactive widget in
  Codex App; the widget reported `route: Claude, version: #6045, outcome: renders` back to the thread.
- Reviews: architect Fermat, auditor Lovelace, reviewer Archimedes (132,715 `f2` parity cases), and two
  release regression lanes over #6040 and #6045 found no regression.

## What did not go to plan

- `desktop/scripts/prepare-sidecar.ts` reuses `dist/standalone/*/ocx` when it exists, so the first rebuilt
  app shipped a stale 2.61.0 proxy. The standalone build has to be forced before `prepare-sidecar`.
- A commentary message is recorded as a reasoning summary on this route, which the app does not render
  as markdown directives; the render check needed a final answer.
- #6045 merged by admin at the owner's instruction before its PR CI finished; the post-merge lane=all run
  on `dc784d3e6f` is the CI evidence for the merged tree.

## Follow-ups

- Make `prepare-sidecar` rebuild when the source is newer than the cached standalone binary.
- Replies already stored in the bare `visualize{…}` form are not repaired.
