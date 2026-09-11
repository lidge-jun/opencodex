# 021 — WP2 amendments after the WP1 landing

`020` was written against the WP1 *plan*. WP1 then landed and moved. An
independent audit against the shipped `src/codex/prompt-layers.ts` returned seven
findings; this document resolves each one and is the authority where it and
`020` disagree.

## 1. `inventory[]` and `extensionLayersEnumerable`

`inventory[]` is a projection of the exported `LAYER_INVENTORY`
(`prompt-layers.ts:87`), serialized field-for-field. The route defines no second
table.

`extensionLayersEnumerable` is derivable from nothing WP1 exports, and it should
not be: it is a statement about what opencodex *can* know, not about the file.
The route emits the literal `false` with the reasoning inline. If class E ever
becomes enumerable, this constant is the one place that changes.

The `~/.codex/...` paths in `020`'s example are illustrative only. WP1 returns
resolved absolute paths (`prompt-layers.ts:145-150`) and the route forwards them
unmodified.

## 2. The plugins row

`020`'s example lists `plugins` as `feature-gated` with key `features.plugins`.
The landed inventory has it as `runtime-conditional` with a null key
(`prompt-layers.ts:99`), because `core/src/mcp.rs:200` computes
`selected_plugin_available || !capability_summaries().is_empty()` — the feature
flag influences one operand but does not gate emission.

The landed code is correct. `020`'s example is stale and is superseded here.
Because the route projects the inventory rather than restating it, this class of
drift cannot recur.

## 3. Error translation

Five `020` codes pass through unchanged: `unknown_layer`, `stale_revision`,
`config_unreadable`, `developer_instructions_not_owned`, `invalid_characters`.

Two are route-derived, because WP1 cannot express them:

| Code | Derivation |
|---|---|
| `layer_not_toggleable` | id is in `LAYER_INVENTORY` but `class !== "config-toggle"`. Checked **before** `setToggle`, which collapses every non-toggle id into `unknown_layer` (`prompt-layers.ts:748`). |
| `adopt_unsupported_form` | `previewAdopt().reason === "unsupported_form"` (`prompt-layers.ts:826`). `adoptDeveloperInstructions` collapses it to `developer_instructions_not_owned`, so the route previews first and translates. |

Seven are pure request validation and never reach WP1: `invalid_body`,
`too_many_layers`, `invalid_layer_id`, `duplicate_layer_id`, `invalid_title`,
`body_too_large`, `composed_too_large`. WP1 validates characters and normalizes;
size and shape policy is the route's.

Four WP1 errors `020` never mentioned need HTTP mappings, because a user can
reach every one of them:

| WriteError | Status | Meaning to the user |
|---|---|---|
| `locked` | 409 | another writer holds the cross-process lock; retry |
| `write_superseded` | 409 | the file moved under the write; re-read and retry |
| `recovery_required` | 409 | a journal could not be replayed; terminal until repaired |
| `store_unreadable` | 409 | declared but not currently emitted; mapped so a future emission is not a 500 |

An unmapped `WriteError` must be a typecheck failure, not a runtime surprise:
the mapping is a `Record<WriteError, number>`, so adding a variant upstream
breaks the build until it is classified.

## 4. The path seam

`ManagementApiDeps` gains `codexPromptPaths?: Paths`. Every WP1 entry point the
route calls already accepts `Paths` (audit §4 verified all seven signatures), so
the seam is a single optional field threaded through, with production leaving it
unset and WP1 resolving the real `CODEX_HOME`.

This is not a convenience. A route test that could not inject paths would read
and **write** the developer's live `~/.codex/config.toml` — the same class of
incident `ManagementApiDeps.saveConfigPreservingClaudeCode` exists to prevent
(`context.ts:29-35`).

## 5. Repair, honestly scoped

`020` claimed four drift branches. Two are implementable from WP1 exports today
and two are not. WP2 ships what it can prove and says so:

| drift | WP2 behavior |
|---|---|
| `projection-stale` | re-project: `writeCustomLayers(snapshot.custom, revision, paths)`. Preview via `composeProjection`. |
| `store-missing` | `previewSalvage` / `salvageProjection`. The preview returns `backupDir`, not a reserved filename — a read-only preview must not reserve one — and the response says so. |
| `journal-present` | **not repairable from this route.** Recovery lives inside `commit` (`prompt-layers.ts:627-654`) and is not exported. The route returns `409 repair_unsupported` naming the drift, and any ordinary mutation triggers recovery on its own path. |
| `owned-malformed` | `mode: "adopt"` only, through `previewAdopt`/`adoptDeveloperInstructions`. `mode: "replace"` has no WP1 export and is **not shipped**; the route refuses it with `409 repair_unsupported`. |

