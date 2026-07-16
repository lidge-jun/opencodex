# Usage surface filter

Date: 2026-07-16  
Class: C3 — small but persistent frontend/backend contract change  
Loop archetype: spec-satisfaction repair

## Goal

Add a real `All / Codex / Claude` filter to the Usage page. The selected surface must consistently control summary cards, active-day charts, model rows, and provider rows. The control stays compact beside the existing range filter; Codex and Claude labels collapse to their SVG marks at narrow widths.

## Trigger

The Usage page currently filters only by time range. Users who run both Codex and Claude through opencodex cannot separate their traffic.

## Non-goals

- Do not infer the client surface from provider or model names.
- Do not migrate or rewrite existing `usage.jsonl` files.
- Do not add a dependency, global store, new endpoint, or new icon asset.
- Do not alter provider/model aggregation rules, token arithmetic, or the Logs page.
- Do not push or release from this unit.

## Existing contract and baseline

- `RequestLogContext` and `RequestLogEntry` already use `surface?: "claude"`; absence means the Codex surface.
- `addRequestLog` currently drops that field when it writes `usage.jsonl`.
- `/api/usage` currently accepts only `range` and aggregates every persisted row.
- The GUI already ships `/provider-icons/openai.svg` and `/provider-icons/claude.svg`.
- Baseline command: `bun test --isolate tests/request-log.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts tests/api-usage.test.ts`
- Baseline result: 47 pass, 0 fail on 2026-07-16.

## Design read

```yaml
name: opencodex-usage-surface-filter
colors:
  primary: existing semantic tokens
  accent: existing active segmented-control fill
  background: existing surface token
typography:
  heading: existing title token
  body: existing control token
iconography:
  system: existing inline SVG family
  weight: regular
  domain: existing provider brand SVG assets
```

Reading this as a Korean-first repeated-work dashboard with quiet, dense controls. Keep the current visual grammar: two adjacent pill groups, no new color, no motion beyond existing button feedback.

- DESIGN_VARIANCE: 3
- MOTION_INTENSITY: 1
- Product density: D5

## Work-phase map

This unit is one implementation work-phase and one PABCD cycle:

1. `010_usage_surface_filter.md` — persist the existing surface marker, filter the usage summary contract, wire the responsive segmented control, add regressions, verify the rendered states.

## Scope manifest

### New

- `devlog/_plan/260716_usage_surface_filter/000_plan.md` — objective, scope, baseline, evidence ledger.
- `devlog/_plan/260716_usage_surface_filter/010_usage_surface_filter.md` — diff-level implementation contract.

### Modify

- `src/server/request-log.ts`
- `src/usage/log.ts`
- `src/usage/summary.ts`
- `src/server/management-api.ts`
- `tests/usage-log.test.ts`
- `tests/usage-summary.test.ts`
- `tests/api-usage.test.ts`
- `tests/claude-messages-endpoint.test.ts`
- `tests/claude-native-passthrough.test.ts`
- `tests/server-auth.test.ts`
- `gui/src/pages/Usage.tsx`
- `gui/src/styles.css`
- `docs/design-system/components.md`

## Verifier

The verifier measures both the data boundary and rendered behavior:

1. Focused unit/API regressions prove persistence, legacy fallback, query parsing, and whole-summary filtering.
2. Existing Claude routed/native and Codex Responses integration tests prove the ingress marker survives real request finalization and persistence.
3. Root TypeScript check and GUI build prove contract and frontend integration.
4. Browser QA at desktop, split-screen, mobile, and narrow widths proves both segmented controls fit, icon collapse activates, every surface selection changes the displayed usage dataset, and keyboard/focus semantics remain available.

## Stop condition

DONE requires all focused tests, typecheck, GUI build, and one clean browser observation after exercising All, Codex, and Claude. Stop as BLOCKED if the running proxy cannot be safely restarted or the browser cannot reach the locally served build after three distinct recovery attempts. Return NEEDS_HUMAN only if real product intent conflicts with the legacy-surface fallback.

## Escalation and delegation

- Downward: bounded backend/tests and frontend/UI slices may be delegated only with disjoint write scopes and explicit `cxc-dev-*` skill routing.
- Upward: after two distinct workers fail the same packet, the main agent reclaims that slice and records the failure before editing.
- Any new storage migration, inferred classification, or endpoint expansion is outside scope and requires a P-phase amendment.

## Memory artifact

This folder is the continuity record. C-phase command output and screenshot paths are appended here; D records the terminal outcome and moves the unit to `devlog/_fin/` only after all criteria pass.

## Known historical limitation

Old `usage.jsonl` rows did not persist the request surface. Provider/model values cannot recover it because Claude traffic may route through any provider. Missing markers therefore keep the product's existing convention and count as Codex. `All` remains historically exact; Codex/Claude views become exact for rows written after this change.

