/**
 * Route adapter for the dashboard-driven Codex app-server restart (#1046 follow-up).
 *
 * The service seam is injected through ManagementApiDeps so this suite never
 * enumerates or signals a real process. Service-level branch coverage lives in
 * tests/codex-integration/codex-app-server-restart-service.test.ts.
 *
 * Plan: devlog/_fin/260815_gui_codex_restart/010_phase1_backend_endpoint.md
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../../src/server";
import { helperPath } from "../helpers/repo-root";
import { nativeOwnerRestartService, NATIVE_OWNER_RESTART_REFUSAL } from "../helpers/native-owner-restart-service";
import { handleSystemRoutes } from "../../src/server/management/system-routes";
import type { ManagementContext } from "../../src/server/management/context";
import {
  CODEX_APP_SERVER_STATE_PATH,
  CODEX_RESTART_PATH,
  isCodexAppServerStateResponse,
  isCodexRestartResponse,
} from "../../src/lib/codex-restart-contract";
import type {
  CodexAppServerStateResponse,
  CodexRestartResponse,
} from "../../src/lib/codex-restart-contract";
import { loadConfig } from "../../src/config";

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
  readState: () => Promise<CodexAppServerStateResponse>;
  performRestart: () => Promise<CodexRestartResponse>;
}> = {}) {
  return {
    readState: overrides.readState ?? (async () => STALE_STATE),
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


describe("native-owner fixture process-control boundary", () => {
  test("the fixture installs its non-operating service on the common server startup path", () => {
    // This source-wiring guard complements the real route dispatch checks below. Do not import
    // the helper here: its top level starts a server and reads the stdin control protocol.
    const source = readFileSync(helperPath("native-main-owner-child.ts"), "utf8");
    const from = source.indexOf("function start(");
    const to = source.indexOf("const primary = start();");
    expect(from).toBeGreaterThanOrEqual(0);
    expect(to).toBeGreaterThan(from);
    expect(source.slice(from, to)).toContain("codexRestartService: nativeOwnerRestartService");
  });

  test("state queries use a synthetic unknown result without host process enumeration", async () => {
    const response = await handleSystemRoutes(contextFor(CODEX_APP_SERVER_STATE_PATH, "GET", nativeOwnerRestartService));
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ state: "unknown", runningCount: 0 });
  });

  test("restart is refused instead of invoking the live service or claiming a successful restart", async () => {
    await expect(handleSystemRoutes(contextFor(CODEX_RESTART_PATH, "POST", nativeOwnerRestartService)))
      .rejects.toThrow(NATIVE_OWNER_RESTART_REFUSAL);
    // A refused call does not poison a later read or make the next restart succeed.
    expect(await nativeOwnerRestartService.readState()).toEqual({ state: "unknown", runningCount: 0 });
    await expect(nativeOwnerRestartService.performRestart()).rejects.toThrow(NATIVE_OWNER_RESTART_REFUSAL);
  });

  test("servers on the common startup path serve the injected service over authenticated HTTP", async () => {
    // The child's start() is a thin wrapper over this same startServer call: driving real
    // listeners proves the managementApi -> ctx.deps forwarding cannot silently drop the
    // boundary while the source guard above still passes. Primary and extra fixture
    // servers share one injection path, so both are exercised here. The sentinel restart
    // body is one the live implementation could never emit: it does not fabricate a pid.
    const root = mkdtempSync(join(tmpdir(), "ocx-restart-boundary-"));
    const previousHome = process.env.OPENCODEX_HOME;
    const previousCodexHome = process.env.CODEX_HOME;
    const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    process.env.OPENCODEX_HOME = root;
    process.env.CODEX_HOME = root;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "restart-boundary-admin";
    const sentinel: CodexRestartResponse = {
      success: true,
      stateBefore: "unknown",
      synced: false,
      requested: [424242],
      stopped: [424242],
      surviving: [],
      failed: [],
      code: "stopped",
    };
    const calls: string[] = [];
    const observed = {
      readState: async () => {
        calls.push("readState");
        return nativeOwnerRestartService.readState();
      },
      performRestart: async () => {
        calls.push("performRestart");
        return sentinel;
      },
    };
    // startServer probes service ownership on every boot; without this seam it inspects the
    // developer machine's installed service state — the host coupling this fixture exists to
    // remove (the same seam native-main-owner-child.ts injects). "foreign" is deliberate: it
    // fences native-main admission with no lifecycle machinery, which this restart-route test
    // does not exercise; "owned" would start a real owner drive on the fixture home.
    const deps = {
      inspectNativeCodexOwnership: () => ({
        ownership: "foreign",
        reason: "restart route test fixture",
      }),
      managementApi: { codexRestartService: observed },
    };
    const primary = startServer(0, deps);
    const extra = startServer(0, deps);
    try {
      const headers = { "x-opencodex-api-key": "restart-boundary-admin" };
      for (const server of [primary, extra]) {
        const state = await fetch(new URL(CODEX_APP_SERVER_STATE_PATH, server.url), { headers });
        expect(state.status).toBe(200);
        expect(await state.json()).toEqual({ state: "unknown", runningCount: 0 });
        const restart = await fetch(new URL(CODEX_RESTART_PATH, server.url), { method: "POST", headers });
        expect(restart.status).toBe(200);
        expect(await restart.json()).toEqual(sentinel);
      }
      expect(calls).toEqual([
        "readState", "performRestart",
        "readState", "performRestart",
      ]);
    } finally {
      await primary.stop(true);
      await extra.stop(true);
      for (const [name, value] of [
        ["OPENCODEX_HOME", previousHome],
        ["CODEX_HOME", previousCodexHome],
        ["OPENCODEX_ADMIN_AUTH_TOKEN", previousAdminToken],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
});
