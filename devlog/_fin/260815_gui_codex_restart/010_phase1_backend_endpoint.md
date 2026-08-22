# 010 — Phase 1: Codex app-server restart service + management routes

Depends on: nothing landed by this unit.
Produces: the response contract phases 2 and 3 render.
Rejected alternatives and reasoning: `001_design_alternatives.md` §1, §5.

## Scope

| Path | Action |
|---|---|
| `src/lib/codex-restart-contract.ts` | NEW |
| `src/codex/app-server-restart-service.ts` | NEW |
| `src/server/management/system-routes.ts` | MODIFY |
| `src/server/management/context.ts` | MODIFY (one grouped seam) |
| `docs-site/src/content/docs/reference/management-api.md` | MODIFY |
| `docs-site/src/content/docs/guides/web-dashboard.md` | MODIFY |
| `tests/codex-app-server-restart-service.test.ts` | NEW |
| `tests/codex-restart-route.test.ts` | NEW |

OUT: `/api/system/restart`, `restartCodexAppServers` internals (phase 4 owns
termination), CLI sync paths.

## Invariants

1. **Shape bridge.** The classifier's `processes` are `{ pid, startedAtMs }`
   (`src/codex/app-server-processes.ts:545-549`); `restartCodexAppServers` requires
   `CodexAppServerProcess` with a mandatory `commandLine` (`:67-70`, `:662-665`).
   Passing the classifier array is a type error; the service intersects on pid.
2. **Enumeration failure signals nothing.** Note the asymmetry inside the
   classifier: an **injected** `listSnapshots` is called *outside* the try
   (`:600-613`), so a throwing injection propagates rather than producing
   `unknown`. Tests that want `unknown` therefore stub `collectState` to return it,
   not `listSnapshots` to throw.
3. **Live port.** `config.port` names the *preferred* port; after a fallback start
   the bound port differs (`src/server/index.ts:1696-1698`). The CLI already syncs
   the live port for exactly this reason (`src/cli/index.ts:494-496`). The service
   receives the live port from `getServerListenPort()`
   (`src/server/lifecycle.ts:287`) — never `config.port`.
4. **Scalar-only responses.** No command line, OS error string, or path leaves the
   process (`src/server/management/system-routes.ts:10-16`).
5. Every branch is driven through an injectable io, never a module mock.

## NEW `src/lib/codex-restart-contract.ts`

```ts
/**
 * Contract for the dashboard-driven Codex app-server restart (#1046 follow-up).
 *
 * Distinct from system-restart-contract.ts: that one restarts THIS proxy process
 * and needs a pid-bound capability because it kills its own listener. This one
 * asks matching Codex app-server children to exit so Codex rereads the catalog on
 * next launch. It never touches the proxy and never spawns a replacement.
 *
 * Scalar-only payload. A command line can contain a home directory and a username,
 * and an OS error message often embeds a path, so neither crosses this boundary.
 */
export const CODEX_RESTART_METHOD = "POST";
export const CODEX_RESTART_PATH = "/api/system/codex-restart";
export const CODEX_APP_SERVER_STATE_PATH = "/api/system/codex-app-server";

/** Mirrors CodexAppServerCatalogState so the GUI never imports runtime code. */
export type CodexAppServerState = "fresh" | "stale" | "not_running" | "unknown";

export type CodexRestartCode =
  | "stopped"
  | "nothing_running"
  | "enumeration_unavailable"
  | "partially_stopped";

/** GET response: cheap reading, no side effects, never signals. */
export interface CodexAppServerStateResponse {
  state: CodexAppServerState;
  runningCount: number;
}

export interface CodexRestartResponse {
  success: boolean;
  stateBefore: CodexAppServerState;
  synced: boolean;
  requested: number[];
  stopped: number[];
  surviving: number[];
  failed: number[];
  code: CodexRestartCode;
}

const APP_SERVER_STATES = ["fresh", "stale", "not_running", "unknown"];
const RESTART_CODES = ["stopped", "nothing_running", "enumeration_unavailable", "partially_stopped"];

/** A pid is a positive safe integer. A float or a negative number is malformed input. */
function isPidList(value: unknown): value is number[] {
  return Array.isArray(value)
    && value.every(n => typeof n === "number" && Number.isSafeInteger(n) && n > 0);
}

/** Runtime guard for GUI consumers: a 2xx body is not automatically this shape. */
export function isCodexRestartResponse(value: unknown): value is CodexRestartResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.success === "boolean"
    && typeof v.synced === "boolean"
    && APP_SERVER_STATES.includes(v.stateBefore as string)
    && RESTART_CODES.includes(v.code as string)
    && isPidList(v.requested) && isPidList(v.stopped)
    && isPidList(v.surviving) && isPidList(v.failed);
}

export function isCodexAppServerStateResponse(
  value: unknown,
): value is CodexAppServerStateResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return APP_SERVER_STATES.includes(v.state as string)
    && typeof v.runningCount === "number"
    && Number.isSafeInteger(v.runningCount) && v.runningCount >= 0;
}
```

