# 001 — Probe evidence (2026-09-23)

All observations were made on the maintainer machine with Claude.app 1.18286.0, Desktop's
bundled Claude Code 2.1.197, standalone Claude Code 2.1.278 and the source-dogfooded proxy
(`/Users/jun/Developer/new/700_projects/opencodex` at 206fbc6b3f) on port 10100, intercept on 10200.
Screenshots and extracted bundles stay outside the repository under `/tmp/ocx-claude-probe/`.

## Where the Desktop Code tab picker comes from

- Desktop main process (`app.asar` `.vite/build/index.js`) exposes an IPC
  `LocalSessions.setAvailableCodeModels(modelIds)` that the renderer calls; the renderer is the
  claude.ai web app.
- The claude.ai bundle (`shared-16-*.js`) calls `setAvailableCodeModels(ae.map(e=>e.id))` with
  `{selectableModels:ae}=oy("code")`, and `oy` builds the catalog from `modelSelectorConfig`
  (`shared-0-*.js` `function Zj`). Unknown ids only ever become an "Unsupported model" entry for
  the current selection; `Yj` adds `[1m]` rows only for models already in the catalog.
- The renderer reads Claude Code settings through `resolveLocalSettings` (`shared-4-*.js` `mN`):
  `model`, `availableModels`, `fastMode`, effort and permission keys. `availableModels` only
  disables rows; `model` does not add one. Claude Code 2.1.278 supports a `modelPicker` settings
  key with labels and `behavesAs`, but Desktop does not read it.
- Live check: with `~/.claude/settings.json` `model` set to `claude-ocx-xai--grok-4.7` and a new
  Code session, the picker still listed only Opus 5.5, Sonnet 5, Fable 5.1, Haiku 4.5 and More
  models (Opus 5, Fable 5, Opus 4.8, Opus 4.7, Opus 4.6, Sonnet 4.6). The setting was restored.

Conclusion: in first-party mode no local file can add an opencodex row to the Desktop picker.
The only lever is the request path: the Code tab sends the picker id and the intercept can route it.

## The intercept path works

- `ocx claude desktop apply --first-party` pivoted the Desktop library to the standard profile
  and wrote only `HTTPS_PROXY`/`NODE_EXTRA_CA_CERTS` into `~/.claude/settings.json`.
- Standalone CLI: `claude -p ... --model claude-ocx-xai--grok-4.7` returned `PROBE-OK`;
  usage.jsonl recorded `xai xai/grok-4.7 200 loopback messages`.
- Desktop Code tab, Haiku 4.5: reply `DESKTOP-1P-PROBE-HAIKU`; usage.jsonl recorded two
  `anthropic-native claude-haiku-4-5-20251001 200 loopback` rows, so Desktop's Claude Code does go
  through the intercept.
- Desktop Code tab, Sonnet 4.6 after a temporary global `claudeCode.modelMap`
  `{"claude-sonnet-4-6":"xai/grok-4.7"}`: usage.jsonl recorded `xai xai/grok-4.7 grok-4.7 200 loopback`.
  The global map was the only way to do this, and it also reroutes `ocx claude` sessions.

## Picker ids observed on the wire

`claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001` (dated), plus the
catalog rows Opus 4.8/4.7/4.6 and Fable 5/5.1. Dated ids reach an undated key through the existing
date-suffix strip in `resolveInboundModel` (src/claude/inbound-model-options.ts).

## Side observation, not in scope

Before the probe the saved config said `desktopMode: first-party` while the Desktop library still
applied the opencodex gateway profile, and status reported `first_party_residue`. The running
proxy was 26 commits behind `dev`; this unit does not chase that state.
