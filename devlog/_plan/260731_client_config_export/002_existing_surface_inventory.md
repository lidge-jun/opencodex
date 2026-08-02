# 002 — What already exists, and what the real gap is

Research only. Written because the first pass of this unit's P phase proposed
building things that were already shipped. Recording the correction here so a
later cycle's P does not repeat the same miss.

## 1. Correction to the initial survey

The opening research turn concluded that OpenCode export had to be built from
scratch and listed three "design blockers" (slash-bearing model ids, credential
leakage, missing `limit.output`). All three were already solved in
`src/cli/opencode.ts`, a 701-line module that predates this unit.

| Claimed blocker | Actual state |
|-----------------|--------------|
| `provider/model` ids produce a double slash | `opencodeModelKey()` emits `provider/id` for routed and a bare slug for native; OpenCode splits on the FIRST slash, so the nested id survives |
| Exported config would leak `ocx_...` | Only `{env:OPENCODEX_OPENCODE_API_KEY}` is serialized; the real value rides the child process env |
| `limit.output` has no authoritative source | `SCHEMA_REQUIRED_OUTPUT_BUDGET` (32k, clamped to context) fills the schema-required half, and the whole `limit` block is dropped when no authoritative context exists |

The lesson is procedural: a survey of external formats is not a survey of our own
tree. Both halves are required before a phase map is credible.

## 2. Inventory of the shipped surface

### `src/cli/opencode.ts`

| Export | Role |
|--------|------|
| `buildOpencodeProviderBlockFromCatalog` | catalog rows -> V1 provider block. The real serializer core |
| `buildOpencodeProviderBlock` | test-facing wrapper over the same builder |
| `opencodeModelKey` | `provider/id` vs bare native slug |
| `opencodeProxyBaseUrl` | `http://<host>:<port>/v1` |
| `opencodeCatalogFromProxyRows` | `GET /api/models` rows -> catalog entries, drops disabled + dupes |
| `mergeOpencodeRuntimeConfig` | merges inherited inline config, overrides only `provider.opencodex` |
| `buildOpencodeConfig` / `serializeOpencodeRuntimeConfig` | assemble + stringify the inline runtime layer |
| `opencodeGlobalConfigPath` / `opencodeProviderOverridePath` / `projectConfigOverridesProvider` | detect (never write) user files |

Design properties worth preserving verbatim:

- **Never writes user config.** File layers are read for detection only; injection
  goes through `OPENCODE_CONFIG_CONTENT`. This avoids clobbering comments,
  relative `{file:...}` paths, and unrelated MCP credentials.
- **Never guesses metadata.** Absent context window means no `limit` block, not a
  fabricated one.
- **Never serializes a secret.**

### Adjacent precedents

- `src/cli/claude-desktop.ts` — writes a Claude Desktop 3P config.
- `gui/src/pages/ClaudeDesktop.tsx:313` — `exportProfile()` does Blob +
  `URL.createObjectURL` + `anchor.download`, then announces to a live region.
  This is the house pattern for browser-side JSON download and the 040 phase
  reuses it rather than inventing a second one.
- `src/cli/access.ts` — the `ocx access ...` family establishes the CLI contract
  this unit extends: `--json` on every subcommand, `printData(value, wantsJson, lines)`
  emitting either raw JSON or human lines from the SAME value.
- `src/server/management/model-routes.ts:115` — `GET /api/models`, the authenticated
  route whose rows already feed the OpenCode builder.

## 3. The actual gap

`ocx opencode` produces a provider block **only in memory, only at launch**, and
only for OpenCode. Three things are missing:

1. **No artifact.** A user who wants the provider block in their own
   `~/.config/opencode/opencode.json` cannot get it out of opencodex. There is no
   command that prints it and no file to download.
2. **No Pi support at all.** No serializer, no command, no surface.
3. **No shared abstraction.** The builder is private to the launcher module and
   shaped around one client's schema, so a second client cannot reuse it as-is.

Everything this unit builds is downstream of closing those three. The transport,
the catalog, and the security posture are already correct.

## 4. Catalog metadata availability

Checked because every serializer depends on it:

| Field | Source | Available? |
|-------|--------|-----------|
| context window | `CatalogModel.contextWindow`; `NATIVE_OPENAI_CONTEXT_OVERRIDES` + upstream `context_window` for native | yes, with a documented 128k fallback in `parsing.ts:287` |
| display name | `CatalogModel.displayName` | yes, optional |
| max output | none | **no** — 32k schema stand-in only |
| price | not on `CatalogModel` | **no** |
| input modality | `CatalogModel.inputModalities` | yes |
| reasoning | `CatalogModel.reasoningEfforts` | yes, as effort list |

Consequence for Pi: `cost` cannot be filled honestly. Emitting zeros would assert
"this model is free," which is false for routed providers. The 010 phase must
decide omit-vs-zero, and the survey's field table says `cost` is optional when the
key is absent — so omission is the honest option.
