/**
 * GET/PUT /api/subagent-roles: atomic validation, roster union warnings, routed-on-v2.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig, OcxSubagentRole } from "../src/types";
import { ManagementRequest as Request } from "./helpers/management-auth";

const savedHome = process.env.OPENCODEX_HOME;
let tempHome: string | null = null;

afterEach(() => {
  if (savedHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = savedHome;
  if (tempHome) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = null;
  }
});

function isolatedHome(): void {
  tempHome = mkdtempSync(join(tmpdir(), "ocx-subagent-roles-api-"));
  process.env.OPENCODEX_HOME = tempHome;
}

const sampleRole: OcxSubagentRole = {
  id: "reviewer",
  description: "PR review",
  model: "anthropic/claude-sonnet-5",
  effort: "high",
  developerInstructions: "Review the diff for regressions.",
  enabled: true,
};

function makeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    subagentModels: ["gpt-5.5", "gpt-5.6-sol"],
    ...overrides,
  } as OcxConfig;
}

async function put(config: OcxConfig, body: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/subagent-roles", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const res = await handleManagementAPI(req, new URL(req.url), config);
  expect(res).not.toBeNull();
  return res!;
}

async function get(config: OcxConfig): Promise<Response> {
  const req = new Request("http://localhost/api/subagent-roles");
  const res = await handleManagementAPI(req, new URL(req.url), config);
  expect(res).not.toBeNull();
  return res!;
}

describe("/api/subagent-roles atomic validation", () => {
  test("PUT invalid id returns 400 and leaves previous config unchanged", async () => {
    isolatedHome();
    const previous = [sampleRole];
    const config = makeConfig({ subagentRoles: [...previous] });

    const res = await put(config, {
      roles: [{ ...sampleRole, id: "Reviewer" }],
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/id/i);
    expect(config.subagentRoles).toEqual(previous);
    expect(config.subagentModels).toEqual(["gpt-5.5", "gpt-5.6-sol"]);
  });

  test("PUT 9 roles returns 400 without truncating the previous catalog", async () => {
    isolatedHome();
    const previous = [sampleRole];
    const config = makeConfig({ subagentRoles: [...previous] });
    const roles = Array.from({ length: 9 }, (_, i) => ({ ...sampleRole, id: `role-${i}` }));
    const res = await put(config, { roles });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.stringContaining("8") });
    expect(config.subagentRoles).toEqual(previous);
  });

  test("PUT a routed model on v2 without keepNativeChatGptOnV1 records a warning", async () => {
    isolatedHome();
    const config = makeConfig({ multiAgentMode: "v2" });
    const res = await put(config, { roles: [sampleRole] });
    expect(res.status).toBe(200);
    const body = await res.json() as { ok: boolean; roles: OcxSubagentRole[]; warnings: string[] };
    expect(body.ok).toBe(true);
    expect(body.roles).toEqual([expect.objectContaining({ id: "reviewer" })]);
    expect(body.warnings.some(warning => /routed|v2|#92/i.test(warning))).toBe(true);
    expect(config.subagentRoles?.[0]?.id).toBe("reviewer");
  });

  test("GET returns available models like injection-model", async () => {
    isolatedHome();
    const config = makeConfig({ subagentRoles: [sampleRole] });
    const res = await get(config);
    expect(res.status).toBe(200);
    const body = await res.json() as {
      roles: OcxSubagentRole[];
      available: Array<{ provider?: string; model?: string; namespaced?: string } | string>;
      efforts: string[];
    };
    expect(body.roles).toEqual([expect.objectContaining({ id: "reviewer" })]);
    expect(Array.isArray(body.available)).toBe(true);
    expect(body.available.length).toBeGreaterThan(0);
    expect(body.efforts).toContain("high");
  });

  test("PUT unions enabled role models into subagentModels and warns when truncated", async () => {
    isolatedHome();
    const config = makeConfig({
      subagentModels: ["gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.4-mini"],
    });
    const roles = [
      { ...sampleRole, id: "a", model: "m-1" },
      { ...sampleRole, id: "b", model: "m-2" },
      { ...sampleRole, id: "c", model: "m-3" },
      { ...sampleRole, id: "d", model: "m-4" },
      { ...sampleRole, id: "e", model: "m-5" },
      { ...sampleRole, id: "f", model: "m-6" },
    ];
    const res = await put(config, { roles });
    expect(res.status).toBe(200);
    const body = await res.json() as { warnings: string[] };
    expect(config.subagentModels).toEqual(["m-1", "m-2", "m-3", "m-4", "m-5"]);
    expect(body.warnings.some(warning => warning.includes("f"))).toBe(true);
  });

  test("PUT remove deletes one id from the live catalog without a client snapshot", async () => {
    isolatedHome();
    const explorer = { ...sampleRole, id: "explorer", description: "search" };
    const config = makeConfig({ subagentRoles: [sampleRole, explorer] });
    const res = await put(config, { remove: "reviewer" });
    expect(res.status).toBe(200);
    expect(config.subagentRoles).toEqual([expect.objectContaining({ id: "explorer" })]);
    expect(await res.json()).toMatchObject({
      ok: true,
      roles: [expect.objectContaining({ id: "explorer" })],
    });
  });

  test("PUT openrouter/gpt-* on v2 records the routed warning", async () => {
    isolatedHome();
    const config = makeConfig({ multiAgentMode: "v2" });
    const res = await put(config, {
      roles: [{ ...sampleRole, model: "openrouter/gpt-5.4" }],
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { warnings: string[] };
    expect(body.warnings.some(warning => /routed|v2|#92/i.test(warning))).toBe(true);
  });
});
