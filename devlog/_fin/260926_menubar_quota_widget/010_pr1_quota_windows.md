# 010 — PR1: show a quota window only when it reports data

## Behavior after

- A window row exists only when its percent is a finite number (zero included) or its reset time
  is valid. An account reporting only weekly data shows a single "Weekly limit" row.
- An account with no reporting window keeps the existing "No quota data" line (Swift
  `UsageSections.swift`, web `Tray.tsx`), so absence stays visible and is not rendered as 0%.
- Go/Free monthly-only accounts keep their existing single 30-day row. The `fiveHour*` /
  `short*` alias order is unchanged.

## Diff

1. `desktop/src-tauri/src/native_tray_accounts.rs` — drop `keep_unknown` from `windows()`'s
   `push`; keep a row when `percent.is_some() || at.is_some()`. Inline tests: weekly-only,
   null 5h, reset-only 5h, 0% 5h retained, monthly-only unchanged.
2. `desktop/src-tauri/src/widget.rs` — `quotas()` treats `Some(Value::Null)` and non-numeric
   values as absent (normalize with `number()` before the presence check). Inline test for a
   weekly-only report with `fiveHourPercent: null`.
3. `gui/src/pages/tray-data.ts` — remove the `index === 0 && monthlyPercent === undefined`
   clause. `gui/tests/tray-data.test.ts` updates the assertion that expected the placeholder
   and adds weekly-only/zero cases. Two other consumers change with it, intentionally:
   `gui/src/pages/Tray.tsx` (web tray rows; its "no quota" line already covers an empty list)
   and `gui/src/quota-summary.ts` (summary strip popover loses the empty 5h line).
4. `structure/companion.md` — one paragraph stating the presence rule for all three projections.

## Accept

- Rust: `cargo test --manifest-path desktop/src-tauri/Cargo.toml native_tray_accounts` and
  `widget::macos` pass on macOS.
- Bun: `bun test gui/tests/tray-data.test.ts gui/tests/quota-summary.test.ts gui/tests/quota-summary-bar.test.tsx` pass.
- Render: before/after panel images from the same fixture show the empty rows gone.