## NEW `src/codex/app-server-restart-service.ts`

```ts
import {
  collectCodexAppServerCatalogState,
  listCodexAppServerProcesses,
  resetCodexAppServerCatalogStateCache,
  restartCodexAppServers,
} from "./app-server-processes";
import type { CodexAppServerProcessIo } from "./app-server-processes";
import type {
  CodexAppServerStateResponse,
  CodexRestartResponse,
} from "../lib/codex-restart-contract";
import { getServerListenPort } from "../server/lifecycle";

export interface CodexRestartServiceIo {
  /** Process-layer seam, forwarded to every app-server-processes call. */
  processIo?: CodexAppServerProcessIo;
  /** Catalog refresh seam. Returns whether a write happened. */
  syncCatalog?: (port?: number) => Promise<boolean>;
  /** Live listen port (invariant 3). Defaults to getServerListenPort(). */
  listenPort?: () => number | undefined;
  collectState?: typeof collectCodexAppServerCatalogState;
  listProcesses?: typeof listCodexAppServerProcesses;
  restart?: typeof restartCodexAppServers;
  resetStateCache?: () => void;
}

export function readCodexAppServerState(
  io: CodexRestartServiceIo = {},
): CodexAppServerStateResponse {
  const status = (io.collectState ?? collectCodexAppServerCatalogState)(io.processIo ?? {});
  return { state: status.state, runningCount: status.processes.length };
}

export async function performCodexRestart(
  io: CodexRestartServiceIo = {},
): Promise<CodexRestartResponse> {
  // Refresh the catalog first: a user pressing "restart Codex" wants the NEW roster,
  // and stopping app-servers before the write would hand the replacement the same
  // stale file it just lost.
  let synced = false;
  try {
    // Invariant 3: the LIVE bound port, never config.port.
    const port = (io.listenPort ?? getServerListenPort)();
    synced = await (io.syncCatalog ?? defaultSyncCatalog)(port);
  } catch {
    // A sync failure must not block the restart. An operator whose picker is stale
    // still benefits from the app-server exiting and rereading whatever is on disk.
  }

  // The classifier memoizes for 5s when every io field is defaulted, so a reading
  // taken before the write above would otherwise be replayed after it.
  (io.resetStateCache ?? resetCodexAppServerCatalogStateCache)();
  const before = (io.collectState ?? collectCodexAppServerCatalogState)(io.processIo ?? {});

  if (before.processes.length === 0) {
    return {
      success: true,
      stateBefore: before.state,
      synced,
      requested: [], stopped: [], surviving: [], failed: [],
      code: before.state === "unknown" ? "enumeration_unavailable" : "nothing_running",
    };
  }

  // BRIDGE (invariant 1): the classifier carries no command line, but
  // restartCodexAppServers needs the full identity so it can refuse to signal a
  // recycled pid. Re-list and intersect on pid rather than reconstructing an
  // identity we never verified.
  const staleIds = new Set(before.processes.map(entry => entry.pid));
  const live = (io.listProcesses ?? listCodexAppServerProcesses)(io.processIo ?? {});
  const targets = live.filter(proc => staleIds.has(proc.pid));

  if (targets.length === 0) {
    // Every classified process exited between the two calls. Reporting "stopped"
    // would claim credit for work we did not do.
    return {
      success: true,
      stateBefore: before.state,
      synced,
      requested: [], stopped: [], surviving: [], failed: [],
      code: "nothing_running",
    };
  }

  const result = (io.restart ?? restartCodexAppServers)(targets, io.processIo ?? {});
  const clean = result.surviving.length === 0 && result.failed.length === 0;
  return {
    success: clean,
    stateBefore: before.state,
    synced,
    requested: result.requested,
    stopped: result.stopped,
    surviving: result.surviving,
    // Project { pid, error } to pids: the OS message can embed a path or username.
    failed: result.failed.map(entry => entry.pid),
    code: clean ? "stopped" : "partially_stopped",
  };
}

async function defaultSyncCatalog(port?: number): Promise<boolean> {
  const { syncModelsToCodex } = await import("./sync");
  const result = await syncModelsToCodex(port, undefined, null);
  return result.catalogWritten || result.cacheSynced;
}
```

