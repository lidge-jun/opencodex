# 010 — Phase 1: thread an effective stall deadline through the web-search path

> AMENDED after A-gate FAIL (see 011_audit_synthesis.md): added §2b seam heartbeats (bounds every
> silent span to ONE unit budget, making the §1 formula valid at 230s default) and §5 behavioral
> activation test. Keep `WebSearchLoopDeps.stallTimeoutSec` optional (existing direct call sites).
> AMENDED 2nd round: §2c — 429 rotation chain inside runIteration gets its own heartbeat seam via
> a generator refactor (audit round-2 blocker).

Single work-phase. All changes MODIFY existing files; no new source files (one test block added
to the existing web-search test file).

## 1. MODIFY `src/web-search/index.ts`

Add the stall computation to the plan (pure, testable via existing planWebSearch harness):

```ts
// after DEFAULT_TIMEOUT_MS:
const DEFAULT_STALL_TIMEOUT_SEC = 90;   // mirrors bridge.ts stall default
const STALL_MARGIN_SEC = 30;

/**
 * Effective bridge stall deadline for the web-search loop. The loop's silent work units are
 * individually bounded (sidecar search: settings.timeoutMs; non-streaming iteration:
 * connectTimeoutMs), so the stall deadline must cover the largest unit plus a margin —
 * otherwise a legitimately slow search trips upstream_stall_timeout at the bridge default.
 */
export function webSearchStallTimeoutSec(
  configuredSec: number | undefined,
  connectTimeoutMs: number | undefined,
  sidecarTimeoutMs: number,
): number {
  return Math.max(
    configuredSec ?? DEFAULT_STALL_TIMEOUT_SEC,
    Math.ceil((connectTimeoutMs ?? 0) / 1000),
    Math.ceil(sidecarTimeoutMs / 1000),
  ) + STALL_MARGIN_SEC;
}
```

In `SidecarPlan` add `stallTimeoutSec: number;`. In `planWebSearch`, compute it — needs the
connect timeout, which lives in config: `config.connectTimeoutMs` (same `?? 200_000` default the
server applies). Return:

```ts
const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
...
settings: { ..., timeoutMs, ... },
stallTimeoutSec: webSearchStallTimeoutSec(
  config.stallTimeoutSec,
  config.connectTimeoutMs ?? 200_000,
  timeoutMs,
),
```

(Check `OcxConfig` has both fields — `stallTimeoutSec` at src/types.ts:262, `connectTimeoutMs`
nearby; both optional.)

## 2. MODIFY `src/web-search/loop.ts`

- `WebSearchLoopDeps`: add
  `/** Effective bridge stall deadline (see webSearchStallTimeoutSec). */ stallTimeoutSec?: number;`
- **§2b seam heartbeats** — bound every silent span to one unit budget by yielding adapter-level
  heartbeat events (bridge counts ANY yielded adapter event as activity, bridge.ts:371-373; the
  heartbeat arm renders nothing):
  - in `produce()`, before `runIteration` for `i > 0`: `yield { type: "heartbeat" };`
  - in `runSearchCall`, at the top of the per-query `for` loop: `yield { type: "heartbeat" };`
    (covers sequential batched queries AND placeholder outcomes that emit no cell).
  Variant confirmed by reviewer: `{ type: "heartbeat" }` at src/types.ts:192; bridge counts any
  yielded adapter event as activity (bridge.ts:371-373) and has no heartbeat switch arm (no output).
- **§2c 429-rotation seam (round-2 blocker)** — refactor `runIteration` into an async generator so
  the 429 key-failover loop can yield a heartbeat between bounded retry fetches:

```ts
// async function* runIterationEvents(forceAnswer): AsyncGenerator<AdapterEvent, Split>
//   let resp = await fetchOnce();
//   while (resp.status === 429 && deps.on429) {
//     ...rotate; if (!rotated) break;
//     yield { type: "heartbeat" };   // seam between bounded retry fetches
//     resp = await fetchOnce();
//   }
//   ...(unchanged error/parse handling)... return scanEventsForWebSearch(events);
```

  Call sites: the EAGER first iteration (pre-bridge, stall deadline not armed yet) drains the
  generator discarding heartbeats; `produce()` iterates it with `it.next()` and re-yields
  heartbeats into the bridge. LoopError semantics unchanged (eager -> jsonError, later ->
  in-stream error event).
- Bridge call (`loop.ts:426-435`): add to the options object:

```ts
    {
      ...(deps.forceEmptyResponseId ? { responseId: "" } : {}),
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      ...(deps.stallTimeoutSec !== undefined ? { stallTimeoutSec: deps.stallTimeoutSec } : {}),
    },
```

## 3. MODIFY `src/server/responses.ts` (~line 474)

In the `runWithWebSearch({...})` deps add: `stallTimeoutSec: wsPlan.stallTimeoutSec,`.

## 4. MODIFY `structure/04_transports-and-sidecars.md`

Replace the stale "(150 ticks = 5 minutes at the default 2 s interval)" sentence with the real
semantics: default 90 s without real events (configurable via `stallTimeoutSec`), and note the
web-search loop widens its deadline to cover its bounded silent units
(max(stallTimeoutSec, connectTimeoutMs, sidecar timeoutMs) + 30 s margin, 230 s at defaults).

## 5. MODIFY `tests/web-search.test.ts`

New tests in the planning describe block (existing `config()` helper):

- default config -> `plan.stallTimeoutSec === 230` (max(90, 200, 200) + 30);
- `config({ stallTimeoutSec: 600 })` -> 630 (user-configured dominates);
- `config({ connectTimeoutMs: 30_000, webSearchSidecar: { timeoutMs: 30_000 } })` -> 120
  (bridge default dominates when unit budgets are small);
- direct `webSearchStallTimeoutSec(undefined, undefined, 200_000)` -> 230 (helper export).
- **behavioral activation test** (W3): call `runWithWebSearch` with `stallTimeoutSec` ~0.03 in
  deps — NOTE bridge clamps to a 1s minimum (`Math.max(1, ...)`, bridge.ts:171) and ticks every
  2s, so use `stallTimeoutSec: 1` and expect the kill on the first silent tick (~2-4s total) —
  and an adapter whose web_search call leads to a sidecar fetch that never resolves (reuse
  the fetch-stubbing harness from tests/sidecar-abort.test.ts); read the SSE and assert it
  terminates with `response.incomplete` + `incomplete_details.reason === "upstream_stall_timeout"`
  within a few seconds (bridge tick = 2s). Proves deps -> bridge threading actually fires.

## Accept criteria + activation grounding (C-ACTIVATION-GROUNDING-01)

1. Threading: proven by the new behavioral test (small stallTimeoutSec -> upstream_stall_timeout).
2. Computed value: new planWebSearch tests (230/630/120) + helper test.
3. Seam heartbeats: adapter heartbeat resetting the stall watchdog is already activation-tested
   (`tests/bridge.test.ts:295,308-311`); the seam yields are unconditional straight-line additions
   on the loop path, verified by diff review at C.

Gates: `bun test ./tests/` exit 0; `bun x tsc --noEmit` exit 0.

## Scope boundary

IN: the five files above. OUT: bridge.ts, adapters, GUI, sidecar defaults, parallelization,
codex-rs.
