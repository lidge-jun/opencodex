# Usage apps and request log chips

## Objective and scope

Show all apps and all devices by default in the usage report; offer a classified app breakdown after model and provider; replace the log surface tabs with a classified app chip at the start of each request row. Use only the existing bounded client attribution. Preserve the route conversion badge, source/device authorization and explicit selections. No auth, credential, workflow, dependency, or CI policy changes are planned. Resource bounds: none stated; host limits apply.

## Current evidence

- `gui/src/pages/Usage.tsx` initializes the client to `codex` in component state and the device to `all`. No source preference storage was found in the usage component or picker. An existing session's explicit choice is held in state; there is no persisted default to migrate in this revision.
- `src/usage/client.ts` defines a closed set of client labels and normalizes invalid values. `src/usage/summary.ts` already applies source and device filtering before accumulation; its retained state is bounded and supports cloning, ranges, and projections.
- `gui/src/components/v2-usage/usage-breakdown.tsx` renders separate model and provider tables; an app breakdown needs server data at the same filtered scope, not a reconstruction from these totals.
- Baseline verifiers: `bun test tests/usage/usage-client-attribution.test.ts` (exit 0, 14 pass; directly imports aggregation); in `gui`, `bun test tests/usage-source-picker.test.tsx` (exit 0, 89 pass; mounts Usage and picker).

## Planned change and acceptance

1. Extend the summary accumulation with app aggregates based only on normalized client labels. Preserve date/range, device, model/provider filters, exact/row-unique accounting, clones, cache memory accounting and relay projections. Missing legacy attribution is unclassified, distinct from a valid `other` label. Add failing-first tests for mixed clients, missing/invalid clients, filtering, range and clones.
2. Default the report to `all`/`all`, retain live choice, render App as third breakdown after model and provider only for all apps, including localized unknown/unclassified labels. Cover defaults, selection and display with mounted GUI tests.
3. Remove request log app tabs and render a compact classified client chip first on each row, retain filtering controls and conversion badge. Test several clients, invalid/legacy data and row layout.
4. Synchronize applicable structure and all documented public locales; run focused tests, GUI tests/lint/build, typecheck, file-size and layout guards, Lab boundary, privacy and structure gates, and full suite where feasible. Validate browser against a synthetic isolated proxy with temporary homes; obtain before/after screenshots on pr-assets. Review diff independently and satisfy the owner's exact-head CI/review requirements before authorized merge.

Consultation and source trace completed; design decisions and verification cases follow. No production changes in planning.

## Architecture decisions (consultation)

- APP-01/02 accepted: after source/window and combo projection, partition the app totals by a closed app roster; fold Codex variants into Codex while distinguishing missing legacy attribution and present unknown. Count logical rows once, preserving selected provider/model scope.
- APP-03 accepted: include app counters in accumulator clone and retained-memory accounting and replace them in `projectUsageSummary`; do not use 30-day source facets as the report data.
- APP-04 accepted: additive management field, bounded validation on GUI and explicit safe projection through `src/remote/hub-usage.ts`; test link/hub scope and older responses. Human CLI formatting is outside the requested GUI scope.
- APP-05 accepted: no prior persisted source preference exists in this revision. Change the initial component-state choice to all without inventing persistence; preserve an explicitly selected app during the mounted session and retain device restrictions.
- Log decision: remove surface radios and their hidden predicate in `gui/src/pages/logs-filter-bar.tsx` and `logs-filter.ts`; in `Logs.tsx` add a leading chip from a validated classified enum, with neutral unknown for absent or invalid values. Retain `ProtocolBadge` and the filter disclosure. Update their focused tests and translated `guides/web-dashboard.md` pages.
- The app breakdown presents request counts, token totals and cost using the same aggregate semantics as adjacent breakdowns. A third section follows models and providers; legacy and explicitly unknown labels remain distinct. The all-apps choice controls its visibility.

## Consultation reflection and test matrix

Architect reflected ALIGNED on APP-01–05. Accepted the verification and remote compatibility refinements. The user explicitly requires every legacy row without a client to display Unclassified, including rows with an existing surface; therefore this breakdown does not use the narrower `isLegacyCodexUsage` definition. Present invalid client values map to unknown. Tests must trigger custom-window endpoints, local-day/DST ranges, combo provider/model projections, both accumulation modes, clone independence and retained-byte growth. The hub field is optional for old responses, validated against a closed roster and bounded, and tests assert authenticated-key-only data and absence of key IDs.

Field chain: `src/usage/summary.ts` creates app aggregates and serializes them in `UsageSummary`; management routes return them, `src/remote/hub-usage.ts` validates/projects the optional field, and `gui/src/components/v2-usage/usage-model.ts` and report response validation consume it before `usage-breakdown.tsx` renders it. Snapshot projection must replace aggregate data. No new enforcement mechanism is planned.

## Audit disposition

Independent audit: GO-WITH-FIXES (blockers=0). Accepted both medium findings: reset focuses the persistent conversation search after the radio controls are removed and keyboard/pointer tests verify it; echo rejection uses otherwise valid reports and changes only the source echo, with a non-all client for a mismatch. Added scenarios: nonempty report shows model → provider → app and hides app when a particular client is selected; a projected two-provider combo contributes one request and only retained token/cost; warm all/all and key caches, append another client, and compare with a fresh rebuild; hub tests cover omitted older fields, invalid/excessive labels, nested private fields, authenticated-key scope, and no key identity.

## Owner correction

The Logs chip uses only an SVG app mark, with no visible app name. Missing, invalid and other clients use a neutral question-mark SVG; the classified name remains available to assistive technology. The column stays narrow and the existing protocol badge remains legible.
