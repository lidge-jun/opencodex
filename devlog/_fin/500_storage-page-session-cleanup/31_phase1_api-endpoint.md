# 31 — Phase 1: GET /api/storage endpoint

## Problem
The dashboard has no backend feed for storage data. Need a read-only endpoint
mirroring the existing `/api/usage` shape.

## Source shape (template: `/api/usage`, src/server.ts:1671)
```ts
if (url.pathname === "/api/usage" && req.method === "GET") {
  const range = parseRange(...);
  try { return jsonResponse(summarizeUsage(readUsageEntries(), range, now)); }
  catch { return jsonResponse({ ...empty envelope..., error: "read_failed" }); }
}
```
The same try/catch + empty-envelope-on-error pattern applies.

## Plan (diff-level)

### MODIFY src/server.ts (near L1671, beside /api/usage)
```ts
if (url.pathname === "/api/storage" && req.method === "GET") {
  try {
    return jsonResponse(scanStorage());           // from src/storage/scanner.ts
  } catch {
    return jsonResponse({
      codexHome: CODEX_HOME,
      generatedAt: Date.now(),
      total: { bytes: 0, fileCount: 0 },
      buckets: [],
      error: "scan_failed",
    });
  }
}
```
- Import `scanStorage` from `./storage/scanner` and `CODEX_HOME` from
  `./codex-paths` (already imported elsewhere in server.ts).
- Read-only: GET only; no POST/PUT/DELETE in Phase 1.
- Optional `?refresh=1` later if caching is added; Phase 1 scans on each call
  (cheap: fs.stat walk, no DB blob reads).

## Security / safety
- No auth change; reuses the existing dashboard API auth middleware.
- No deletion route registered in this phase (explicitly out of scope).

## Verification
- Unit/integration: hit `/api/storage` against a fixture home; assert bucket
  numbers + `error` absent on success, and the fallback envelope on a forced
  scan failure.
