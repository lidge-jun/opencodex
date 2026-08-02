# 010 — Client connect rows and detail dialog

Dependency position: **second**, after `020`. Revised at the A gate — see `000`
§"Why the layout phase runs first". The rows are built inside their final
container width so their wrapping and truncation behavior is designed once.

Base: `eeef7012`. At this phase's P gate, re-read the actual tree and rebase
every citation below.

## Scope

IN

- Rewrite `ClientConfigPanel` as a list of per-client rows, one row per entry in
  the panel's **local** `CLIENTS` tuple (see §Client list ownership), each owning
  its own fetch and its own state.
- Add a detail dialog carrying the config JSON and every field the row does not
  show.
- Row: mark slot (real asset where one exists, monogram fallback otherwise),
  client label, destination path, model count, `Copy JSON`, `Download`,
  `Details`.
- Eight new `api.clientConfig.*` strings in all six locales, plus the removal of
  `api.clientConfig.clientLabel` from all six.
- Update `gui/tests/client-config-panel.test.tsx` to the new contract.
- The `SectionTabs` decision deferred from `020` (see accept criterion 11).

OUT

- Any change to `/api/client-config`, `src/clients/config-export.ts`, or the
  client id list.
- Column structure, rail, or any other panel on the tab — that is `020`. The one
  exception is the `SectionTabs` strip deferred here by `020` (accept criterion
  11), which is a page-level addition this phase may make.
- New brand assets.

## File change map

| Path | Action |
|------|--------|
| `gui/src/components/apikeys-workspace/ClientConfigPanel.tsx` | REWRITE — panel becomes a row list; per-client fetch hook; dialog trigger |
| `gui/src/components/apikeys-workspace/ClientConfigRow.tsx` | ADD — one row: identity, actions, per-row error/retry |
| `gui/src/components/apikeys-workspace/ClientConfigDialog.tsx` | ADD — native `<dialog>` detail view, full contract in §Dialog |
| `gui/src/styles-apikeys-workspace.css` | MODIFY — `.awi-clientconfig-row*`, mark slot, dialog body; delete `.awi-clientconfig-segmented*` (`:489-509`) |
| `gui/src/i18n/en.ts` (+ ko, ja, zh, de, ru) | MODIFY — **add the eight keys in §Strings and remove `api.clientConfig.clientLabel`** from all six |
| `gui/tests/client-config-panel.test.tsx` | MODIFY — contract edits per §Test changes |
| `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx` | MODIFY **only if** accept criterion 11's measurement calls for a `SectionTabs` strip |
| `gui/tests/apikeys-layout.test.ts` | MODIFY **only if** the strip is added |

## Client list ownership

`EXPORT_CLIENT_IDS` and `EXPORT_CLIENTS` live in `src/clients/config-export.ts`,
which is **backend** code: importing it into the GUI would pull `node:os`,
`node:path`, and the proxy's config types into the browser bundle. The panel
therefore keeps its existing local tuple (`ClientConfigPanel.tsx:15`) and maps
over it.

This is duplication, and it is deliberate. The alternative — a server endpoint
returning the client list — is a `src/` change and OUT of this unit's scope. The
existing "keep in sync with EXPORT_CLIENT_IDS" comment stays and is the only
coupling. **No automatic membership tracking is implied or delivered**; adding a
third export client will require touching this tuple by hand, exactly as today.

`ApiKeysWorkspace.tsx` keeps rendering `<ClientConfigPanel apiBase baseUrl
hasKeys />` with the same props, so the row work does not touch it. The single
authorized reason to edit that file in this phase is adding the `SectionTabs`
strip if criterion 11's measurement calls for one.

## Component contract

```
ClientConfigPanel({ apiBase, baseUrl, hasKeys })
  ├ panel head: title + base URL line (kept; survives every row failing)
  ├ CLIENTS.map -> ClientConfigRow({ client, apiBase, hasKeys, onOpenDetails })
  └ ClientConfigDialog({ client, envelope, hasKeys, onClose })  // one instance, state-driven
```

One dialog instance driven by `openClient: ClientId | null`, not one per row: two
mounted dialogs mean two focus traps.

### Per-row state machine

Reuse the request-tag discipline the current panel already proves correct
(`ClientConfigPanel.tsx:47-96`): a `requestKey` of `${client}:${attempt}`, a
settled result carrying its own key, `loading` derived rather than reset in the
effect body, and a `cancelled` flag beside the abort signal.

| State | Row shows |
|-------|-----------|
| loading | identity + skeleton on the meta line; actions disabled |
| ready | identity, destination, model count; all actions enabled |
| error | identity, error text (`role="alert"`), `Retry`; actions disabled |

`hasKeys === false` never disables anything (existing rule, `003` §3 of the
export unit) — the no-key note lives in the dialog.

## Dialog contract

The audit rejected an earlier claim that the dialog "inherits" its behavior from
`.modal-overlay`. CSS supplies appearance and scrolling; **every** behavior below
is code this phase writes, modeled on `codex-account-reset-modal.tsx:29-51`:

