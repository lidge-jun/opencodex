# 000 — Research: Cursor's effort table lives in the bundle, not the gateway

Unit: `260902_cursor_bundle_effort_table`. Base: `origin/dev` at `ee24bab40`. Class C3
(public inbound contract on `GET /v1/models`, management route, GUI, provider adapter, docs).
Research only; no diffs in this document.

## Problem

The Integrations > Cursor card predicts which routed models get a **Reasoning** control in
Cursor Private Inference. For `anthropic/claude-fable-5-1`, `cursor/claude-fable-5-1`,
`cursor/kimi-k3`, `google-antigravity/claude-opus-4-6-thinking`,
`opencode-free/muse-spark-1.2-contributor-free` and `lidge/qwen3.8-27b-nvfp4` it shows "—",
and the live picker agrees: no effort control. The user expected the gateway's ladder
(`reasoning_effort: [...]`) to drive the control. It does not.

## Where the decision is made (Cursor 3.18.25, read from the shipped bundle)

Bundle: `<install>/Contents/Resources/app/extensions/cursor-agent-exec/dist/main.js`
(9,932,774 bytes, md5 `c2b57b0141b05e7e6e56cdcc206b95a5`; byte-identical between
`Cursor.app` and `Cursor Private Inference.app`, so the table is shared and only the
`localMode` code path differs).

1. `E(id)`: lower-case, keep the part after the last `/`, drop `@...`.
2. `I(id)`: first match in the family table `b` (verbatim in `001_bundle_protocol.md`):

   | family id | regex | ladder | param | default | outputCap |
   |---|---|---|---|---|---|
   | anthropic-opus-5 | `^claude-opus-5$` | low·medium·high·xhigh·max | output_config.effort | high | 128000 |
   | anthropic-opus-4-7-4-8 | `^claude-opus-4[-.](?:7\|8)$` | same | same | high | 128000 |
   | anthropic-opus-4-6 | `^claude-opus-4[-.]6$` | low·medium·high·max | same | high | 128000 |
   | anthropic-opus-4-5 | `^claude-opus-4[-.]5$` | low·medium·high·max | same | high | 64000 |
   | anthropic-sonnet-4-6 | `^claude-sonnet-4[-.]6$` | low·medium·high·max | same | high | 64000 |
   | anthropic-sonnet-5 | `^claude-sonnet-5$` | low·medium·high·xhigh·max | same | high | 128000 |
   | anthropic-sonnet-no-effort | `^claude-sonnet-4(?:[-.]5)?$` | none | — | — | 64000 |
   | anthropic-haiku-4-5 | `^claude-haiku-4[-.]5$` | none | — | — | 32768 |
   | grok-4.3 / 4.5 / 4.6 / grok-build-latest | `^grok-4[.-]3$` etc. | minimal·low·medium·high·xhigh | reasoning_effort | high | — |
   | grok-reasoning-no-effort | composer / 4.20 variants | none | — | — | — |
   | gpt-5.6 | `^gpt-5[.-]6-(?:luna\|sol\|terra)$` | low·medium·high·xhigh | reasoning_effort | medium | — |
   | gemini-no-effort | `^gemini-3\.[1-9].*flash-lite` | none | — | — | — |
   | gemini | `^gemini-` | minimal·low·medium·high | reasoning_effort | medium | — (needs `supports_reasoning`) |

   Plus `_(id)`: bare `^gpt-5(?:\.\d+)?$` → low·medium·high·xhigh, default medium.
3. `J(model, tier)` attaches the Reasoning parameter only when `I(id).effort` exists AND
   `extendedCapabilitiesDetected === true` (row passed the `fme` schema). For a model with
   no family it falls through to `_(id)`, and otherwise the control is absent.
4. `x(model)` / `C(models)`: a row with `capabilities.supports_reasoning === true` and no
   family is reported as drift. The workbench logs it as
   `"Local provider advertises reasoning support for a model with no hardcoded Bottlerocket
   effort family; reasoning controls will be unavailable until it is added to
   bottlerocket-families"` (`reportLocalProviderReasoningDrift`,
   `out/vs/workbench/workbench.desktop.main.js`).

