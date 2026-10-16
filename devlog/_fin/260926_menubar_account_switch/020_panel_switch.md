# 020 — PR6: Use button in the native panel

## Behavior

- Each account row gains `accountId` (raw id) and `switch`: `available`, `active`, or
  `blocked` with a reason (`mainHardLock`, `paused`), plus `exhausted` when a window reads 100%.
- Use appears on hover or keyboard focus (and as an accessibility action) for `available` rows.
  A blocked main row shows "Blocked by 98% protection"; exhausted rows keep Use with a warning.
- Clicking calls a Swift export registered by Rust with provider id + raw account id. Rust derives
  the switch kind from its own provider source list (never from the panel), builds the body, calls
  `put_account_switch`, then refreshes; failures become a panel error line. The row shows a
  spinner until the next snapshot.

## Diff

- `desktop/src-tauri/src/proxy.rs`: the account-switch transport from 010 item 6, with the fixed
  vectors shared with `tests/server/local-account-switch-capability.test.ts`.
- `desktop/src-tauri/src/native_tray_accounts.rs`: `accountId`, `switch`, `exhausted`; switch kind
  per source; tests.
- `desktop/src-tauri/src/native_tray.rs`: register switch handler; validate and copy C strings on
  the main thread; spawn the PUT; refresh; tests for validation.
- `app/Sources/NativeTray`: ABI export, model fields, row UI, pending state; NativeTrayTests.
- `structure/companion.md` / `desktop-shell.md` note.

## Accept

cargo test native_tray*, swift build + NativeTrayTests, render of hover/blocked/exhausted states.
