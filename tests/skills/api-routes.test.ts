import { describe, expect, test } from "bun:test";
import { handleSkillRoutes } from "../../src/server/management/skill-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { getSkillControlService } from "../../src/skills";

function mockCtx(method: string, path: string, body?: any): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const req = new Request(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });

  return {
    req,
    url,
    config: {} as any,
    deps: {} as any,
    version: "2.56.0",
    convergeCodexCatalog: async () => ({} as any),
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

describe("Skill Control Management API Routes", () => {
  test("GET /api/skills returns skills list", async () => {
    const res = await handleSkillRoutes(mockCtx("GET", "/api/skills"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = await res!.json();
    expect(Array.isArray(data.data)).toBe(true);
  });

  test("GET /api/skill-sources returns registered sources", async () => {
    const res = await handleSkillRoutes(mockCtx("GET", "/api/skill-sources"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = await res!.json();
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data.length).toBeGreaterThan(0);
  });

  test("GET /api/skill-marketplace/search searches marketplace catalog", async () => {
    const res = await handleSkillRoutes(mockCtx("GET", "/api/skill-marketplace/search?q=postgres"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = await res!.json();
    expect(Array.isArray(data.data)).toBe(true);
    expect(data.data.some((d: any) => d.id === "postgres-migration")).toBe(true);
  });

  test("GET /api/skill-agents and POST /api/skill-agents/detect", async () => {
    const listRes = await handleSkillRoutes(mockCtx("GET", "/api/skill-agents"));
    expect(listRes!.status).toBe(200);

    const detRes = await handleSkillRoutes(mockCtx("POST", "/api/skill-agents/detect"));
    expect(detRes!.status).toBe(200);
  });

  test("GET /api/skill-nodes returns nodes list", async () => {
    const res = await handleSkillRoutes(mockCtx("GET", "/api/skill-nodes"));
    expect(res!.status).toBe(200);
    const data = await res!.json();
    expect(data.data.some((n: any) => n.id === "local")).toBe(true);
  });

  test("GET /api/skill-audit returns audit logs", async () => {
    const res = await handleSkillRoutes(mockCtx("GET", "/api/skill-audit"));
    expect(res!.status).toBe(200);
    const data = await res!.json();
    expect(Array.isArray(data.data)).toBe(true);
  });
});

