import { describe, expect, spyOn, test } from "bun:test";
import { handleManagementAPI } from "../../src/server/management-api";
import type { ManagementApiDeps } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as updateJobModule from "../../src/update/job";
import { updateJobPath } from "../../src/update/job";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const config = { port: 10100, defaultProvider: "openai", providers: {} } as OcxConfig;

async function call(method: string, path: string, body?: object, deps: ManagementApiDeps = {}) {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const request = new Request(url, {
    method,
    headers: { host: "127.0.0.1:10100", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return handleManagementAPI(request, url, config, deps, "admin-token");
}

describe("asynchronous package update routes", () => {
  test("non-source check leaves the event loop responsive while lookup is pending", async () => {
    let lookupEntered!: () => void;
    const entered = new Promise<void>(resolve => { lookupEntered = resolve; });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let settled = false;
    const pending = call("GET", "/api/update/check?tag=latest", undefined, {
      checkPackageUpdate: async channel => {
        expect(channel).toBe("latest");
        lookupEntered();
        await gate;
        return {
          currentVersion: "2.7.43", latestVersion: "2.7.44", channel,
          installer: "npm", updateAvailable: true, canUpdate: true,
          command: "npm install -g @bitkyc08/opencodex@2.7.44", releaseNotesUrl: "https://example.test/releases",
        };
      },
    }).then(response => { settled = true; return response; });
    try {
      await entered;
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
    } finally {
      release();
    }
    const response = await pending;
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.installer).toBe("npm");
    expect(body.latestVersion).toBe("2.7.44");
  });

  test("source checkout check returns guidance without registry work", async () => {
    const response = await call("GET", "/api/update/check?tag=latest");
    expect(response?.status).toBe(200);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.installer).toBe("source");
    expect(body.canUpdate).toBe(false);
  });

  test("source checkout run rejects a worker", async () => {
    // The supervisor check must not preempt the checkout's own refusal, even when the test
    // process itself runs inside a systemd service (a CI runner, for example).
    const response = await call("POST", "/api/update/run", { tag: "latest", restart: false }, {
      dashboardRestartRefusal: () => "must not be consulted",
    });
    expect(response?.status).toBe(409);
    const body = await response!.json() as Record<string, unknown>;
    expect(body.code).toBe("source_checkout");
  });
});

describe("dashboard update restart supervision (#7967)", () => {
  const available = async (channel: "latest" | "preview") => ({
    currentVersion: "2.7.43", latestVersion: "2.7.44", channel,
    installer: "npm" as const, updateAvailable: true, canUpdate: true,
    command: "npm install -g @bitkyc08/opencodex@2.7.44", releaseNotesUrl: "https://example.test/releases",
  });

  test.each([true, false])("a refused supervisor answers 409 before any update job starts (restart=%p)", async restart => {
    const home = mkdtempSync(join(tmpdir(), "ocx-update-supervisor-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    // Hard barriers: a regression must fail here, never launch a real updater.
    const start = spyOn(updateJobModule, "startUpdateJob").mockImplementation(() => { throw new Error("must not start a job"); });
    const spawn = spyOn(updateJobModule, "spawnGuiUpdateWorker").mockImplementation(() => { throw new Error("must not spawn a worker"); });
    try {
      const response = await call("POST", "/api/update/run", { tag: "latest", restart }, {
        checkPackageUpdate: available,
        dashboardRestartRefusal: () => "Dashboard update is unavailable: fixture",
      });
      expect(response?.status).toBe(409);
      expect(await response!.json()).toEqual({ error: "Dashboard update is unavailable: fixture", code: "update_restart_unsupervised" });
      expect(start).not.toHaveBeenCalled();
      expect(spawn).not.toHaveBeenCalled();
      expect(existsSync(updateJobPath())).toBe(false);
    } finally {
      start.mockRestore(); spawn.mockRestore();
      if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(home);
    }
  });

  test("status reports an active job whose worker died as failed, without writing", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-update-status-"));
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    try {
      const now = new Date().toISOString();
      mkdirSync(dirname(updateJobPath()), { recursive: true });
      const persisted = JSON.stringify({
        id: "dead-worker", status: "restarting", startedAt: now, updatedAt: now, pid: 2147483646,
        currentVersion: "2.7.43", latestVersion: "2.7.44", channel: "latest", installer: "npm",
        restart: true, command: "", releaseNotesUrl: "", log: [],
      });
      writeFileSync(updateJobPath(), persisted);
      const response = await call("GET", "/api/update/status?jobId=dead-worker");
      expect(response?.status).toBe(200);
      const body = await response!.json() as { job: { status: string; error?: string } };
      expect(body.job.status).toBe("failed");
      expect(body.job.error).toContain("is no longer running");
      // The next run settles the record under its own start path; a poll never writes it.
      expect(readFileSync(updateJobPath(), "utf8")).toBe(persisted);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
      removeTreeWithRetry(home);
    }
  });
});