## Reuse decisions

- Reuse the existing `surface?: "claude"` marker and the existing four-locale `logs.filter.surface.*` copy.
- Reuse the shipped OpenAI and Claude brand SVG files. Do not call `providerIconSrc`: the control represents client surfaces rather than upstream providers, so a small local surface-to-asset map is clearer than coupling the filter to provider aliases.

## Expected terminal outcomes

- `DONE`: verified surface filter shipped locally and recorded.
- `NOOP`: impossible because the capability is absent at baseline.
- `BLOCKED`: local runtime/browser dependency unavailable after bounded recovery.
- `UNSAFE`: an implementation would require destructive history migration.
- `NEEDS_HUMAN`: legacy-row semantics cannot be resolved from existing product behavior.

## Audit record

- Round 1: `GO-WITH-FIXES (blockers=4)` — explicit accessible names, selection semantics, 44px touch targets, and the historical attribution caveat were underspecified.
- Frontend responsive audit: `FAIL` — the initial radio semantics conflicted with the six-Tab-stop verifier, and moving the filter row alone did not prove 320px containment.
- Synthesis: accepted every blocker. The plan now uses `role="group"` + `aria-pressed`, translated per-button `aria-label`, `var(--control-touch)` at mobile, and complete group stacking at <=360px; it records legacy ambiguity and adds real Codex/routed Claude/native Claude persistence tests.
- Re-audit: `PASS` — no blockers. Non-blocking follow-up only: the untouched Logs page retains its older radiogroup pattern.

## Implementation record

- `57c1893 feat(usage): filter aggregates by client surface`
  - Persists the existing Claude surface marker in the usage allowlist.
  - Adds typed `all | codex | claude` parsing and filters once before totals, days, models, and providers.
  - Threads the normalized surface through normal and catch API responses.
  - Activates the contract through focused, routed Claude, native Claude, and Codex Responses tests.
- `49e77f3 feat(gui): add responsive usage surface filter`
  - Adds the source control before the range control and sends both query dimensions.
  - Uses translated button names, `aria-pressed`, existing OpenAI/Claude SVG marks, 44px mobile targets, and complete group stacking at 320px.
  - Documents the segmented-filter contract in the GUI design system.

## Check evidence

- Focused persistence/API: `bun test --isolate tests/request-log.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts tests/api-usage.test.ts` — 52 pass, 0 fail.
- Routed/native request activation: `bun test --isolate tests/claude-messages-endpoint.test.ts tests/claude-native-passthrough.test.ts tests/server-auth.test.ts` — 69 pass, 0 fail.
- Full regression: `bun test --isolate ./tests/` — 2556 pass, 0 fail across 238 files.
- Static/build: `bun run typecheck` and `cd gui && bun run build` — exit 0.
- Lint: `cd gui && bun run lint` — 0 errors; two pre-existing TanStack Virtual compiler warnings in untouched `Debug.tsx` and `Logs.tsx`.
- Patch integrity: `git diff --check` — exit 0; no assertions deleted, skipped, or weakened.
- Final independent diff review: `PASS`; no correctness blocker in marker propagation, fallback, aggregate consistency, fetch cancellation, accessibility, or 320px containment.

## Render evidence

- Desktop: `.codexclaw/evidence/usage-surface-filter/usage-1280.png` — both groups show text and marks without overlap.
- Split-screen/tablet: `usage-css-1024.png` and `usage-css-768.png` — page `scrollWidth` equals viewport width; at 768px both pill groups remain beside the title.
- Mobile: `usage-css-390.png` — `All + Codex SVG + Claude SVG`, two groups on one line, 44px button height, no page overflow.
- Narrow: `usage-css-320.png` — groups stack at 274px each inside the 320px viewport, every button is 44px high, no page overflow.
- Interaction: Codex and Claude clicks swap `aria-pressed` correctly; keyboard focus matches `:focus-visible`; browser console warnings/errors: none.
- Teardown: temporary Vite proxy QA server on port 5173 stopped after browser finalization.

## D closeout

Terminal outcome: `DONE`.

- All acceptance criteria in `010_usage_surface_filter.md` are met.
- No production dependency, icon asset, migration, inference rule, or release action was added.
- No push was performed.
- What did not improve: historical Claude rows remain indistinguishable because the old JSONL format discarded the surface marker. `All` is exact for history; source-specific attribution is exact for new rows only.
- Evidence that would invalidate this direction: a real request finalized outside `addFinalRequestLog`, a provider/model combination that is incorrectly used as source evidence, or browser proof of either segmented group clipping below 320px. None appeared in the audited call graph or verification matrix.
