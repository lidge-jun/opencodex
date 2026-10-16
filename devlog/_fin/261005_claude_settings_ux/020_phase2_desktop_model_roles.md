# 020 Phase 2 - Claude Desktop model roles (design D1)

## Problem

`gui/src/pages/ClaudeDesktop.tsx` shows the four family lanes as the main body. The
backend writes every model with an `anthropicFamilyTier`, and
`renderDesktopProfile` (src/claude/desktop-profile.ts) orders the effective family
defaults first (opus, fable, sonnet, haiku). The opus default is therefore the first
model Desktop lists, and the haiku default is the model Desktop treats as its Haiku-class
model. Users need those two choices, not the tier taxonomy.

## Change

### NEW gui/src/pages/claude-desktop-roles.ts

Pure, unit-tested helpers over the existing profile shape:

```ts
export function assignFamily(profile, route, family, makeDefault): DesktopProfile
// same rules as today's moveModel: reassign the old family's default to the first
// remaining member (sorted) when the moved route was it; set the target default when
// it is null or when makeDefault is true.
export function effectiveFamilyDefaults(models, profile): Record<Family, string | null>
// stored default if it is an available member, else first available member sorted.
export function roleOptions(models, profile, exclude): string[]
// available routes, sorted by label, minus the excluded route.
```

`moveModel` in ClaudeDesktop calls `assignFamily(..., false)`; the Models card calls
`assignFamily(..., true)` with `opus` (Default model) or `haiku` (Quick task model).

### MODIFY gui/src/pages/ClaudeDesktop.tsx

After the status bar and first-party sections, before the lanes:

1. `<section className="card claude-desktop-roles">` with two `.setting-row`s using
   `Select` from `../ui` (portal, align right):
   - Default model: value `effectiveDefaults.opus ?? ""`; options = available routes minus
     the current quick-task route; onChange -> `assignFamily(profile, route, "opus", true)`.
   - Quick task model: value `effectiveDefaults.haiku ?? ""`; options = available routes
     minus the default route, plus `{ value: "", label: t("claudeDesktop.roles.unset") }` only
     while the haiku family is empty; onChange (non-empty) -> `assignFamily(..., "haiku", true)`.
   A route can belong to one family only, so the two selects exclude each other's route.
2. `<section className="claude-desktop-list">` heading `claudeDesktop.roles.listTitle` with the
   count and `claudeDesktop.roles.listHint`; Import/Export JSON buttons move here from the
   toolbar. Rows (`.claude-desktop-list-row`, not `article.claude-model-card`): label,
   route, context chip, 1M chip, `claudeDesktop.defaultBadge` / `claudeDesktop.roles.quickBadge`,
   availability badge. Ordered default, quick, then the rest by label; first
   `LANE_PAGE` rows, then `models.showMore`.
3. `<details className="claude-desktop-advanced">` (closed by default, open state kept in
   component state) whose `<summary>` shows `claudeDesktop.advanced.title` plus one chip per
   family: family name, its effective default or `claudeDesktop.advanced.empty`, and
   `claudeDesktop.chooseDefault` when a non-empty family has no stored default. The existing
   `ocx-group-stack` lanes render inside, unchanged, so drag/move/default/search keep working
   and existing lane tests still find their DOM.

### CSS

ADD to the Claude Desktop stylesheet section (`gui/src/styles/claude-page.css` or the file
that owns `.claude-desktop-toolbar`): `.claude-desktop-roles`, `.claude-desktop-list`,
`.claude-desktop-list-row`, `.claude-desktop-advanced > summary`, family chips. Tokens only.

### i18n (all 12 locales)

`claudeDesktop.roles.title` "Models", `.default` "Default model", `.defaultDesc`,
`.quick` "Quick task model", `.quickDesc`, `.unset` "Not set", `.pick` "Choose a model",
`.listTitle` "Desktop model list", `.listHint` "Filled automatically from your connected
providers.", `.quickBadge` "Quick tasks"; `claudeDesktop.advanced.title` "Advanced: Claude
tier assignment", `.desc`, `.empty` "empty".

### Tests

- NEW `gui/tests/claude-desktop-roles.test.ts`: assignFamily default reassignment,
  makeDefault, effective defaults with unavailable members, option exclusion.
- NEW mounted case (sibling file `gui/tests/claude-desktop-role-card.test.tsx`): picking a
  Default model updates the opus default and marks the profile unsaved; lanes are inside a
  closed `details.claude-desktop-advanced`.
- Register new test files in `scripts/test-layout` only if they live under root `tests/`
  (gui tests are outside that layout).

## Verification

`cd gui && bun test tests/claude-desktop-*.test.ts* && bun run lint:i18n && bun run build`,
then render `#claude/desktop` in the in-app browser.

## Amendments after architect consultation

- Labels stay as approved; descriptions: Default model "Listed first in Claude Desktop and
  sent as the Opus tier." Quick task model "Answers Claude Desktop's Haiku-tier requests."
  Row badges: `claudeDesktop.defaultBadge` and
  `claudeDesktop.roles.quickBadge`.
- `assignFamily(..., makeDefault=true)` sets the destination default even when the route is
  already in that family. Aliases and applied markers are preserved.
- Select value is the STORED default (`profile.defaults.opus` / `.haiku`), falling back to the
  effective default only when nothing is stored. A stored route that is unavailable is added
  as its own option labelled with `claudeDesktop.unavailable`, so it shows as selected; the
  Advanced summary shows the temporary-default warning and per-family counts.
- The compact list is a GUI overview (default, quick, then by label); its hint does not
  claim to be Desktop's own order.
- Role changes go through the same path as `moveModel`: they update `destinations` and
  announce through the polite live region.
- Locales: every locale registered in `gui/src/i18n/shared.ts` (currently 11).
- In first-party mode the card shows a one-line scope note
  (`claudeDesktop.roles.gatewayScope`) because the profile only applies to gateway mode.
