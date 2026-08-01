# 50C - Phase 50C Plan: Selected-Pool Sidecar Outcome Recording

Date: 2026-06-24

Status: implemented, focused-verified.

## Objective

Close the Patch 5 sidecar gap found during Phase 50B audit: web-search and vision sidecars reuse the selected ChatGPT pool credential, but their HTTP failures currently return graceful `{ error }` markers without recording account health or quarantining 401/403.

This phase wires selected-pool sidecar outcomes into the Phase 50B taxonomy without changing sidecar user-facing error envelopes.

## Acceptance Criteria

- When a selected pool account is used for web-search sidecar traffic:
  - HTTP 401/403 records a credential outcome and quarantines that pool account.
  - HTTP 429/5xx records an account outcome through the existing taxonomy.
  - fetch errors/timeouts record `"connect_error"` / `"timeout"`.
  - successful 2xx responses record success and can clear prior transient health.
- The same outcome recording behavior applies to the vision sidecar.
- The outcome recorder is only attached when `authCtx.kind === "pool"`; main/inbound passthrough requests do not create fake pool health records.
- Sidecar functions remain testable and do not import global runtime config or account state directly.
- User-visible sidecar error strings remain unchanged except for already-existing status/error contents.
- No local account IDs, emails, or token values are logged or returned.

## File Plan

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/web-search/executor.ts`

Import only the type:

```ts
import type { CodexUpstreamOutcome } from "../codex-routing";
```

Add:

```ts
export type SidecarOutcomeRecorder = (outcome: CodexUpstreamOutcome) => void;
```

Change `runWebSearch()` signature to accept an optional final `recordOutcome?: SidecarOutcomeRecorder`.

Inside `runWebSearch()`:

- after `fetch()`, call `recordOutcome?.(res.status)` before status branching;
- in `catch`, map `TimeoutError` to `"timeout"` and everything else to `"connect_error"`, call `recordOutcome?.(...)`, then return the existing error object.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/web-search/loop.ts`

Import `SidecarOutcomeRecorder`.

Add optional `recordSidecarOutcome?: SidecarOutcomeRecorder` to `WebSearchLoopDeps`.

Pass `recordSidecarOutcome` into `runWebSearch(...)`.

Do not record the main routed-provider loop fetch here in this slice. That fetch belongs to the routed provider, not necessarily the ChatGPT sidecar credential.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/vision/describe.ts`

Import `SidecarOutcomeRecorder` type from the web-search executor, or define a shared type if needed without creating a dependency cycle.

Change `describeImage()` signature to accept optional final `recordOutcome?: SidecarOutcomeRecorder`.

Inside `describeImage()`:

- after `fetch()`, call `recordOutcome?.(res.status)`;
- in `catch`, map `TimeoutError` to `"timeout"` and everything else to `"connect_error"`, call `recordOutcome?.(...)`, then return the existing error object.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/vision/index.ts`

Import `SidecarOutcomeRecorder`.

Add optional `recordSidecarOutcome?: SidecarOutcomeRecorder` to `describeImagesInPlace()`.

Pass it to `describeImage(...)`.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/src/server.ts`

Add a small helper near `handleResponses()`:

```ts
function sidecarOutcomeRecorder(config: OcxConfig, authCtx: CodexAuthContext) {
  return authCtx.kind === "pool"
    ? (outcome: CodexUpstreamOutcome) => recordCodexUpstreamOutcome(config, authCtx.accountId, outcome)
    : undefined;
}
```

Import `CodexUpstreamOutcome` as a type from `src/codex-routing.ts`.

When calling:

- `describeImagesInPlace(...)`, pass `sidecarOutcomeRecorder(config, authCtx)`;
- `runWithWebSearch(...)`, pass `recordSidecarOutcome: sidecarOutcomeRecorder(config, authCtx)`.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/sidecar-abort.test.ts`

Add tests without real account identifiers:

- `runWebSearch()` records status `401` and preserves existing `{error}` result.
- `runWebSearch()` records `"connect_error"` on thrown fetch failures.
- `describeImage()` records status `403` and preserves existing `{error}` result.
- `describeImage()` records `"connect_error"` on thrown fetch failures.

These unit tests prove the sidecar helper behavior. Existing `src/codex-routing.ts` tests prove 401/403 then quarantine through `recordCodexUpstreamOutcome()`.

### MODIFY `/Users/jun/Developer/new/700_projects/opencodex/tests/web-search.test.ts` OR `/Users/jun/Developer/new/700_projects/opencodex/tests/sidecar-abort.test.ts`

Add one integration-style unit test for `runWithWebSearch()`:

- mock a model response that calls synthetic web_search;
- mock the sidecar fetch to return `401`;
- pass `recordSidecarOutcome` collector;
- assert `401` was recorded.

If this is too heavy for this slice, direct `runWebSearch()` coverage is sufficient because `runWithWebSearch()` only forwards the callback.

## Verification Plan

Focused:

```bash
bun test tests/sidecar-abort.test.ts tests/web-search.test.ts tests/codex-routing.test.ts
```

Full:

```bash
bun run typecheck
bun test tests
cd gui && bun run build
git diff --check
git status --short
```

Independent verification:

- read-only verifier checks that sidecar callbacks are attached only for pool auth, failures use the shared outcome taxonomy, and no PII/token material is logged or returned.

## Implementation Evidence

Changed files:

- `/Users/jun/Developer/new/700_projects/opencodex/src/web-search/executor.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/web-search/loop.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/vision/describe.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/vision/index.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/src/server.ts`
- `/Users/jun/Developer/new/700_projects/opencodex/tests/sidecar-abort.test.ts`

Implemented:

- Added `SidecarOutcomeRecorder` and optional outcome callbacks to web-search and vision sidecar fetch helpers.
- Web-search and vision sidecars now record HTTP status outcomes after fetch and `"timeout"` / `"connect_error"` for fetch exceptions.
- `runWithWebSearch()` and `describeImagesInPlace()` forward optional sidecar outcome callbacks without changing existing callers.
- `src/server.ts` attaches the recorder only when the resolved Codex auth context is a selected pool account.
- Added sidecar tests for HTTP 401/403, connect errors, and `runWithWebSearch()` callback forwarding.

Focused verification:

```text
bun test tests/sidecar-abort.test.ts tests/web-search.test.ts tests/codex-routing.test.ts
32 pass
0 fail
87 expect() calls
```

## Out Of Scope For This Slice

- 429 cooldown windows with `Retry-After`.
- Time-bounded failure streak expiry.
- Terminal SSE/WebSocket `response.failed` / `response.incomplete` account outcome recording.
