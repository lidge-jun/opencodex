import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

const savedHome = process.env.OPENCODEX_HOME;
let tempHome: string | null = null;

afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedHome;
  if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  tempHome = null;
});

function config(recovery?: OcxConfig["agentTaskRecovery"]): OcxConfig {
  tempHome = mkdtempSync(join(tmpdir(), "ocx-agent-recovery-api-"));
  process.env.OPENCODEX_HOME = tempHome;
  return {
    port: 10100,
    defaultProvider: "openai",
    providers: {},
    ...(recovery ? { agentTaskRecovery: recovery } : {}),
  } as OcxConfig;
}

async function request(current: OcxConfig, method: "GET" | "PUT", body?: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/agent-task-recovery", {
    method,
    headers: {
      Host: "localhost",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : {
      body: JSON.stringify(body),
    }),
  });
  const response = await handleManagementAPI(req, new URL(req.url), current);
  expect(response).not.toBeNull();
  return response!;
}

describe("/api/agent-task-recovery", () => {
  test("reports disabled by default without exposing configuration details", async () => {
    const response = await request(config(), "GET");
    expect(await response.json()).toEqual({ enabled: false });
  });

  test("enables and disables recovery while preserving advanced options", async () => {
    const current = config({ enabled: false, model: "gpt-5.6-terra", timeoutMs: 12_000, cacheEntries: 24 });
    expect(await (await request(current, "PUT", { enabled: true })).json()).toEqual({ ok: true, enabled: true });
    expect(current.agentTaskRecovery).toEqual({ enabled: true, model: "gpt-5.6-terra", timeoutMs: 12_000, cacheEntries: 24 });
    expect(await (await request(current, "GET")).json()).toEqual({ enabled: true });

    await request(current, "PUT", { enabled: false });
    expect(current.agentTaskRecovery).toEqual({ enabled: false, model: "gpt-5.6-terra", timeoutMs: 12_000, cacheEntries: 24 });
  });

  test("rejects malformed or expanded writes without mutating state", async () => {
    const current = config({ enabled: false, timeoutMs: 9_000 });
    for (const body of [{}, { enabled: "true" }, { enabled: true, model: "gpt-5.6-sol" }, []]) {
      const response = await request(current, "PUT", body);
      expect(response.status).toBe(400);
      expect(current.agentTaskRecovery).toEqual({ enabled: false, timeoutMs: 9_000 });
    }
  });
});
