# Design Methodology For New Surfaces

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
[`gui-and-management-api.md`](gui-and-management-api.md).

| Surface | Current design | Notes |
|---|---|---|
| Dashboard | Data-dense, light, rounded, sans-serif | Default Bun/React template aesthetic |
| `ocx init` CLI | Flat numbered menu, no personality | Could benefit from staged approach |
| Add Provider modal | Functional form | Minimal styling |
| Logs page | Dense table, monospace | Appropriate for log viewing |
| Codex account pool | Existing dense account cards with scoped actions | Standalone title/feedback, pause/refresh next to cards; embedded actions inline. Retired Spark controls have no placeholder. |

When next touching these surfaces, apply the Stage 1 design dials (mood, lightness,
density, shape, typography, motion) before restructuring functional layout. For new
surfaces, run through all 3 stages in order.

## Reference

- Design methodology: Product-Personality-Selection (dev-uiux-design §1)
- 6 design dials: mood, lightness, density, shape, typography, motion
- 7 axes total: design → domain → feature/data/security/ops/cost (derived)

The Codex account card separates automatic plan-policy exclusion from credential health and suppresses an unavailable next-session action; see the [account selection contract](providers/openai-tiers.md#automatic-pool-plan-exclusions).

Remote Workspace uses a separate, explicitly enabled server surface with structural WebSocket callbacks and awaited per-server cleanup; [its contract](remote-workspace.md) owns that integration.

Usage consumers preserve positive incomplete-history metadata as specified in [usage accounting](gui-and-management-api.md#usage-accounting); readable totals are not represented as a complete ledger.
The management quota DTO keeps Combo editing aligned with scoped inference evidence;
see [Combo editor routing quota](gui-and-management-api.md#combo-editor-routing-quota).

Codex pool settings and their consumers follow the [reset-first ordering contract](providers/openai-tiers.md#reset-first-account-ordering), including independent-quota fallback and preserved affinity.

The pairing panel names the hub, offers an origin-specific command to run on that hub, and separates one-time codes from data/admin credentials. Copy outcomes and request failures use existing notice/button patterns. Failed authentication never masquerades as a stopped connected process.
Cline uses the existing file-integration page, tabs, status badge and rollback dialogs. Its localized semantics identify both files and the required stop/restart boundary before users mutate them.

Account quota surfaces use [safe probe diagnostics](transports/inventory.md#account-quota-failure-diagnostics) separately from quota validity, credential health and routing authority.
