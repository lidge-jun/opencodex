# 20 — Global Context-Cap Value + Set-All Toggle

This work-phase extends the shipped provider context-cap feature (see
`00_design.md` and `10_implementation.md`) with two follow-ups requested by the
user:

1. The cap value is no longer hardwired to `350k`. The user can pick a global
   cap value from a dropdown (`100k`-`950k` in `50k` steps, plus a `Custom`
   numeric input), shown as a single clickable line between the `Models` page
   header and the first provider block.
2. A `Set all` control next to that line toggles the cap on/off for every
   provider group at once, using the current global cap value.

The cap stays a single shared global value across all providers. It is not
per-provider.

## Part 1 - Easy explanation

Today every provider header has a `Cap 350k` switch, but `350k` is fixed in
code (`DEFAULT_PROVIDER_CONTEXT_CAP`). Turning a provider switch on always
writes `350000`.

This change makes the cap value a setting the user controls. A new one-line
row at the top of the Models page reads the current global cap (default
`350k`) and lets the user change it via a dropdown. Picking a new value updates
the global cap, and any provider that already had the cap enabled is re-pointed
at the new value so its switch stays visually "on". A `Set all` action turns
every provider's cap on (at the current value) or off in one click.

The cap still only lowers known model context windows. A provider with no model
above the chosen value is still a safe no-op.

## Current repository shape (already shipped)

- `src/provider-context-cap.ts`: `DEFAULT_PROVIDER_CONTEXT_CAP = 350_000`,
  `providerContextCap`, `providerContextCaps`, `applyProviderContextCap`,
  `setProviderContextCap(config, provider, enabled)` - enable always writes the
  fixed `350_000`.
- `src/types.ts`: `providerContextCaps?: Record<string, number>`.
- `src/config.ts`: `providerContextCaps: z.record(z.string(),
  z.number().int().positive()).optional()`.
- `src/server.ts`:
  - `GET /api/provider-context-caps` -> `{ cap: 350000, caps }`.
  - `PUT /api/provider-context-caps` -> body `{ provider, enabled }`.
- `src/codex-catalog.ts`: `applyProviderContextCap` lowers context windows
  across configured / live / cache / jawcode paths.
- `gui/src/pages/Models.tsx`: holds `contextCapValue` (from API `cap`, default
  `350_000`) and `contextCaps`; per-provider switch is on when
  `contextCaps[provider] === contextCapValue`.
- `gui/src/i18n/{en,ko,zh}.ts`: `models.cap350k`, `models.capApplied`,
  `models.capSaveFailed`, `models.contextCapped`.
- `gui/src/styles.css`: reusable `.select-sm` dropdown style (used in
  `Dashboard.tsx`).

Dirty files observed before this work-phase (do NOT touch, stage, revert, or
use as completion evidence):

- `src/adapters/kiro.ts`
- `tests/kiro-stream.test.ts`

(Confirm with `git status` at the start of the implementation phase; treat any
additional unrelated dirty files the same way.)

## Decision

### D1 - Store the global cap value in root config

Add a single root field:

```ts
contextCapValue?: number; // default DEFAULT_PROVIDER_CONTEXT_CAP (350_000)
```

Reasoning:

- The cap is global, so one value belongs at config root, not per provider.
- `providerContextCaps[provider]` keeps storing the resolved numeric cap, so the
  catalog/application path and existing tests are unchanged.
- `DEFAULT_PROVIDER_CONTEXT_CAP` stays as the fallback default when
  `contextCapValue` is unset, preserving current behavior for existing configs.

### D2 - Keep enabled providers in sync with the global value

When the global value changes, every provider currently present in
`providerContextCaps` is rewritten to the new value. Otherwise
`contextCaps[provider] === contextCapValue` would become false and every
provider switch would render "off" even though a cap is still stored.

### D3 - Dropdown options

