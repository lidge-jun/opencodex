# 21 — Storage scanner module (read-only foundation)

Shared foundation for Phase 1 diagnostics (and later phases' preview math).
No deletion logic here — pure measurement.

## Problem

There is no module that knows where Codex stores data or how big each bucket is.
`src/codex-paths.ts:25` only exports config-file consts (`CODEX_CONFIG_PATH`,
`DEFAULT_CATALOG_PATH`, …) — no `sessions/`, `archived_sessions/`, `state_*`,
or `logs_*` path helpers. A scanner must derive those itself.

## Proposed module: `src/storage/scanner.ts` (NEW)

### Path derivation (build on CODEX_HOME)
```
const SESSIONS_DIR   = join(CODEX_HOME, "sessions");
const ARCHIVED_DIR   = join(CODEX_HOME, "archived_sessions");
// state_*.sqlite / logs_*.sqlite are versioned — glob the newest by suffix number.
```
- `state_*.sqlite` / `logs_*.sqlite` carry a version suffix (`state_5`, `logs_2`
  observed). Resolve the highest-numbered file rather than hardcoding.

### Bucket model (output type)
```ts
interface StorageBucket {
  key: "sessions" | "archived_sessions" | "logs_db" | "state_db"
     | "attachments" | "deletion_manifests" | "other";
  label: string;
  bytes: number;
  fileCount: number;
  oldest?: number;   // epoch ms
  newest?: number;   // epoch ms
  largest?: { path: string; bytes: number }[]; // capped (e.g. top 5)
}
interface StorageReport {
  codexHome: string;
  generatedAt: number;
  total: { bytes: number; fileCount: number };
  buckets: StorageBucket[];
}
```

### Measurement rules
- File/dir sizes via `fs.stat` / recursive walk — NEVER open a DB to size it.
- Walk `sessions/<YYYY>/<MM>/<DD>/*.jsonl` to count + sum + oldest/newest.
- DB internal counts (threads, logs rows) only if needed, via
  `?mode=ro&immutable=1`; on lock/error, return `null` counts and continue.
- Cap `largest[]` (top N) to bound payload.
- Read-only invariant: the scanner performs zero writes under CODEX_HOME.

## Verification
- Unit test against a fixture CODEX_HOME (synthetic sessions tree + tiny sqlite).
- Assert: bucket sizes match `du`, fileCount matches `find … | wc -l`, no writes.
- Reproduce numbers from 20_codex-storage-structure.md on the real home.

## Open questions
- Include non-session buckets (plugins/computer-use) for a full disk view, or
  scope strictly to session data? (See 90_open-questions.md.)
