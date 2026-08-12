# 020 — WP2: `/api/codex-prompt`

New file: `src/server/management/codex-prompt-routes.ts`.
Registered in `src/server/management-api.ts`.
Shape from `sidebar-routes.ts:23-89`; GET/PUT semantics from
`agent-settings-routes.ts:127-178` (`004` §F).

## Endpoints

### `GET /api/codex-prompt`

```jsonc
{
  "configPath": "~/.codex/config.toml",
  "storePath": "~/.codex/opencodex-prompt.json",
  "configExists": true,
  "readable": true,
  "developerInstructionsOwned": true,
  "drift": null,
  "revision": "sha256:...",
  "inventory": [
    { "id": "base-instructions", "class": "base",
      "key": null, "default": null, "order": 0 },
    { "id": "permissions", "class": "config-toggle",
      "key": "include_permissions_instructions", "default": true, "order": 6 },
    { "id": "plugins", "class": "feature-gated",
      "key": "features.plugins", "default": true, "order": 11 },
    { "id": "agents-md", "class": "runtime-conditional",
      "key": null, "default": null, "order": 5 }
  ],
  "toggles": [
    { "id": "permissions", "key": "include_permissions_instructions",
      "userFileValue": null, "defaultedUserValue": true, "default": true }
  ],
  "extensionLayersEnumerable": false,
  "custom": [
    { "id": "a1b2c3", "title": "My house rules", "enabled": true, "body": "..." }
  ],
  "modelInstructionsFile": null
}
```

`inventory` **is** `LAYER_INVENTORY` from WP1, serialized. The audit found the
first draft inventing `locked` and `features` arrays the core module did not
export — two constants that would drift apart within a release. There is now one
definition, in WP1, and the route projects it.

A row gets a switch **iff** `class === "config-toggle"`. Classes `base` and
`runtime-conditional` are the non-disableable set behind ask item 9;
`feature-gated` rows are configurable, but not from here.

`extensionLayersEnumerable: false` is the honest statement of `001` class E: we
cannot list third-party extension layers, so we say so rather than implying the
inventory is exhaustive.

No `effective` field exists. `010` explains why: opencodex reads one file out of
the eight layers in `003` §1, so it reports that file's value under a name that
says as much.

### `PUT /api/codex-prompt/toggle`

`{ "id": "apps", "enabled": false, "revision": "sha256:..." }`
→ `{ "ok": true, "changed": true, "snapshot": {...} }`

- `id` not a `config-toggle` in `LAYER_INVENTORY` → `409 layer_not_toggleable`.
  This covers classes A, C, D, and E in one rule, derived from the inventory
  rather than a hand-maintained deny-list.
- `id` unknown entirely → `400 unknown_layer`.
- missing/stale `revision` → `409 stale_revision`.
- unreadable config → `409 config_unreadable`.

The GUI never sends a locked id. The route refuses it anyway: a hand-rolled
request must not be able to do what the UI forbids.

### `PUT /api/codex-prompt/custom`

`{ "layers": [...], "revision": "sha256:..." }` — full replacement, order is
composition order.

Refused with `409 developer_instructions_not_owned` when the key exists without
our marker (`010` §Ownership). The GUI offers **Adopt** — preview, copy,
confirm — rather than telling the user to edit the file by hand.

Validation before any file access:

| Rule | Response |
|---|---|
| `layers` not an array | `400 invalid_body` |
| > 32 layers | `400 too_many_layers` |
| id not `[a-z0-9]{6}` | `400 invalid_layer_id` |
| duplicate id | `400 duplicate_layer_id` |
| title empty, > 80 chars, or contains a newline | `400 invalid_title` |
| body > 64 KiB | `400 body_too_large` |
| composed total > 128 KiB | `400 composed_too_large` |
| control character in body | `400 invalid_characters` with position |

The size caps are **opencodex policy**, not a Codex limit. `002` §3 records that
Codex validates nothing beyond readable-and-non-empty. The audit correctly
rejected an earlier draft that justified a cap with the 32 KiB AGENTS.md budget
— that budget governs project-doc loading and has nothing to do with
`developer_instructions`. The real justification is request cost and keeping a
hand-editable file hand-editable.

