# Codex App visualization references for models that cannot see private-use characters

## Objective

A routed model must be able to show a Codex App inline visualization. Today only models whose
provider preserves Basic Multilingual Plane private-use characters can, because the reference the
bundled Visualize skill teaches is `U+E200 visualize U+E202 {json} U+E201`.

Observed on 2026-09-27 against the local proxy (2.68.0, `a1285fc648`): asked to list the code
points of `[A U+E200 B U+E202 C U+E201]`, `gpt-6-luna` and `xai/grok-4.7` return all six, while
`anthropic/claude-opus-5-5` and `cursor/claude-opus-5-5` return only `A B C`. OpenCodex's own
Anthropic request body still contains the three characters (checked by building the request in
process), so they are removed after the proxy. Claude therefore reads the skill template as
`visualize{"path":...}`, writes that plain text back, and the app shows it verbatim.

## Constraints

- Native OpenAI/ChatGPT passthrough stays byte-identical: it serializes `_rawBody`.
- Stored request history stays raw (`adapter-delivery.ts` hands `_rawBody` to `state.ts`).
- The citation filter semantics from #3150, #3843 and #6040 are unchanged.
- No new dependency, no Lab import on the request path, no file-size ratchet increase.

## Work-phase map

| Work-phase | Doc | Outcome |
|---|---|---|
| wp1 | this directory, 000-001 | Evidence and roadmap (docs only) |
| wp2 | [010](010_wp2_visualization_directive_normalization.md) | Parser-side normalization, tests, PR, CI, squash merge |
| wp3 | [020](020_wp3_rebuild_and_live_verify.md) | Local app rebuild from merged dev with a fresh sidecar, live Claude check |

wp2 depends on the app evidence in [001](001_app_and_external_evidence.md); wp3 depends on wp2 being on `dev`.

## Architect consultation (formal P)

Architect: gpt-6-astra subagent `01a0e0ce-58fd-7fd3-8186-12e3752ec8f6` (Fermat), read-only.
Proposal D1-D14 received 2026-09-27. Main dispositions:

| Id | Proposal | Disposition |
|---|---|---|
| D1 | New pure module `src/responses/visualization-directives.ts`, copy-on-change | Accepted |
| D2 | Hook at the parser's final `context` | Accepted; covers the replay expansion and the encrypted-agent reparse |
| D3 | Normalize conversation text only (system prompt, message strings, text parts), including fenced code | Accepted |
| D4 | Match only complete literal `U+E200visualize U+E202 … U+E201` spans | Accepted |
| D5 | Payload rules mirror the app's `f2` exactly | Accepted |
| D6 | Single template exception for `<absolute-path>/<title>.html` | Accepted |
| D7 | `codex-live-vis` for `type:"live"`, `mode="wide"` only for inline `mode:"wide"` | Accepted |
| D8 | Raw-body passthrough excluded | Accepted. Whether every raw-body route preserves the characters is not established; the observed failures are both on context-built adapters |
| D9 | No persistence change; history stays raw | Accepted |
| D10 | Deterministic output; Cursor checkpoint digest will differ once for affected prefixes | Accepted; the digest mismatch invalidates the old checkpoint, which is the safe direction. No dedicated Cursor test, recorded as residual |
| D11 | No output repair of bare `visualize{json}` | Accepted; revisit only if live checks show a model still emitting the bare form |
| D12 | Alternatives | Rejected: adapter hooks duplicate the rule per adapter and miss provider switches mid-thread; a request-prepare hook misses the encrypted-agent reparse and direct parser callers; changing the upstream skill text does not reach installed plugins or existing history |
| D13 | Sibling test file registered in both layout manifests | Accepted; replay-after-restart and Cursor checkpoint tests narrowed to raw-body and idempotence assertions |
| D14 | Live UI confirmation of the ASCII directive still pending | Tracked in wp3 |

Limitations carried forward: raw-body passthrough routes are not normalized; replies already stored as bare `visualize{...}` are not repaired; a future template variant needs its own fixture; the live render of the ASCII form is confirmed only in wp3.

Reflection: recorded in [010](010_wp2_visualization_directive_normalization.md#architect-reflection).