Options are generated `100_000 ... 950_000` in `50_000` steps, rendered as
`100k`, `150k`, ... `950k`, plus a trailing `Custom...` entry. Selecting
`Custom...` reveals a numeric input (positive integer, interpreted as raw
tokens) and an apply action. The currently active value is always selectable
even if it is not on the `50k` grid (e.g. an existing `350k` default, or a prior
custom value).

### D4 - Set-all semantics

`Set all on` writes the current global value for every provider in the catalog;
`Set all off` clears `providerContextCaps` entirely. This reuses the same value
contract as the per-provider switch.

## Behavior contract

- `GET /api/provider-context-caps` returns `{ cap, value, caps }` where:
  - `cap` stays = `DEFAULT_PROVIDER_CONTEXT_CAP` (kept for backward compat /
    fallback display).
  - `value` = effective global cap (`config.contextCapValue ?? cap`).
  - `caps` = `providerContextCaps` map.
- `PUT /api/provider-context-caps` accepts one of:
  - `{ provider: string, enabled: boolean }` (existing per-provider toggle;
    enable writes the current global `value`, not the hardcoded constant).
  - `{ value: number }` (set the global cap value; re-point all currently
    enabled providers to the new value).
  - `{ setAll: boolean }` (enable cap for all known providers at the current
    value, or clear all).
  - Bodies are validated; invalid `value` (non-finite, <= 0) is rejected with
    `400`. `value` is coerced to a positive integer.
- Each mutating PUT saves config, clears affected provider model caches, and
  refreshes the Codex catalog best-effort (same as today).
- The Models page shows, between the page header and the first provider card,
  one line: a label, the cap-value dropdown (`100k`-`950k` + `Custom...`), and a
  `Set all on` / `Set all off` control.
- Per-provider switch label and the capped-row marker show the active value
  (`Cap 500k`, `500k cap`) instead of the literal `350k`.

## PABCD work-phase map

### Work-phase 2 - Global cap value + set-all (this file)

Files:

- MODIFY `src/types.ts`
- MODIFY `src/config.ts`
- MODIFY `src/provider-context-cap.ts`
- MODIFY `src/server.ts`
- MODIFY `gui/src/pages/Models.tsx`
- MODIFY `gui/src/i18n/en.ts`
- MODIFY `gui/src/i18n/ko.ts`
- MODIFY `gui/src/i18n/zh.ts`
- MODIFY `gui/src/styles.css` (only if the top row needs layout that
  `.select-sm` + existing row classes do not cover)
- MODIFY `tests/config.test.ts`
- MODIFY `tests/server-auth.test.ts`
- MODIFY `tests/codex-catalog.test.ts` (only if value plumbing needs new
  coverage; existing 350k cases must keep passing)
- MODIFY this file's Build record

Checks:

- `bun test tests/config.test.ts tests/codex-catalog.test.ts tests/server-auth.test.ts`
- `bun x tsc --noEmit`
- `cd gui && bun run build`
- Independent read-only implementation audit.

Do not modify:

- `src/adapters/kiro.ts`
- `tests/kiro-stream.test.ts`

## Diff-level implementation plan

### MODIFY `src/types.ts`

Add next to `providerContextCaps`:

```ts
  /** Global Codex-visible context cap value (tokens). Falls back to DEFAULT_PROVIDER_CONTEXT_CAP. */
  contextCapValue?: number;
```

### MODIFY `src/config.ts`

Extend schema:

```ts
  contextCapValue: z.number().int().positive().optional(),
```

### MODIFY `src/provider-context-cap.ts`

Add helpers; keep existing exports working.

