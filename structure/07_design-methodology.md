# 07 — Design Methodology for New Surfaces

When adding or redesigning a GUI page, CLI wizard, or user-facing flow in opencodex,
follow the PABCD Catalog Discovery stage ordering (CATALOG-DESIGN-FIRST-01):

1. **Design/UX decisions first** (Product-Personality-Selection): mood, density, lightness,
   shape, typography, motion. Decide visual direction before functional layout.
2. **Domain-specific config semantics** second: what entities does this surface manage
   (providers, models, accounts, sidecars)?
3. **Backend wiring derived last**: API endpoints, data structures, and state management
   are consequences of the above, not independent decisions.

This is a design-first rule for contributors, not a runtime feature: opencodex is infrastructure
plumbing, not a product-creation tool, so surface coherence is enforced by review rather than by an
interview engine. The rule stands on its own; it does not depend on an external document.

## Existing surfaces and their design direction

The surfaces below are examples chosen to show the design direction, not an inventory; the current
surface list lives in `gui/src/app-routing.ts` and
[`05_gui-and-management-api.md`](05_gui-and-management-api.md).

| Surface | Current design | Notes |
|---|---|---|
| Dashboard | Data-dense, light, rounded, sans-serif | Default Bun/React template aesthetic |
| `ocx init` CLI | Flat numbered menu, no personality | Could benefit from staged approach |
| Add Provider modal | Functional form | Minimal styling |
| Logs page | Dense table, monospace | Appropriate for log viewing |

When next touching these surfaces, apply the Stage 1 design dials (mood, lightness,
density, shape, typography, motion) before restructuring functional layout. For new
surfaces, run through all 3 stages in order.

## Reference

- Design methodology: Product-Personality-Selection (dev-uiux-design §1)
- 6 design dials: mood, lightness, density, shape, typography, motion
- 7 axes total: design → domain → feature/data/security/ops/cost (derived)
