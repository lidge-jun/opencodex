# Usage Accounting Plan

## Goal

Build persistent local usage accounting for opencodex and expose it in the dashboard:

- append request token usage to durable local state;
- keep request logs useful by showing token totals per request;
- add an aggregate usage API for GUI consumption;
- add a Usage dashboard tab with GitHub-style daily activity, range filters, model/provider breakdowns, and coverage indicators.

This is not a billing system. It is a local observability surface for the proxy owner.

## Current System

- Adapter usage already exists in `src/types.ts` as `OcxUsage`.
- `src/bridge.ts` converts adapter usage into OpenAI Responses-shaped `usage`.
- `src/server.ts` already inspects Responses JSON/SSE metadata for model and service tier fields, but request logs are in-memory only and do not persist token usage.
- `gui/src/pages/Logs.tsx` renders request logs without a token column.
- `gui/src/App.tsx` has no Usage page.
- `structure/00_overview.md` lists local state, but no usage log.
- `structure/05_gui-and-management-api.md` lists `/api/logs`, but no usage endpoint.

## Storage

Use the opencodex config directory:

```text
~/.opencodex/usage.jsonl
```

Resolve it through `getConfigDir()` so `OPENCODEX_HOME` test fixtures and custom homes work.

JSONL is intentionally append-only:

- low write amplification;
- easy to tail/debug;
- request records remain useful even if the process exits between requests;
- malformed lines can be skipped without losing the whole file.

Security rules:

- create the directory with best-effort `0700`;
- create the log with `0600`;
- never store prompts, response text, headers, API keys, OAuth tokens, or account credentials;
- store only request metadata already visible in `/api/logs` plus numeric usage fields.

## Usage Semantics

Missing usage must not be treated as zero.

Statuses:

| Status | Meaning | Included in token totals |
| --- | --- | --- |
| `reported` | Provider/bridge supplied usage for this request. | Yes |
| `unreported` | Request completed or closed, but no usage object was observed. This includes interrupted streams and providers that omit final usage. | No |
| `unsupported` | The route/provider shape is known not to expose usage for this request. | No |
| `estimated` | Reserved future state for opt-in estimates. Disabled in v1. | No |

V1 stores `reported` whenever a valid usage object is observed. Otherwise it stores `unreported`.
`unsupported` is part of the schema/API so the GUI and future adapter-specific detection do not need a data migration.

## API Contract

Add:

```text
GET /api/usage?range=7d|30d|all
```

Response shape:

```ts
{
  range: "7d" | "30d" | "all";
  since: number | null;
  generatedAt: number;
  summary: {
    requests: number;
    reportedRequests: number;
    unreportedRequests: number;
    unsupportedRequests: number;
    estimatedRequests: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    reasoningOutputTokens: number;
    totalTokens: number;
    coverageRatio: number;
  };
  days: Array<{
    date: string;
    requests: number;
    reportedRequests: number;
    totalTokens: number;
  }>;
  models: Array<{
    provider: string;
    model: string;
    resolvedModel?: string;
    requests: number;
    reportedRequests: number;
    totalTokens: number;
    inputTokens: number;
    outputTokens: number;
    shareRatio: number;
  }>;
  providers: Array<{
    provider: string;
    requests: number;
    reportedRequests: number;
    totalTokens: number;
    shareRatio: number;
  }>;
}
```

`/api/logs` should continue returning recent in-memory entries, now with `usage`, `usageStatus`, and a derived total token value when reported.

## GUI

Add a new Usage nav item and page:

- top summary: total reported tokens, reported requests, coverage, active days;
- range segmented control: All / 30d / 7d;
- daily activity as a GitHub-style grid: 7 rows by week columns, not bars;
- dense model list with search/filter, many-model rendering, input/output/token share;
- provider breakdown;
- coverage section explaining reported/unreported/unsupported counts without treating missing as zero.

Add a `Tokens` column to Logs:

- format values like `113.7K`, `331.8K`;
- show a muted `unreported` / `unsupported` marker instead of `0` when usage is absent.

## PABCD Slice Map

### Phase 1 - Persistent Usage Log

Files:

- NEW `src/usage-log.ts`
- MODIFY `src/server.ts`
- NEW `tests/usage-log.test.ts`
- MODIFY `tests/request-log.test.ts`
- NEW `devlog/390_usage-accounting/10_phase1_usage_log_plan.md`

Outcome:

- request log context captures usage from Responses JSON/SSE;
- final request log entries include usage status;
- default request log sink appends secret-safe JSONL usage entries;
- tests prove reported and unreported semantics.

### Phase 2 - Usage API And Logs Token Column

Files:

- NEW `src/usage-summary.ts`
- MODIFY `src/server.ts`
- MODIFY `tests/request-log.test.ts` or NEW `tests/usage-summary.test.ts`
- MODIFY `gui/src/pages/Logs.tsx`
- MODIFY `gui/src/i18n/en.ts`
- MODIFY `gui/src/i18n/ko.ts`
- MODIFY `gui/src/i18n/zh.ts`
- NEW `devlog/390_usage-accounting/20_phase2_usage_api_logs_plan.md`

Outcome:

- `/api/usage` returns aggregate totals and breakdowns;
- Logs page shows per-request token totals while preserving service-tier badges.

### Phase 3 - Usage Dashboard Tab

Files:

- NEW `gui/src/pages/Usage.tsx`
- MODIFY `gui/src/App.tsx`
- MODIFY `gui/src/icons.tsx` if a fitting existing icon is unavailable
- MODIFY `gui/src/styles.css`
- MODIFY `gui/src/i18n/en.ts`
- MODIFY `gui/src/i18n/ko.ts`
- MODIFY `gui/src/i18n/zh.ts`
- NEW `devlog/390_usage-accounting/30_phase3_usage_gui_plan.md`

Outcome:

- Usage tab renders a dense, interactive local analytics page;
- daily activity uses 7-row week columns;
- model/provider lists handle many rows without layout jumps.

### Phase 4 - Dashboard Card And Structure Docs

Files:

- MODIFY `gui/src/pages/Dashboard.tsx`
- MODIFY `structure/00_overview.md`
- MODIFY `structure/05_gui-and-management-api.md`
- NEW `devlog/390_usage-accounting/40_phase4_docs_dashboard_plan.md`

Outcome:

- main dashboard surfaces a small token/coverage summary;
- structure docs document durable local usage state and `/api/usage`.

## Verification

Per phase:

- focused Bun tests for changed backend behavior;
- GUI build for frontend slices;
- targeted browser/screenshot check for the Usage page;
- independent reviewer/employee challenge before phase close;
- atomic commit per phase.

Full-goal stop audit must prove:

- `~/.opencodex/usage.jsonl` is secret-safe and append-only;
- reported/unreported/unsupported semantics are visible in code and GUI;
- `/api/logs` and `/api/usage` behavior is tested;
- Usage GUI tab and Logs token column build cleanly;
- structure docs match implementation.