```ts
export function globalContextCapValue(config: Pick<OcxConfig, "contextCapValue">): number {
  const v = config.contextCapValue;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : DEFAULT_PROVIDER_CONTEXT_CAP;
}

// enable now writes the active global value rather than the constant.
export function setProviderContextCap(config: OcxConfig, provider: string, enabled: boolean): void {
  const next = providerContextCaps(config);
  if (enabled) next[provider] = globalContextCapValue(config);
  else delete next[provider];
  if (Object.keys(next).length > 0) config.providerContextCaps = next;
  else delete config.providerContextCaps;
}

// set the global value and re-point every already-enabled provider to it.
export function setGlobalContextCapValue(config: OcxConfig, value: number): void {
  const v = Math.floor(value);
  config.contextCapValue = v;
  const caps = providerContextCaps(config);
  for (const provider of Object.keys(caps)) caps[provider] = v;
  if (Object.keys(caps).length > 0) config.providerContextCaps = caps;
}

// enable/clear cap for every provider in `providerNames` at the current value.
export function setAllProviderContextCaps(config: OcxConfig, providerNames: string[], enabled: boolean): void {
  if (!enabled) { delete config.providerContextCaps; return; }
  const value = globalContextCapValue(config);
  const next: Record<string, number> = {};
  for (const name of providerNames) next[name] = value;
  config.providerContextCaps = next;
}
```

### MODIFY `src/server.ts`

`GET /api/provider-context-caps`:

```ts
return jsonResponse({
  cap: DEFAULT_PROVIDER_CONTEXT_CAP,
  value: globalContextCapValue(config),
  caps: providerContextCaps(config),
});
```

`PUT /api/provider-context-caps` - branch on the body shape:

```ts
const body = await req.json();
// 1) global value change
if (typeof body.value === "number") {
  if (!Number.isFinite(body.value) || body.value <= 0) return 400;
  setGlobalContextCapValue(config, body.value);
  // clear cache for every provider that has a cap, refresh catalog
}
// 2) set all
else if (typeof body.setAll === "boolean") {
  const names = Object.keys(config.providers);
  setAllProviderContextCaps(config, names, body.setAll);
  // clear all provider caches, refresh catalog
}
// 3) existing per-provider toggle
else { /* current { provider, enabled } path, now writing the global value */ }
```

After any branch: `saveConfig(config)`, clear affected model caches,
`refreshCodexCatalogBestEffort()`, return `{ ok: true, cap, value, caps }`.

Provider-name validation still applies to the per-provider branch.

### MODIFY `gui/src/pages/Models.tsx`

- Extend `ProviderContextCapsResponse` with `value?: number`; seed
  `contextCapValue` from `value` (fallback to `cap`, then `350_000`).
- Add `setGlobalCap(value: number)` -> `PUT { value }` and
  `setAll(enabled: boolean)` -> `PUT { setAll: enabled }`, both reusing the
  existing busy/notice/reload pattern from `toggleProviderCap`.
- Render one top row between `<p className="page-sub">` / status and the first
  provider card:
  - label (`t("models.contextCapLabel")`),
  - `<select className="select-sm">` with `100k...950k` + `Custom...`; on
    `Custom...` show a numeric `<input className="input">` + apply button,
  - `Set all on` / `Set all off` buttons (`btn btn-ghost btn-sm`), disabled
    while `busy`.
- Replace literal `cap350k` label usage with a value-aware string:
  `t("models.capValue", { value: fmtK(contextCapValue) })`, and the row marker
  with `t("models.contextCappedValue", { value: fmtK(m.contextCap) })`.
- Add a small `fmtK(n)` helper (`350000 -> "350k"`; non-grid customs render
  their own `k` value or raw token count when not cleanly divisible).

### MODIFY i18n (`en`, `ko`, `zh`)

Add:

- `models.contextCapLabel` - e.g. `"Context cap"` / `"컨텍스트 제한"` /
  `"上下文限制"`.
- `models.capValue` - `"Cap {value}"` / `"{value} 제한"` / `"限制 {value}"`.
- `models.contextCappedValue` - `"{value} cap"` / `"{value} 제한"` /
  `"{value} 限制"`.
- `models.setAllOn`, `models.setAllOff`.
- `models.custom` - `"Custom..."` / `"직접 입력..."` / `"自定义..."`.
- `models.capValueApplied` - reuse or mirror `models.capApplied`.

Keep the old `models.cap350k` / `models.contextCapped` keys until all references
are migrated, then remove if unused (verify with `rg`).

### MODIFY tests

