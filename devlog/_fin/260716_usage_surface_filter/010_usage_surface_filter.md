# Work-phase 010 — Usage surface filter

Status: completed — 2026-07-16

## Acceptance contract

1. `surface=all` returns the existing aggregate unchanged.
2. `surface=codex` includes rows whose persisted `surface` is absent; this preserves the existing request-log convention and legacy `usage.jsonl` behavior.
3. `surface=claude` includes only rows explicitly persisted with `surface: "claude"`.
4. Unknown or missing surface query values fall back to `all`.
5. Every Usage page section is driven by the same server-filtered response.
6. Desktop shows `All / Codex / Claude` text. Narrow layouts keep `All` and replace Codex/Claude visible labels with their existing SVG marks while preserving full accessible names.
7. The existing time-range selection stays independent and is sent with the surface query.
8. Both segmented controls use native buttons inside labelled `role="group"` containers. Every button remains a Tab stop and exposes selection with `aria-pressed`; no incomplete radio keyboard model is introduced.

## Activation scenarios

- Surface persistence branch: finalize a Claude request log and observe `surface: "claude"` in the appended/read-back usage row.
- Legacy fallback branch: summarize a row without `surface` under `codex` and observe that it remains included.
- Claude filter branch: summarize mixed rows under `claude` and observe that all totals, days, models, and providers exclude Codex rows.
- Invalid query branch: call `/api/usage?surface=unknown` and observe `surface: "all"` with the unfiltered total.
- Responsive branch: render at 390px and 320px; observe hidden Codex/Claude text, visible brand marks, no clipping, and accessible button names.

## Diff map

### MODIFY `src/usage/log.ts`

Before: `PersistedUsageEntry` has no surface marker and `normalizeUsageEntry` cannot retain one.

After:

- Add `surface?: "claude"` to `PersistedUsageEntry`.
- Copy only the known literal through `normalizeUsageEntry`.
- Keep the field optional so existing JSONL rows remain valid without migration.

### MODIFY `src/server/request-log.ts`

Before: `addRequestLog` persists request metadata but drops `RequestLogEntry.surface`.

After:

- Forward `entry.surface` into `appendUsageEntry` when present.
- Preserve the existing rule that Codex is represented by absence and Claude by the literal marker.

### MODIFY `src/usage/summary.ts`

Before: `summarizeUsage(entries, range, now)` filters only by time.

After:

- Add exported `UsageSurface = "all" | "codex" | "claude"`.
- Add `parseSurface(input)` with an `all` fallback.
- Add `surface` to `UsageSummary`.
- Extend `summarizeUsage(entries, range, now, surface = "all")`.
- Filter once before totals/day/model/provider builders: Claude rows require the explicit marker; Codex rows use `surface !== "claude"` so legacy rows remain compatible.
- Do not change downstream aggregation helpers.

### MODIFY `src/server/management-api.ts`

Before: `/api/usage` parses `range` only.

After:

- Parse the `surface` query at the HTTP boundary.
- Pass the typed value into `summarizeUsage`.
- Keep a 200 response and fallback behavior for unknown values, matching existing range handling.
- Include the normalized `surface` in both the normal response and the catch/error fallback.

### MODIFY `tests/usage-log.test.ts`

- Persist and read back a Claude row with `surface: "claude"`.
- Assert unspecified legacy rows remain unchanged and secret-safe normalization still strips unrelated runtime fields.

### MODIFY `tests/usage-summary.test.ts`

- Include `surface` in the fixture builder.
- Test `parseSurface` accepted values and fallback.
- Test mixed Codex/Claude entries under `all`, `codex`, and `claude`.
- Assert summary totals plus day/model/provider rows all follow the selected surface.

### MODIFY `tests/api-usage.test.ts`

- Mark one fixture row as Claude.
- Assert response includes the normalized `surface`.
- Exercise `surface=codex`, `surface=claude`, and an unknown value.

### MODIFY `tests/claude-messages-endpoint.test.ts`

- Extend the existing routed Claude end-to-end case to query `/api/usage?range=all&surface=claude` after consuming the response.
- Assert the persisted row appears in Claude and is absent from Codex.

### MODIFY `tests/claude-native-passthrough.test.ts`

- Extend the existing native Anthropic passthrough case with the same persisted surface assertions.

### MODIFY `tests/server-auth.test.ts`

- Extend the existing Codex `/v1/responses` usage integration to query `surface=codex`, assert the normalized response field, and prove the row stays out of the Claude aggregate.

### MODIFY `gui/src/pages/Usage.tsx`

Before: local state and fetch URL contain only `range`; the header renders one segmented control.

After:

- Add `UsageSurface` state defaulting to `all`.
- Include `surface` in `fetchUsage`, effect dependencies, and the response type.
- Add a labelled source button group before the labelled range button group.
- Reuse `logs.filter.surface.*` translations for All/Codex/Claude and its accessible group label.
- Render existing `/provider-icons/openai.svg` and `/provider-icons/claude.svg` as decorative marks beside visible labels.
- Mark each choice with `aria-pressed`; keep all six buttons in normal Tab order and avoid radio roles that would require roving focus and arrow-key selection.
- Set an explicit translated `aria-label` on every source and range button. Collapsed visible text may use `display: none` because the button name does not depend on that span.
- Keep the title and both filters in a wrapping header container; do not add a new component abstraction.

### MODIFY `gui/src/styles.css`

- Generalize the existing Usage segmented-control classes so the source and range groups share geometry and focus behavior.
- Add `.usage-filters` and source-button label/icon classes.
- At <=640px hide only Codex/Claude visible text and keep the icons; `All` stays text.
- At <=760px add `min-height: var(--control-touch)` so every button reaches the existing 44px touch token.
- At <=360px stack the two pill groups vertically, keeping each three-option group intact within the 284px content width.
- Preserve the existing global visible `:focus-visible` outline.

### MODIFY `docs/design-system/components.md`

- Document segmented filters as adjacent exclusive choices using native buttons plus `aria-pressed`, pill geometry, 44px mobile targets, accessible names for icon-only collapsed labels, and no data-loss collapse.

## Verification commands

```sh
bun test --isolate tests/request-log.test.ts tests/usage-log.test.ts tests/usage-summary.test.ts tests/api-usage.test.ts
bun test --isolate tests/claude-messages-endpoint.test.ts tests/claude-native-passthrough.test.ts tests/server-auth.test.ts
bun run typecheck
bun run build:gui
```

Browser matrix:

- Desktop 1280x900: both groups show text; All/Codex/Claude each refresh the entire dataset.
- Split-screen 768x900: controls stay in the header without overlap.
- Mobile 390x844: All text plus two provider marks; independent range group remains usable.
- Narrow 320x700: filter row wraps intentionally; no clipped title/button or horizontal page overflow.
- Keyboard: tab through six buttons; visible focus; active choices expose `aria-pressed=true`.

## Rollback

Revert this unit's commits. Existing JSONL rows with the additive `surface` field remain readable because the old reader already ignores extra fields; no file migration or cleanup is required.