Tabs and CRLF are normalized rather than rejected. Control characters are
refused: `010` records a measured `Bun.TOML.parse` defect that makes local
verification untrustworthy, so the encoding is restricted to a character set
whose escaping is total under three unambiguous rules.

### `POST /api/codex-prompt/adopt`

Takes ownership of an externally authored `developer_instructions`. Returns the
raw source line for preview when called with `{ "confirm": false }`, and
performs the import only on `{ "confirm": true, "revision": "..." }`.

Refused with `409 adopt_unsupported_form` when the value is not a single-line
basic string, naming the file path and line number so the user can move it by
hand. `010` §Ownership explains why a broader extraction is not attempted.

### `POST /api/codex-prompt/repair`

The only endpoint that resolves a `drift` state. Revision-checked like any
mutation. GET never repairs anything — an HTTP GET must not modify a user's
configuration.

`drift` is the canonical type from `010`: `"journal-present"`,
`"projection-stale"`, `"store-missing"`, `"owned-malformed"`, or `null`. An
earlier draft omitted `owned-malformed`, which would have left the GUI unable to
resolve the one state a user can reach by reformatting a line we generated.

| drift | Action | Preview |
|---|---|---|
| `journal-present` | run recovery; `recovery_required` is terminal until resolved | — |
| `projection-stale` | re-project from the store | the resulting projection |
| `store-missing` | **salvage** the projected text as **one** layer | body + the enumerated losses + backup path |
| `owned-malformed` | `mode: "adopt"` re-adopts through the narrow decoder, `mode: "replace"` overwrites with an empty owned line | raw line + decoded body |

`store-missing` is **salvage, not reconstruction**. `010` §Missing store
enumerates what cannot come back: layer boundaries, ids, titles, order, disabled
layers, and whether a `\n\n` was a separator or the user's own text. The preview
lists them and a backup is written before anything is destroyed.

Every preview is a **GET-shaped read** performed by `previewSalvage` /
`previewAdopt`; the write happens only on a confirmed `POST` carrying a matching
revision.

## Response echoes the snapshot

Every mutating response returns the freshly re-read snapshot, so the GUI can
`setClientResourceData` with server truth instead of optimistic local state
(`004` §G, `client-resource.ts:464-482`).

## Auth

Nothing extra. `requireManagementAuth` already covers `/api/**`
(`server/index.ts:448-453`) and unsafe methods already require Origin + CSRF
(`management-auth.ts:246-266`). This is a local-config write, not an
account-identity action, so it does **not** need the `agent_consent_required`
treatment that `/api/github/star` carries.

## Privacy

The snapshot carries file paths and user-authored prompt text. It carries no
token, key, or account identifier. Layer bodies are user content the user just
typed into this same GUI — echoing them back is not disclosure. Nothing here is
logged: `privacy:scan` stays green because the route never writes request
bodies to any log sink.

## Tests — `tests/codex-prompt-route.test.ts`

Harness from `sidebar-routes.test.ts:18-58`: a helper building Host-bearing
requests, dispatching `handleManagementAPI`, restoring seams in `finally`. The
WP1 module is injected so **no test touches the real `CODEX_HOME`**.

1. GET returns the snapshot with the full inventory
2. GET on a missing config → defaults, `configExists: false`
3. PUT toggle flips a value and echoes the new snapshot
4. unknown id → 400
5. **every non-`config-toggle` inventory id → 409, writer never called** —
   table-driven over `LAYER_INVENTORY`, so a new upstream layer is covered the
   day it is added
6. **contract test: every inventory id has exactly one class, and every
   `config-toggle` has a non-null key** — the partition guard
7. PUT custom round-trips order
8. each validation rule, one case each
9. stale revision → 409 on every mutating verb
10. unowned `developer_instructions` → 409 on custom; toggles still work
11. unreadable config → 409 on all mutations
12. hostile Origin rejected (mirrors `management-client-config-route.test.ts:240`)
13. unhandled path returns `null` so the chain continues
14. adopt preview returns the raw line and **writes nothing**
15. adopt without `confirm: true` writes nothing
16. adopt on an unsupported form → 409 with path and line
17. every `drift` state is reported by GET and **GET writes nothing**
18. repair requires a matching revision
19. control-character body → 400 with position

Cases 5 and 6 are load-bearing: 5 proves ask item 9 at the API boundary, 6
prevents the inventory drift the audit found in the first draft.
