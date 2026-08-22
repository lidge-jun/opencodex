/**
 * Route adapter for the dashboard-driven Codex app-server restart (#1046 follow-up).
 *
 * The service seam is injected through ManagementApiDeps so this suite never
 * enumerates or signals a real process. Service-level branch coverage lives in
 * tests/codex-app-server-restart-service.test.ts.
 *
 * Plan: devlog/_fin/260815_gui_codex_restart/010_phase1_backend_endpoint.md
 */
import { describe, expect, test } from "bun:test";
import { handleSystemRoutes } from "../src/server/management/system-routes";
import type { ManagementContext } from "../src/server/management/context";
import {
  CODEX_APP_SERVER_STATE_PATH,
  CODEX_RESTART_PATH,
  isCodexAppServerStateResponse,
  isCodexRestartResponse,
} from "../src/lib/codex-restart-contract";
import type {
  CodexAppServerStateResponse,
  CodexRestartResponse,
} from "../src/lib/codex-restart-contract";
import { loadConfig } from "../src/config";

const STOPPED: CodexRestartResponse = {
  success: true,
  stateBefore: "stale",
  synced: true,
  requested: [4242],
  stopped: [4242],
  surviving: [],
  failed: [],
  code: "stopped",
};

const STALE_STATE: CodexAppServerStateResponse = { state: "stale", runningCount: 1 };

function contextFor(
  path: string,
  method: string,
  service: NonNullable<ManagementContext["deps"]["codexRestartService"]>,
): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  return {
    req: new Request(url, { method }),
    url,
    config: loadConfig(),
    deps: { codexRestartService: service },
  } as ManagementContext;
}

function stubService(overrides: Partial<{
  readState: () => CodexAppServerStateResponse;
  performRestart: () => Promise<CodexRestartResponse>;
}> = {}) {
  return {
    readState: overrides.readState ?? (() => STALE_STATE),
    performRestart: overrides.performRestart ?? (async () => STOPPED),
  } as NonNullable<ManagementContext["deps"]["codexRestartService"]>;
}

describe("GET /api/system/codex-app-server", () => {
  test("returns the classifier reading in the contract shape", async () => {
    const response = await handleSystemRoutes(
      contextFor(CODEX_APP_SERVER_STATE_PATH, "GET", stubService()),
    );

    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(isCodexAppServerStateResponse(body)).toBe(true);
    expect(body).toEqual({ state: "stale", runningCount: 1 });
  });

  test("never signals: the read route must not reach performRestart", async () => {
    let restarted = false;
    await handleSystemRoutes(contextFor(CODEX_APP_SERVER_STATE_PATH, "GET", stubService({
      performRestart: async () => {
        restarted = true;
        return STOPPED;
      },
    })));

    expect(restarted).toBe(false);
  });

  test("does not answer a POST on the read path", async () => {
    const response = await handleSystemRoutes(
      contextFor(CODEX_APP_SERVER_STATE_PATH, "POST", stubService()),
    );

    expect(response).toBeNull();
  });
});

describe("POST /api/system/codex-restart", () => {
  test("returns the restart result in the contract shape", async () => {
    const response = await handleSystemRoutes(
      contextFor(CODEX_RESTART_PATH, "POST", stubService()),
    );

    expect(response?.status).toBe(200);
    const body = await response!.json();
    expect(isCodexRestartResponse(body)).toBe(true);
    expect(body.code).toBe("stopped");
    expect(body.stopped).toEqual([4242]);
  });

  test("passes a partially_stopped outcome through with success=false", async () => {
    const response = await handleSystemRoutes(
      contextFor(CODEX_RESTART_PATH, "POST", stubService({
        performRestart: async () => ({
          ...STOPPED,
          success: false,
          stopped: [],
          surviving: [4242],
          code: "partially_stopped",
        }),
      })),
    );

    const body = await response!.json();
    expect(response?.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.code).toBe("partially_stopped");
  });

  test("passes enumeration_unavailable through unchanged", async () => {
    const response = await handleSystemRoutes(
      contextFor(CODEX_RESTART_PATH, "POST", stubService({
        performRestart: async () => ({
          success: true,
          stateBefore: "unknown",
          synced: false,
          requested: [],
          stopped: [],
          surviving: [],
          failed: [],
          code: "enumeration_unavailable",
        }),
      })),
    );

    const body = await response!.json();
    expect(body.code).toBe("enumeration_unavailable");
    expect(body.stateBefore).toBe("unknown");
  });

  test("does not answer a GET on the restart path", async () => {
    const response = await handleSystemRoutes(
      contextFor(CODEX_RESTART_PATH, "GET", stubService()),
    );

    expect(response).toBeNull();
  });

  test("leaves unrelated /api/system paths alone", async () => {
    const response = await handleSystemRoutes(
      contextFor("/api/system/nonexistent", "POST", stubService()),
    );

    expect(response).toBeNull();
  });
});

