# 000 — Client config export for Pi and OpenCode

Unit: `devlog/_plan/260731_client_config_export/`
Opened: 2026-07-31 · Work class: C3 · Branch target: `dev`

## Objective

Let a user or an agent take the opencodex model catalog out of the proxy as a
ready-to-use custom-provider config for Pi and OpenCode, through four surfaces
that all serve the same bytes: CLI text, CLI `--json`, management API, and a GUI
panel with copy + JSON download.

## Why this unit exists

The proxy already speaks the wire every client understands. What it does not do is
hand over the *metadata* — which models exist, what they are called, how large
their context is — in the dialect each client's config file expects. Today a user
wanting opencodex in Pi writes that JSON by hand, and gets it wrong, because model
ids are namespaced and context windows are not guessable.

`ocx opencode` solves half of this already, in memory, at launch, for one client
(`002`). This unit turns that private capability into an artifact and adds Pi.

## Constraints

| Constraint | Source |
|-----------|--------|
| Never serialize a live key; emit an env reference | AGENTS.md security boundary; `001` §3 |
| Never write or rewrite a user's client config file | existing `ocx opencode` design; `002` §2 |
| Never guess model metadata; omit what we do not know | existing `limit`-drop rule; `002` §4 |
| One payload, four presentations | `003` §2 |
| OpenCode V1 schema only | `001` §2 |
| Bun-native TypeScript, `dev` branch | AGENTS.md |

## Scope boundary

IN
- Client-neutral export core with OpenCode + Pi serializers.
- `ocx export --client <id> [--json] [--out]`.
- `GET /api/client-config?client=<id>`.
- GUI panel: client switch, JSON preview, copy, download.
- Tests at each phase; docs-site update when the CLI surface lands.

OUT
- OpenCode V2 schema migration (recorded in `001`, not built).
- Automatic merging into an existing user config file.
- Any client beyond Pi and OpenCode. Claude Desktop already has its own path.
- Changes to routing, adapters, or the catalog itself.
- Pricing metadata. We do not have it; `cost` is omitted rather than faked.

## Work-phase map

Dependency-ordered. Each phase is one full PABCD cycle and closes with something
independently verifiable.

| Phase | Doc | Delivers | Verified by |
|-------|-----|----------|-------------|
| 1 | `010_export_core.md` | `src/clients/config-export.ts`; OpenCode builder relocated, Pi serializer added | unit tests + golden diff against pre-refactor output |
| 2 | `020_cli_surface.md` | `ocx export` with `--json` / `--out` | CLI tests; stdout parses clean under `--json` |
| 3 | `030_management_api.md` | `GET /api/client-config` | route test; payload identical to CLI `--json` |
| 4 | `040_gui_panel.md` | GUI panel with copy + download | GUI test + rendered check |

The order is the build order, not a schedule: `020`, `030`, `040` each import the
core, and `040` renders what `030` returns. Nothing later can be built first.

## Research documents

| Doc | Contents |
|-----|----------|
| `001_client_config_survey.md` | Pi + OpenCode V1/V2 schemas, injection points, absence of a standard, V1 decision |
| `002_existing_surface_inventory.md` | What `ocx opencode` already does, the corrected gap, catalog metadata availability |
| `003_export_ux_design.md` | Design Read, dials, Lazy-User Gate, five UX states, download rules, placement |

## Open assumptions

1. **Pi schema is unverified against a real install.** Taken from published docs
   only (`001` §2). The cycle that ships Pi must diff against a real
   `~/.pi/agent/models.json` or ship the Pi client marked experimental.
2. **The API page layout rework may or may not have landed** when `040` runs.
   `003` §6 gives both placements; the panel is layout-independent.
3. **32k output budget** is a schema stand-in inherited from `ocx opencode`, not a
   per-model truth. If an authoritative max-output field ever reaches
   `CatalogModel`, both serializers should switch to it.

## Acceptance

The unit is DONE when all four phases have closed with their evidence, `bun run
typecheck` and `bun run test` are green, `bun run privacy:scan` is green, and a
config exported from each of the four surfaces is byte-identical for the same
client and catalog state.

Terminal outcomes other than DONE: `BLOCKED` if Pi's real schema contradicts the
survey badly enough to need a new design; `NEEDS_HUMAN` if a decision outside this
plan's boundary appears.

## Status

Roadmap written 2026-07-31 during the docs-only cycle. No implementation has
started; no production file has been modified by this unit.