Consequence: no `/v1/models` field can add a ladder for `fable`, `kimi`, `qwen` or
`muse`. `fable` appears in the bundle only in the Bedrock id list and the
`isFable5` heuristic; there is no effort family for it in 3.18.25.

Why regular Cursor showed Fable 5.1 with effort tiers: that picker is Cursor's cloud
catalog (`GetUsableModels`), which carries effort-suffixed ids. The local build reads
only the gateway list and this table.

## What opencodex does today

- `src/server/models-capabilities.ts` `CURSOR_EFFORT_FAMILIES`: a hand-copied static
  mirror of the table above (3.18.25). It cannot follow a Cursor update.
- `src/server/management/cursor-integration-routes.ts`: `reasoning: cursorEffortFamily(id)`
  per visible model; `null` renders as "—". No provenance, no hint.
- `src/integrations/cursor-detect.ts`: finds the install root and version from
  `product.json` (`nameLong`), injectable deps, read-only.
- `src/adapters/cursor/{catalog,effort-map,discovery}.ts` + `src/usage/expected-prices.ts`:
  Fable 5.1 is seeded three times (`claude-fable-5-1`, `claude-fable-5.1`,
  `claude-5.1-fable`) because Cursor has used both Anthropic-style and version-first
  spellings and the live roster decides which one survives.
- Guide `docs-site/src/content/docs/guides/cursor-private-inference.md`: documents the
  table and the "no control" rows; no install/identify section beyond "opencodex does not
  distribute it", no bundle path, no env-var setup.

## Levers, in dependency order

1. **Read the table from the installed bundle** (wp1). The proxy already knows the install
   root; the table is a stable minified literal (`{id:"…",matches:e=>/…/u.test(e),effort:X}`
   with `X` one of `w/T/k/S` or an inline object). Parse regex + ladder + default +
   outputCap; cache by path+mtime+size; fall back to the static mirror when there is no
   install, the literal is not found, or a regex fails to compile. Surface
   `{ source: "bundle" | "static", version }` in the status route.
2. **Send everything the bundle reads** (wp2): top-level `long_context_threshold_tokens`
   is read directly by the picker (`kye(e.long_context_threshold_tokens)`) alongside
   `pricing.overrides[].min_prompt_tokens`; `capabilities.max_output_tokens` is used when
   the family has no `outputCap`. Both are missing today.
3. **Effort-variant rows** (wp3, opt-in): the only way a table-less model gets an effort
   choice inside Cursor is separate rows. Off by default, byte-identical list when off.
4. **GUI provenance + hint** (wp4). 5. **Adapter normalizer** (wp5). 6. **Guide** (wp6).

## Distribution stance (unchanged)

Cursor does not document or link the Private Inference build; the update endpoint
`api2.cursor.sh/updates/api/update/darwin-arm64/cursor-local/3.18.25` answered 404 on
2026-09-02. The guide identifies an already-installed build and configures it; it never
hosts, links, or scripts a download (`rg 'downloads.cursor.com|cursor-local/'` stays 0).

## Verifiers (PLAN-VERIFIER-REAL-01, run 2026-09-02)

| Command | Exit | Reads the change target? |
|---|---|---|
| `bun run typecheck` | 0 (baseline) | yes — tsc over `src/**` |
| `bun test tests/cursor-integration-status.test.ts` | 0 (baseline) | yes — imports `cursorEffortFamily`, starts the server, reads the status route |
| `bun test tests/cursor-local-models-schema.test.ts` | 0 (baseline) | yes — starts the server and reads `/v1/models` |
| `bun test tests/cursor-catalog.test.ts` | 0 (baseline) | yes — adapter catalog/effort-map |
| `bun run privacy:scan` | 0 (baseline) | reads docs-site + devlog |
| `bun run lint:gui && bun run build:gui` | 0 (baseline) | wp4 only |

Repository-wide `bun run test` is forbidden for this unit (user instruction); exact-head
CI on each PR is the full gate.