| Behavior | Implementation |
|----------|----------------|
| Open | `dialogRef.current.showModal()` in an effect, guarded by `!dialog.open` |
| Escape | `onCancel` handler calling `preventDefault()` then the close callback |
| Backdrop dismiss | `button.modal-backdrop-dismiss` with `tabIndex={-1}`, plus `stopPropagation` on the card |
| Focus return | Store the triggering `Details` button in a ref; `.focus()` it on close |
| Labelling | `aria-labelledby` pointing at the dialog's own title node |
| Single instance | One dialog driven by `openClient: ClientId \| null` — never one per row |
| Cleanup | Close on unmount so a stale dialog cannot survive a parent re-render |

`.modal-card` (`gui/src/styles.css:1177`) already provides `max-height: 84vh` and
`overflow-y: auto`, and it lives in a stylesheet the scroll test does not read —
so the tall JSON body scrolls without adding a `max-height` to
`styles-apikeys-workspace.css`. Verified during the audit.

## Strings

Added — eight keys (English shown; all six locales get the same key set):

| Key | English |
|-----|---------|
| `api.clientConfig.rowsLabel` | `Connect a client` |
| `api.clientConfig.details` | `Details` |
| `api.clientConfig.detailsAria` | `{client} config details` |
| `api.clientConfig.copyAria` | `Copy {client} config JSON` |
| `api.clientConfig.downloadAria` | `Download {client} config` |
| `api.clientConfig.rowMeta` | `{destination} · {count} model(s)` |
| `api.clientConfig.rowError` | `Could not build the {client} config.` |
| `api.clientConfig.copiedAnnounceClient` | `{client} config JSON copied to the clipboard.` |

Retained unchanged: `title`, `clientOpencode`, `clientPi`, `copy`, `download`,
`loading`, `jsonLabel`, `destination`, `envHint`, `mergeWarning`, `modelCount`,
`missingLimits`, `noKeyYet`, `loadFailed`, `copyFailed`, `downloadedAnnounce`,
`whereDisclosure`, `whereBody`.

**Removed: `api.clientConfig.clientLabel`**, from all six dictionaries. It is the
segmented group's `aria-label` and the group is gone. Its seven references (six
dicts + `ClientConfigPanel.tsx:155`) were enumerated during the audit; there are
no others. The parity test catches a partial removal.

`copiedAnnounce` is **retained and must be consumed** by the dialog's own copy
button, which announces without a client prefix because the dialog title already
names the client. This repository has no unused-key lint, so a retained key that
nothing references would pass every gate — if the dialog does not use it, delete
it from all six dictionaries instead.

The file-change map and this section previously disagreed ("remove none" vs. a
required deletion). The map now states the deletion; this note records that the
contradiction was real and is resolved in favor of deletion.

## Test changes

Each is a contract edit with a reason, not a deletion.

Every REPLACE below preserves the invariant its original protected. The audit
found the first draft quietly dropping three guards; each is now carried
explicitly and named in the "Guard carried" column.

| Test | Change | Guard carried |
|------|--------|---------------|
| "switching client refetches and swaps the rendered payload shape" | REPLACE with "each row fetches its own client and its dialog renders that client's exact bytes": open each dialog in turn and `expect(JSON.parse(...)).toEqual(ENVELOPE.config)` per client | **Payload identity per client** — the original's real subject. Destination-only assertions would have lost it |
| "client switch is a segmented radio group" | REPLACE with "clients render as rows, not a switch": two `.awi-clientconfig-row`, no `role=radiogroup`, no `select` | Encodes the maintainer's ask |
| "download emits … never says applied" (`:126`) | KEEP, retarget to a row's `Download`; **split off** its merge-warning assertion (`:162`) into the dialog test | Filename, forbidden words, **and** merge-warning visibility — the latter moves rather than disappears |
| "route failure … no partial JSON, base URL visible" (`:173`) | REPLACE with per-row isolation, **retaining both original assertions**: the failed row renders no JSON, the panel still shows the base URL, and the sibling row's actions stay enabled | No-partial-JSON + base-URL survival + new row isolation |
| "degraded line appears only when models ship without context limits" | RETARGET into the dialog | Degraded line reachable |
| "no-key state is informational…" | RETARGET: note in dialog, buttons enabled on the row | Non-blocking no-key state |
| "cold load … no second live region" | KEEP, strengthen to N rows | Exactly one `[aria-live]` |
| NEW "the config JSON is not rendered at rest" | ADD: no `.awi-clientconfig-json` until `Details` is clicked | The core ask, made enforceable |
| NEW "dialog closes on Escape and returns focus to its trigger" | ADD, plus backdrop dismiss | New interactive surface |
| NEW "a superseded response never replaces a newer one" | ADD: resolve a stale in-flight fetch after a retry has settled | The `requestKey` guard, which was listed as an activation scenario but assigned to no test |
| NEW "row actions are individually labelled" | ADD: each `Copy JSON` / `Download` carries a client-qualified accessible name | Duplicate unlabelled buttons across rows |

## Accept criteria

