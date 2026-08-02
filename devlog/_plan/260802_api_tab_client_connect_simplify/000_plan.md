# 000 — API tab: client connect rows and the end of the three-band split

Unit: `devlog/_plan/260802_api_tab_client_connect_simplify/`
Opened: 2026-08-02 · Work class: C3 · Branch target: `dev`
Base commit for every citation below: `eeef7012` ("feat(export): client config
export for Pi and OpenCode (#852)").

## Objective

Two outcomes on the API Access tab (`#api`), both requested directly by the
maintainer while looking at the rendered page:

1. **Client config stops being a wall of JSON.** Each export client becomes one
   compact row — mark, name, `Copy JSON`, `Download` — and everything else
   (config body, destination path, env var, merge warning) moves behind a
   detail dialog. Verbatim ask: "이것도 그냥 노출하지 말고 / (로고)pi copy Json
   Download / (로고)opencode copy Json Download / 이런식으로 아주 단순하게".
2. **The three-band split goes away.** The tab currently renders a rail plus a
   two-column overview inside a 1200px shell, which leaves each content band
   around 400px. Verbatim ask: "3분할은 진짜 없애고 싶어".

## Why this unit exists

The split is not a cosmetic complaint; it is the cause of four separate defects
that are visible in a screenshot at 1280x720:

- The auth matrix (`api-keys-endpoints-panel.tsx`) is a four-column table in a
  ~400px band, so the `x-api-key` column is off-screen behind a horizontal
  scroller. That table exists precisely because prose could not state a
  per-endpoint rule (`260731_api_tab_improvement/003` §3); a clipped matrix is
  back to not stating it.
- The model catalog stacks `Copy ID` plus one chip per protocol vertically. The
  stylesheet says so in its own words: "Three protocol chips plus Copy ID do not
  fit across a narrow catalog column" (`styles-apikeys-workspace.css:405`). One
  model row costs four lines.
- `ClientConfigPanel` renders the full config JSON at rest, which on a real
  catalog is a screen-height block in the narrowest usable column on the page.
- With zero keys the rail spends 240px to show a single "Overview" row, while
  the one action that matters (generate a key) sits in the middle band.

## Constraints

| Constraint | Source |
|-----------|--------|
| The GUI renders what `GET /api/client-config` returns; it never builds a config locally | `ClientConfigPanel.tsx:4`; `260731_client_config_export/003` §5 |
| No secret is ever rendered or serialized; only the `{env:...}`/`$VAR` reference | AGENTS.md security boundary; `src/clients/config-export.ts:11` |
| "Downloaded", never "applied" — a file in ~/Downloads changed nothing | `260731_client_config_export/003` §5; asserted in `gui/tests/client-config-panel.test.tsx` |
| The page owns vertical scroll; the model catalog is the only capped region | `260731_api_tab_improvement/050`; asserted in `gui/tests/apikeys-layout.test.ts` |
| Nothing load-bearing hides behind a closed disclosure | `260731_api_tab_improvement/003` §5 |
| Design tokens only, no gradients | `gui/src/styles-apikeys-workspace.css:1-10` |
| Six-locale `api.*` key parity | `gui/tests/apikeys-layout.test.ts` |

### The disclosure constraint versus this unit's ask

These two look contradictory and are not. The settled rule bans hiding **the
answer to a question the page exists to answer** — auth rules, endpoint URLs,
curl examples. The config JSON is not that: it is a payload the user transports
to another file, and the transport actions (`Copy`, `Download`) stay on the
surface at all times. What moves behind the dialog is the *inspection* path, and
inspection is a genuine progressive-disclosure candidate under UX-STATE-01. This
distinction is recorded here because a reviewer will otherwise read `010` as a
regression against `260731_api_tab_improvement/003` §5.

## Scope boundary

IN

- `gui/src/components/apikeys-workspace/ClientConfigPanel.tsx` — rewritten as a
  row list plus a detail dialog.
- `gui/src/components/apikeys-workspace/ApiKeysWorkspace.tsx` — single-column
  overview; rail disposition per `020`.
- `gui/src/pages/api-keys-panels.tsx`, `api-keys-endpoints-panel.tsx` — width
  assumptions only.
- `gui/src/styles-apikeys-workspace.css`.
- `gui/src/i18n/{en,ko,ja,zh,de,ru}.ts` — `api.clientConfig.*` additions.
- `gui/tests/client-config-panel.test.tsx`, `gui/tests/apikeys-layout.test.ts`,
  `gui/tests/apikeys-workspace.test.tsx` — updated to the new contract.
- This devlog unit.

OUT

- Any change to `src/` runtime behavior, `/api/client-config` response shape, or
  `src/clients/config-export.ts`. The row list is built from the client ids the
  route already accepts.
- New export clients. Adding `gajae-code` or `oh-my-openagent` is `030`'s
  research question and explicitly not this unit's build.
- Other tabs (Providers, Models, Usage, Storage, Dashboard).
- Key expiry, scopes, rotation, attribution telemetry — owned by
  `260731_api_tab_improvement`.
- Release, publish, deploy, or any push to a remote.

## Work-phase map

Dependency-ordered, not effort-ordered.

| Phase | Doc | Delivers | Verified by |
|-------|-----|----------|-------------|
| 1 | `020_single_column_layout.md` | Single-column overview, full-width catalog and matrix; rail retained (P-gate measurement) | `cd gui && bun test tests`, `bun run lint`, `bun run build`; rendered observation at 1280x720. No copy change, so no `lint:i18n` |
| 2 | `010_client_connect_rows.md` | Row list + detail dialog in `ClientConfigPanel` | same gate set plus `bun run lint:i18n`; rendered observation |
| — | `030_external_client_research.md` | Feasibility record for gajae-code and oh-my-openagent | Cited URLs + commit anchors; no writes to those repos |

### Why the layout phase runs first (revised at the A gate)

The original map put the connect rows first on the reasoning that a panel's
internals settle before the panel moves. The audit rejected that, correctly: a
row built inside today's ~300px panel interior is designed against geometry the very
next phase deletes. Its wrapping behavior, destination truncation, and action
placement would all be tuned twice, and the second tuning would be invisible to
the tests written during the first.

The true dependency runs the other way. `020` can treat `ClientConfigPanel` as an
opaque child — it moves the node without reading it — and is independently
verifiable the moment the grid collapses. `010` genuinely depends on `020`,
because a row's layout is a function of its container's width.

`030` is research and depends on nothing. It carries no phase number in the
build order and is already complete; it is numbered `030` only to keep the
decade-doc convention intact.

The doc filenames keep their original numbers so that citations already written
into this unit stay valid. **Build order is the table above, not the filename
order.**

## Research documents

| Doc | Contents |
|-----|----------|
| `001_surface_inventory.md` | What renders today, which selectors and tests pin it, what the route supplies |
| `002_ux_direction.md` | Design Read, dials, row anatomy, dialog contract, rail disposition |

## Open assumptions

1. **The GUI's client list is a hand-maintained local tuple, not a mirror of
   `EXPORT_CLIENT_IDS`.** The panel maps over its own `CLIENTS` constant
   (`ClientConfigPanel.tsx:15`), because importing `src/clients/config-export.ts`
   would pull backend modules into the browser bundle. Adding a third export
   client server-side therefore renders **no** third row until someone edits that
   tuple by hand — exactly as today. `010` §Client list ownership carries the
   reasoning; no automatic membership tracking is delivered by this unit.
2. **No brand mark ships for Pi.** `gui/public/provider-icons/` has
   `opencode.svg` and no Pi asset, so the OpenCode row uses its real logo and Pi
   falls back to a monogram tile (`002` §4, revised at the A gate). Inventing a
   Pi logo is out of scope and an emoji is banned outright.
3. **The rail stays — settled, no longer an assumption.** `020`'s P gate ran the
   decision rule and the arithmetic refused the fold: a six-column key table
   needs ~1064px inside a 912px table interior at 1280×720, once the 232px app
   sidebar (`styles.css:241`), the panel and `.tbl-wrap` border/padding, and
   `.tbl` cell padding are all counted — an overflow of 152px. The rule's own
   fallback therefore applies and the rail is retained. See `020` §Rail decision
   for the corrected measurement and the errors in the first pass.

   Consequence for this unit's scope: no key table, no `ApiKeyDetailDialog`, and
   no locale change in phase `020`. The unit's locale work stays exactly what
   §Scope declares — `api.clientConfig.*` in `010` — and the three GUI test files
   listed there remain the full set.