Inventing a recovery-only export inside WP2 would put a second write path next
to WP1's journal — the one place in this unit where a bug destroys a user's
configuration. Two unsupported branches, named in the response, beat a
hand-rolled duplicate of the transaction.

`020`'s sentence "the only endpoint that resolves a drift" is also wrong about
the landed code: `commit` replays a journal before performing any mutation
(`prompt-layers.ts:650-668`), so recovery is not exclusive to repair. GET
remains read-only, which is the part that mattered.

## 6. Size caps are the route's

The `previewAdopt` docstring mentions a "cap" step the implementation does not
perform. WP2 does not rely on it: `body > 64 KiB` and `composed > 128 KiB` are
checked in the route, before any file access, on adopt exactly as on custom
writes.

## 7. Test consequences

`tests/codex-prompt-route.test.ts` keeps `020`'s nineteen cases and adds four:

20. every `WriteError` variant maps to a status — table-driven over the union
21. `repair_unsupported` for `journal-present` and for `mode: "replace"`
22. the injected `codexPromptPaths` is honored on **every** verb, proven by
    asserting the fixture file changed and no other path was touched
23. `plugins` — a `runtime-conditional` row — is refused by toggle, which is
    case 5's table, pinned as a named regression for finding §2

## 8. Round-2 corrections

Three findings survived the first amendment. All three are real.

### 8.1 Salvage writes its backup before the revision is checked

`salvageProjection` creates the durable backup and only then enters `commit`,
where `stale_revision` is evaluated (`prompt-layers.ts:942-955`, `:656-664`). A
stale request therefore leaves a `.salvage-*.txt` file behind while returning
409 and changing nothing else.

This is not a data-loss bug — the backup is additive, the config and store are
untouched, and the file is exactly the text the user already has. It is still a
side effect on a refused request, so WP2 does not pretend otherwise:

- The route **pre-checks the revision** against the freshly read snapshot before
  calling `salvageProjection`, which removes the ordinary stale-tab path.
- The race that remains (the file moves between the pre-check and WP1's own
  check) can still orphan one backup. The response documents the backup
  directory, and the repair preview already names it.
- WP1 is **not** modified from WP2 to close this. Reordering a write inside the
  transaction is a WP1 change with its own test obligations, and a route may not
  reach into it.

### 8.2 Adopt caps are checked after a read-only preview, not before any file access

§6 said "before any file access", which is impossible: the value being measured
lives in `config.toml`, so `previewAdopt` must read it first. The accurate rule
is **after the read-only preview and before any write**. `previewAdopt` performs
no write (`prompt-layers.ts:813`), so nothing has been mutated at the point the
cap is applied.

Both limits are **UTF-8 byte length**, not character count. The composed cap on
adopt measures the imported body together with the already-enabled custom
layers, because that is what `composeProjection` will produce.

### 8.3 Repair scope, stated correctly

§5's summary line said "projection-stale + store-missing". Three branches are
supported and one is not:

| drift | supported |
|---|---|
| `projection-stale` | yes — re-project |
| `store-missing` | yes — salvage, with 8.1's pre-check |
| `owned-malformed` | yes for `mode: "adopt"`; `mode: "replace"` refused |
| `journal-present` | no — `repair_unsupported` |

### 8.4 Test cases 20 and 22, restated

Case 20 cannot be "table-driven over the union": a TypeScript union does not
exist at runtime. Exhaustiveness is a **typecheck** property of
`Record<WriteError, number>`; the runtime test iterates `WRITE_ERROR_STATUS` and
asserts every entry is a valid 4xx. `store_unreadable` is declared but never
emitted by landed WP1, so no test induces it — the mapping exists so a future
emission is not a 500.

Case 22 cannot prove "no other path was touched" from fixture mutation alone.
It uses a **second decoy directory** holding sentinel `config.toml` and
`opencodex-prompt.json` files, asserts they stay byte-identical across every
verb, and proves read-only verbs by reading fixture-specific content out of the
response rather than by observing a change.

