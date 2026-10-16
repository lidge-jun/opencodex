# 000 — Add-provider catalog: unified search, note clamp, Local tab

Three in-app comments on the add-provider modal (2026-09-12), delivered as one docs-
first unit and a manual stacked PR chain onto `dev`.

| doc | scope |
|---|---|
| `010_context.md` | the surface as it is, the three requirements, the standing constraints |
| `015_codesign_grok.md` | co-design with `xai/grok-4.6`; accepted and rejected decisions |
| `016_audit_corrections.md` | independent NEAR-PASS audit; **overrides the docs below where they disagree** |
| `020_r3_local_tab.md` | wp2 — a dedicated Local tab |
| `030_r2_note_clamp.md` | wp3 — two-line clamp plus a detail popup |
| `040_r1_unified_search.md` | wp4 — unified search above the tabs |
| `050_delivery.md` | wp5 — the stacked PR chain |
| `evidence/grok-4.6-codesign.md` | the co-design report verbatim |

## Work phases

- **wp1** roadmap (this unit) — closed.
- **wp2** R3 Local tab. First, because every later phase needs the tier set: R1's chip
  counts and group order, and R2's row renderer, both sit on top of it.
- **wp3** R2 note clamp and popup. Second, because it restructures the preset row that
  R1 then has to render in groups.
- **wp4** R1 unified search, plus the `structure/` and `docs-site/` updates the whole
  unit owes once the final shape of the surface is known.
- **wp5** stack finalization and remote-CI evidence.

## Standing rules

No local test suite (`bun run test`, `bun test`, `bun run test:changed`). A GUI build
or `vite dev` **is** allowed — the user drew the line at the suite — which is what makes
the mandatory `gui` screenshot on each PR possible. Every push is `--no-verify`.
Remote CI on each PR's final head is the only test evidence.