`getServerListenPort` is imported statically from `../server/lifecycle`
(`src/server/lifecycle.ts:287`). Confirm at implementation time that this does not
close a module cycle — this service is reached only from the management route, which
already lives under `src/server`. If `bun run typecheck` or a runtime import error
shows a cycle, move the call into the route adapter and pass the port down through
`CodexRestartServiceIo.listenPort` instead of resolving it inside the service. Do
not reach for `require()`: the runtime is Bun-native ESM.

## MODIFY `src/server/management/context.ts`

One grouped seam so route tests can drive the adapter without executing a real
sync or signalling real processes:

```ts
import type {
  performCodexRestart,
  readCodexAppServerState,
} from "../../codex/app-server-restart-service";
```

then, inside `ManagementApiDeps`:

```ts
  /**
   * Codex app-server restart seam (unit 260815_gui_codex_restart). Grouped rather
   * than three separate fields: the route is an adapter over one service, and a
   * route test that cannot stub it would really terminate the developer's Codex.
   */
  codexRestartService?: {
    readState: typeof readCodexAppServerState;
    performRestart: typeof performCodexRestart;
  };
```

## MODIFY `src/server/management/system-routes.ts`

Add to the imports at the top of the file:

```ts
import {
  CODEX_APP_SERVER_STATE_PATH,
  CODEX_RESTART_PATH,
} from "../../lib/codex-restart-contract";
```

Then, inside `handleSystemRoutes`, resolve the service lazily so a request that
touches neither path never imports the process-enumeration helpers:

```ts
  const resolveCodexRestartService = async () =>
    ctx.deps?.codexRestartService
    ?? await import("../../codex/app-server-restart-service").then(mod => ({
      readState: mod.readCodexAppServerState,
      performRestart: mod.performCodexRestart,
    }));

  if (url.pathname === CODEX_APP_SERVER_STATE_PATH && req.method === "GET") {
    const service = await resolveCodexRestartService();
    return jsonResponse(service.readState(), 200, req, config);
  }

  if (url.pathname === CODEX_RESTART_PATH && req.method === "POST") {
    const service = await resolveCodexRestartService();
    return jsonResponse(await service.performRestart(), 200, req, config);
  }
```

Normalizing both the injected and the imported form to one
`{ readState, performRestart }` shape keeps the call sites free of shape checks.

### Authorization — what is actually true

`handleManagementAPI` applies `isAllowedManagementOrigin` to **every** management
request before dispatch (`src/server/management-api.ts:138-140`), and route
dispatch happens further down the same function (`:208-225`). The auth gate itself
runs in `src/server/index.ts:871-885`.

On top of that common origin gate, principals differ
(`src/server/management-auth.ts:461-477`): a GUI dashboard session must also carry
its origin binding and CSRF header for mutations, while an admin token
authenticates without that additional binding.