1. With both routes stubbed OK, the panel renders exactly two rows and zero
   `.awi-clientconfig-json` nodes.
2. Clicking a row's `Details` renders exactly one dialog containing that
   client's config JSON, destination, env hint, and merge warning.
3. Escape closes the dialog; focus returns to the `Details` button that opened
   it.
4. Stubbing one client to 503 leaves the other row's `Copy JSON` and `Download`
   enabled, and shows `Retry` only on the failed row.
5. `Download` still emits the server-provided filename, and the announcement
   still contains "Downloaded" and none of applied/saved/configured.
6. Exactly one `[aria-live]` region exists with both rows mounted.
7. All six locales carry an identical `api.*` key set, with `clientLabel` absent
   from every one.
8. Every row action has a client-qualified accessible name; the row group is a
   labelled list.
9. At 375px and 720px rendered: no horizontal overflow, the destination
   truncates rather than wrapping to a third line, and every action stays
   reachable in tab order.
10. The GUI gate set in §Verifier commands passes.
11. The `SectionTabs` decision, deferred here from `020`: measure the finished
    page height at 1280×720 once the rows have replaced the JSON block. Add the
    strip only if the page exceeds roughly two viewport heights, and record the
    measured number either way. `020` could not decide this — it runs first, so
    its measurement would still have included the tall block this phase removes.

## Row marks (revised at the A gate)

The first draft chose a letter monogram for both clients on symmetry grounds.
The audit pushed back: the maintainer's sketch explicitly said "(로고)", a real
`opencode.svg` exists, and mixed logo/fallback rendering is ordinary capability
degradation rather than a bug.

Revised: **use `gui/public/provider-icons/opencode.svg` for the OpenCode row**,
and a monogram tile only for clients with no asset (currently Pi). The mapping is
a small export-client → asset record local to this panel, deliberately separate
from `provider-icons.ts`'s provider aliases (`001` §4 — the namespaces are
unrelated and coupling them would be wrong).

### Activation scenarios for conditional paths

Every branch this phase adds names how C fires it (C-ACTIVATION-GROUNDING-01):

| Conditional path | Trigger in C | Observable effect |
|------------------|--------------|-------------------|
| Per-row error state | Stub that client's GET to 503 | `Retry` present on that row only; sibling actions enabled |
| Retry attempt bump | Click `Retry` after a 503 | Second fetch recorded for that client id; JSON becomes available |
| Degraded line | Envelope with `modelsWithoutLimits > 0` | `.awi-clientconfig-degraded` inside the dialog |
| No-key note | Mount with `hasKeys={false}` | Note visible in the dialog; row buttons remain enabled |
| Superseded response guard | Resolve a stale request after a retry | Stale payload never replaces the newer one |

## Verifier commands

Run at P before being written into this table, per PLAN-VERIFIER-REAL-01.

**Bun is not on PATH on this machine.** `bun` exits `command not found`; this
checkout's binary is `./node_modules/.bin/bun` (1.3.14). Every command below is
prefixed accordingly. `bun test` also requires a `./`-prefixed path or it treats
the argument as a filter and matches nothing while still exiting 0 — a silent
false green worth naming.

**Root `typecheck` is not a GUI gate.** The audit established that root
`tsconfig.json:15` includes only `src`, so a GUI-only type error cannot fail it
(`001` §7). The authoritative gate set is the one `gui/AGENTS.md:42` mandates:

| Command (from `gui/`) | Exit at plan time | Reads this phase's target? |
|---|---|---|
| `bun test tests` | not yet run for the full dir | Yes — mounts `ClientConfigPanel` |
| `bun run lint` | not yet run | Yes — eslint over `gui` |
| `bun run build` | not yet run | Yes — `tsc -b && vite build`; this is what actually typechecks the GUI |
| `bun run lint:i18n` | not yet run | Yes — mandatory after copy changes, and this phase changes copy |

Focused runs executed at plan time from the repository root, against the
unmodified tree:

| Command | Exit | Result |
|---------|------|--------|
| `./node_modules/.bin/bun test ./gui/tests/client-config-panel.test.tsx` | 0 | 7 pass |
| `./node_modules/.bin/bun test ./gui/tests/apikeys-layout.test.ts` | 0 | 6 pass |
| `./node_modules/.bin/bun run typecheck` | 0 | backend only — does **not** observe this phase |
| `./node_modules/.bin/bun run lint:gui` | 0 | observes `gui` |

13 pass / 0 fail / 113 assertions across the two focused files. Rendered
observation at `http://localhost:10100/#api` remains mandatory and is the only
check that can see the delivered result.

## Bypass record (PLAN-BYPASS-NAMED-01)

This phase adds no enforcement mechanism; it changes a rendering surface. The
guards it relies on are pre-existing test assertions.

- Tier: E8 (test suite).
- Executing surface: `bun run test` in CI and locally.
- Known bypass: a contributor editing the assertion in the same commit as the
  regression. Nothing prevents that.
- Residual risk: the "no JSON at rest" property is one assertion away from being
  unenforced.
- Wording: this is an early warning, not enforcement. Final enforcement layer:
  none.
