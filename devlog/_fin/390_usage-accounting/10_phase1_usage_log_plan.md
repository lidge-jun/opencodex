# Phase 1 - Persistent Usage Log Plan

## Easy Explanation

Phase 1 records what the proxy already knows. If an upstream response reports token usage, opencodex stores it in a local JSONL file. If a request finishes without usage, opencodex records that fact as `unreported` instead of pretending it used zero tokens.

## Diff-Level Plan

### NEW `src/usage-log.ts`

Exports:

- `UsageStatus`
- `PersistedUsageEntry`
- `usageLogPath()`
- `usageTotalTokens(usage)`
- `usageStatusForFinalLog(status, usage)`
- `appendUsageEntry(entry)`
- `readUsageEntries(options?)`

Implementation notes:

- resolve path with `getConfigDir()`;
- mkdir config dir recursively before append;
- best-effort chmod config dir `0700`;
- append one JSON object per line with trailing newline;
- skip malformed JSONL lines on read;
- do not include prompts, response bodies, headers, API keys, OAuth tokens, or ChatGPT account identities.

### MODIFY `src/server.ts`

Imports:

- import usage helpers and `UsageStatus`;
- import `OcxUsage` type if needed.

Request log changes:

- add `usage?: OcxUsage` and `usageStatus?: UsageStatus` to `RequestLogContext`;
- add `usage?: OcxUsage`, `usageStatus: UsageStatus`, and `totalTokens?: number` to `RequestLogEntry`;
- extend `applyResponseLogMetadata` to parse OpenAI Responses usage objects:
  - `input_tokens`;
  - `output_tokens`;
  - `input_tokens_details.cached_tokens`;
  - `output_tokens_details.reasoning_tokens`;
- preserve existing service tier and resolved model capture;
- make `addRequestLog` append to both the in-memory log and the persistent usage log;
- keep injected `addLog` test hook free of disk writes.

Status rules:

- `usage` present -> `reported`;
- no usage -> `unreported`;
- `unsupported` remains available in the schema but is not assigned until adapter-level unsupported knowledge exists.

### NEW `tests/usage-log.test.ts`

Test:

- path respects `OPENCODEX_HOME`;
- append creates JSONL and preserves `0600` intent where observable;
- read skips malformed lines;
- token total includes input + output only;
- no prompt/body fields are required or stored.

### MODIFY `tests/request-log.test.ts`

Test:

- JSON response usage is captured into request log entries;
- SSE `response.completed` usage is captured into request log entries;
- no usage produces `usageStatus: "unreported"` and no `totalTokens`;
- existing service-tier metadata tests still pass.

## Acceptance Evidence

- `bun test tests/usage-log.test.ts tests/request-log.test.ts`
- `bunx tsc --noEmit`
- atomic commit: `feat(usage): persist request token usage`
