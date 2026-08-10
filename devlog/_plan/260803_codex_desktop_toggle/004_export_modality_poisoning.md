# One rejected modality value poisons a whole client config

Research doc. A live bug, its blast radius across the other five exporters, and
where the fix belongs.

## The observed failure

Gajae Code refuses to load its entire config:

```
Failed to load config file models, Schema error:
/providers/opencodex/models/30/input/2: Invalid option: expected one of "text"|"image"
```

Model index 30 (0-based) is `zenmux/meta-muse-spark-1.1`, whose `input` we wrote
as `[text, image, audio]`. Index 2 of that array is `audio`.

The user-visible consequence is out of all proportion to the cause: gjc falls
back to its built-in Anthropic list, so every routed model disappears at once.
One value in one model takes down the whole file.

## Why we emit a value the client rejects

Our internal modality vocabulary is `text | image | audio`
(`src/server/management/model-routes.ts:13`, `src/cli/models.ts`), and the two
affected exporters copy it through verbatim:

- `buildGajaeClientConfig` — `src/clients/config-export.ts:765`
- `buildPiClientConfig` — `src/clients/config-export.ts:659`

Both clients accept only `text | image`. Gajae's installed schema pins it at
`@gajae-code/coding-agent/src/config/models-config-schema.ts:119`, and Pi's
upstream source does the same in `packages/coding-agent/src/core/model-config.ts:156-169`,
with whole-file rejection at `:267-274` — Pi returns an EMPTY model config on a
schema failure rather than dropping the offending entry.

**So Pi carries the identical bug.** It has not been observed only because this
machine's `~/.pi/agent/models.json` is currently empty. This is a latent live
defect, not a hypothetical.

A stale comment at `config-export.ts:649` still calls Pi's schema UNVERIFIED.
It is verified now, and it says `text|image`.

## This exact bug already happened once

`tests/catalog-input-modality-enum.test.ts:5-12` records the precedent in its own
words: zenmux advertised `video`, we wrote it through verbatim, and the Codex app
reported `unknown variant 'video'` **while showing zero apps** — because the
catalog is referenced from config, so the rejection cascaded into plugins, apps
and MCP servers.

`ensureStrictCatalogFields` (`src/codex/catalog/parsing.ts`) was the fix for the
Codex path: filter to the accepted enum, and fall back to `["text"]` rather than
an empty list, because a modality-less entry would leave the client unable to
tell the model takes prompts at all.

The lesson did not generalize to the client exporters. Same class, same shape,
different destination.

## The other four exporters

| Client | Emits modalities? | Residual risk |
|---|---|---|
| OpenCode | no | ids/names/context unvalidated against client semantics |
| Hermes | no | selector strings unvalidated |
| OpenClaw | no | ids/names/context unvalidated |
| Kimi | no | alias/model characters unchecked; non-finite contexts already omitted |

No modality exposure outside Pi and Gajae. The residual rows are marked INFERRED
by the audit — only Gajae's and Pi's schemas were directly verified — so they are
recorded as follow-up, not folded into this unit.

Two things that are NOT at risk, checked rather than assumed: syntax injection
via quotes/newlines is prevented by the serializers
(`src/integrations/serialize.ts:52,167,224`), and numeric handling already omits
zero/negative/NaN/Infinity and floors fractions (`config-export.ts:420,431`).
There is no upper sanity cap on context, which is a real but separate gap.

## Where the fix goes

At the **client-dialect boundary**, as one helper beside `authoritativeContextWindow`:

```ts
inputModalitiesForClient(client, inputModalities)
```

Accepted vocabulary `text|image` for both current callers; preserve order,
dedupe, and fall back to `["text"]` when filtering empties the list — matching
the Codex precedent exactly.

Called from the two emission sites only: `config-export.ts:659` (Pi) and `:765`
(Gajae).

Two rejected alternatives, each for a concrete reason:

- **Not in `ExportModel` construction.** The management and CLI boundaries carry
  catalog modalities verbatim on purpose (`src/server/management/model-rows.ts:91`,
  `src/cli/export-command.ts:82`). Stripping `audio` globally would destroy valid
  internal metadata before the destination is known.
- **Not inside `normalizeExportModels`.** Its documented and tested contract is
  first-wins dedupe plus deterministic sorting (`config-export.ts:508`,
  `tests/client-config-export.test.ts:261`). Overloading it hides the behavior
  from the place a reader would look for it.

## What the existing tests do and do not pin

Pinned: Pi's `["text"]` default, `[text,image]` preservation, numeric
omission/clamping, and a byte-exact golden
(`tests/client-config-export.test.ts:184,191,201,343`). Gajae's tests pin allowed
**field names**, not value enums
(`tests/client-config-export-new-clients.test.ts:251`).

Nothing exercises `audio` or any rejected modality, which is precisely why 91
green tests coexist with a config the client refuses to load. The regression test
must assert the emitted VALUE vocabulary for both clients, and the fix must not
disturb the byte-exact golden beyond the intended modality change.

## Verification bar

A unit test alone does not close this. The criterion is the actually emitted
file: re-apply the gajae integration and confirm gjc loads it with no schema
error. The bug was found in a real file, and it gets closed in one.