`tests/config.test.ts`:

- `contextCapValue` accepts a valid positive integer and round-trips.
- invalid `contextCapValue` (0 / negative / non-int) is rejected with a
  diagnostic mentioning `contextCapValue`.

`tests/server-auth.test.ts`:

- `GET` returns `{ cap, value, caps }`; `value` defaults to `350000`.
- `PUT { value: 500000 }` persists `contextCapValue` and re-points existing
  enabled providers to `500000`.
- `PUT { provider, enabled: true }` after a value change writes the current
  global value (not `350000`).
- `PUT { setAll: true }` caps every provider at the current value;
  `PUT { setAll: false }` clears `providerContextCaps`.
- invalid `{ value }` is rejected with `400`.

`tests/codex-catalog.test.ts`:

- existing `350_000` cases stay green;
- add one case proving a non-350k global value (e.g. `500_000`) lowers a wide
  model to `500_000` and leaves a smaller model unchanged.

## Verification and commit plan

Implementation commit:

```text
feat(models): global context cap value + set-all toggle
```

Final verification:

```bash
bun test tests/config.test.ts tests/codex-catalog.test.ts tests/server-auth.test.ts
bun x tsc --noEmit
cd gui && bun run build
```

Independent read-only verification must confirm:

- global value persists and survives reload;
- enabling a provider after a value change uses the new value;
- `Set all on/off` updates every provider and clears cleanly;
- invalid value input is rejected at the API and not written to config;
- the cap still only lowers known context windows (no invented values);
- per-provider switches stay visually consistent after a value change;
- dirty Kiro files remain untouched.

## Build record

Implemented as designed, with one UI refinement: the user asked for a single
`Set all` toggle (one switch) rather than separate on/off buttons.

Changed files:

- MODIFY `src/types.ts`: added root `contextCapValue?: number`.
- MODIFY `src/config.ts`: schema `contextCapValue: z.number().int().positive().optional()`.
- MODIFY `src/provider-context-cap.ts`: added `globalContextCapValue`,
  `setGlobalContextCapValue` (re-points enabled providers), and
  `setAllProviderContextCaps`; `setProviderContextCap` enable now writes the
  active global value instead of the constant.
- MODIFY `src/server.ts`: `GET` returns `{ cap, value, caps }`; `PUT` branches on
  body shape — `{ value }` (global value), `{ setAll }` (all providers), and the
  existing `{ provider, enabled }`. Invalid `value` / `setAll` return `400`.
- MODIFY `gui/src/pages/Models.tsx`: top control row with cap-value `<select>`
  (`100k`-`950k` + `Custom…` numeric input) and one `Set all` switch; per-provider
  switch label + capped-row marker now show the active value via `fmtK`.
- MODIFY `gui/src/i18n/{en,ko,zh}.ts`: added `contextCapLabel`, `capValue`,
  `contextCappedValue`, `setAll`, `custom`, `customApply`, `customPlaceholder`.
  Old `cap350k` / `contextCapped` keys left in place (no longer referenced).
- MODIFY `tests/config.test.ts`: `contextCapValue` accept/reject coverage.
- MODIFY `tests/server-auth.test.ts`: global-value re-point, post-change provider
  enable uses new value, set-all on/off, invalid value rejection.

Files intentionally not touched (dirty before this work-phase, unrelated cursor
adapter edits):

- `src/adapters/cursor/live-transport.ts`
- `src/adapters/cursor/protobuf-events.ts`
- `tests/cursor-protobuf-events.test.ts`

Verification:

- `bun test tests/config.test.ts tests/codex-catalog.test.ts tests/server-auth.test.ts`
  -> 101 pass, 0 fail, 423 expect calls.
- `bun x tsc --noEmit` -> exit 0, no diagnostics.
- `cd gui && bun run build` -> tsc project build + Vite production build succeeded.

Commits:

- `feat(models): global context cap value + set-all backend`
- `feat(models): cap value dropdown + single set-all toggle UI`
- `test(models): cover global cap value and set-all toggles`