These routes add no auth of their own and require no restart capability — that
capability authorizes killing *this* process, which these routes never do.

Auth regression tests (added to the existing server-boundary suite):

| Case | Expectation |
|---|---|
| disallowed Origin header | 403 |
| unauthenticated POST | 401 |
| GUI session without CSRF | 401 |
| GUI session with CSRF | 200 |
| admin token | 200 |
| GET state route, unauthenticated | 401 |

## MODIFY docs-site

`reference/management-api.md` — add to the "System lifecycle" table (currently
ending at `POST /api/stop`, `:224`):

```markdown
| \`GET /api/system/codex-app-server\` | Report whether running Codex app-servers predate the current model catalog | — |
| \`POST /api/system/codex-restart\` | Refresh the catalog, then ask stale Codex app-servers to exit so the model picker reloads | Returns 200 with \`code: partially_stopped\` when a target survives |
```

`guides/web-dashboard.md` — document the sidebar action pair and the models-tab
control in the same pass, since both are user-visible dashboard surfaces
(`gui/AGENTS.md:36`). Translated locales of this guide are updated in the same
change or, where a locale has no translation of the surrounding section, left
untouched rather than partially translated; state which applies in the D summary.

## Tests

`tests/codex-app-server-restart-service.test.ts` — every branch through
`CodexRestartServiceIo`:

| Scenario | Trigger | Observable proof |
|---|---|---|
| all stopped | two classified pids, both live, kill succeeds | `code === "stopped"`, `stopped.length === 2` |
| nothing running | `collectState` returns no processes, state `not_running` | `code === "nothing_running"`, restart seam never called |
| enumeration unavailable | `collectState` returns `unknown` with no processes (see invariant 2) | `code === "enumeration_unavailable"`, restart seam never called |
| partially stopped | one target survives | `code === "partially_stopped"`, `success === false` |
| race: classified then exited | `collectState` has pid 1, `listProcesses` returns none | `code === "nothing_running"`, restart seam never called |
| identity bridge | classified 1 and 2; live 2 and 9 | restart called with exactly pid 2 |
| live port forwarded | `listenPort` returns 41999 | `syncCatalog` received 41999 |
| sync failure tolerated | `syncCatalog` rejects | `synced === false`, restart still attempted |
| no leakage | any path | serialized body has no command line and no error text |

`tests/codex-restart-route.test.ts` — route adapter with
`deps.codexRestartService` injected: both paths return the contract shape, the GET
route never calls `performRestart`, and the auth cases above.

The enumeration-unavailable and race cases must be proven rather than assumed:
both are branches where doing nothing is correct, and a regression in either would
silently kill nothing while reporting success.

## Accept criteria

1. Both routes return their contract shapes across all four codes.
2. No command line, OS error string, or path appears in any response body.
3. The live port reaches `syncModelsToCodex`, proven by the forwarding test.
4. `bun test tests/codex-app-server-restart-service.test.ts tests/codex-restart-route.test.ts` green.
5. `bun run typecheck` green — this is what proves the identity bridge is real.
6. `bun run privacy:scan` green.
7. Both docs-site pages updated.

## Verifier commands

| Command | Reads this change? |
|---|---|
| `bun test tests/codex-app-server-restart-service.test.ts tests/codex-restart-route.test.ts` | yes — direct arguments |
| `bun run typecheck` | yes — `tsconfig.json` includes `src` and `tests` |
| `bun run privacy:scan` | yes — scans `src/` |

## Bypass record

- Tier: E2 (test-enforced), with E4 CI on `dev`.
- Executing surface: `bun test` locally and in GitHub Actions.
- Known bypass: any principal clearing the management gate may call the route
  repeatedly; nothing rate-limits it.
- Residual risk: repeated clicks send repeated SIGTERMs. Bounded by the pid+identity
  re-resolution inside `restartCodexAppServers` (`:676-682`).
- Wording: the rate bound is an **early warning**, not enforcement. Final
  enforcement layer: none, because the action is user-initiated by design.

