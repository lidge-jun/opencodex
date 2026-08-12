# 32 — Phase 1: Storage.tsx page + nav wiring

## Problem
No Storage page or nav entry. Add a read-only page that renders the
`/api/storage` report.

## Source shape (template: gui/src/pages/Usage.tsx + gui/src/App.tsx)
Usage.tsx: `useEffect` fetch → typed interfaces → render. App.tsx wires pages
via a `Page` union, `VALID_PAGES` set, `NAV` array, page imports, and i18n keys.

## Plan (diff-level)

### NEW gui/src/pages/Storage.tsx
- Mirror Usage.tsx structure: `interface StorageBucket/StorageReport`, a
  `useEffect` that `fetch(`${API_BASE}/api/storage`)`, loading/error states.
- Render: total size header + a per-bucket table (label, size, count, oldest,
  newest) and a "largest items" disclosure. Read-only — no delete controls.
- Human-readable bytes helper (KB/MB/GB).

### MODIFY gui/src/App.tsx
- L2-8 imports: `import Storage from "./pages/Storage";`
- L15 `type Page`: add `"storage"`.
- L18 `VALID_PAGES`: add `"storage"`.
- L28 `NAV`: add `{ id: "storage", tkey: "nav.storage", Icon: IconHardDrive }`
  (add an `IconHardDrive`/disk glyph to `./icons`, or reuse an existing one).
- Render switch: route `page === "storage"` → `<Storage/>`.

### MODIFY gui/src/i18n/{en,ko,zh}.ts
Add `nav.storage`: `"Storage"` / `"저장소"` / `"存储"` (3 locales, all required —
`TKey` is a union, missing keys break the build).

## Verification
- `cd gui && bun run build` (tsc + vite) passes with the new page + nav.
- Manual: nav shows Storage; page renders the report; no delete affordance.

## Open questions
- Icon choice (new disk glyph vs reuse). See 90_open-questions.md.
