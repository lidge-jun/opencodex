import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import type { OcxConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { drainAndRemoveFixtureRoots } from "../helpers/fixture-teardown";
import { remoteConfig } from "../helpers/management-auth-fixture";

const keys = ["OPENCODEX_HOME", "CODEX_HOME", "OPENCODEX_API_AUTH_TOKEN", "OPENCODEX_ADMIN_AUTH_TOKEN"] as const;
let previous: Record<string, string | undefined>;
let home: string;

beforeEach(() => {
  previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  home = mkdtempSync(join(tmpdir(), "ocx-reviewer-admission-"));
  process.env.OPENCODEX_HOME = home;
  process.env.CODEX_HOME = home;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
  saveConfig(remoteConfig());
});

afterEach(async () => {
  await drainAndRemoveFixtureRoots({ roots: [{ path: home }], restoreEnvironment: () => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  } });
});

test("reviewer settings authenticate at the listener before mutation, save or convergence", async () => {
  let saves = 0, convergences = 0;
  let saved: OcxConfig | undefined;
  const server = startServer(0, { managementApi: {
    saveConfigPreservingClaudeCode: config => { saves++; saved = structuredClone(config); },
    createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences++; }),
  } });
  try {
    const url = new URL("/api/auto-review-settings", server.url);
    const request = (method: "GET" | "PUT", token?: string) => fetch(url, {
      method,
      headers: { origin: url.origin, ...(token ? { "x-opencodex-api-key": token } : {}),
        ...(method === "PUT" ? { "content-type": "application/json" } : {}) },
      ...(method === "PUT" ? { body: JSON.stringify({ enabled: true, model: "test/gpt-test" }) } : {}),
    });
    for (const token of [undefined, "wrong-token", "data-secret"]) {
      for (const method of ["GET", "PUT"] as const) {
        const denied = await request(method, token);
        expect(denied.status).toBe(401);
        await denied.arrayBuffer();
      }
    }
    expect(saves).toBe(0);
    expect(convergences).toBe(0);
    const initial = await request("GET", "admin-secret");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ enabled: false, model: "" });
    const applied = await request("PUT", "admin-secret");
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({ ok: true, enabled: true, model: "test/gpt-test" });
    expect(saves).toBe(1);
    expect(convergences).toBe(1);
    expect(saved?.autoReviewOverride).toEqual({ enabled: true, model: "test/gpt-test" });
    const reread = await request("GET", "admin-secret");
    expect(await reread.json()).toEqual({ enabled: true, model: "test/gpt-test" });
  } finally {
    await server.stop(true);
  }
});
