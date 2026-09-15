import { describe, expect, test } from "bun:test";
import { handleSecurityRoutes } from "../../src/server/management/security-routes";
import type { ManagementContext } from "../../src/server/management/context";

function mockCtx(method: string, path: string, body?: unknown): ManagementContext {
  const url = new URL(`http://127.0.0.1:10100${path}`);
  const req = new Request(url.toString(), {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    req,
    url,
    config: {} as never,
    deps: {} as never,
    version: "test",
    convergeCodexCatalog: async () => ({} as never),
    syncClaudeAgentDefsBestEffort: async () => {},
  };
}

describe("Security Control Management API Routes", () => {
  test("GET /api/security/overview", async () => {
    const res = await handleSecurityRoutes(mockCtx("GET", "/api/security/overview"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = await res!.json() as { data: { enabled: boolean } };
    expect(typeof data.data.enabled).toBe("boolean");
  });

  test("GET /api/security/authorizations", async () => {
    const res = await handleSecurityRoutes(mockCtx("GET", "/api/security/authorizations"));
    expect(res!.status).toBe(200);
    const data = await res!.json() as { data: unknown[] };
    expect(Array.isArray(data.data)).toBe(true);
  });

  test("GET /api/security/campaigns and tools", async () => {
    const campaigns = await handleSecurityRoutes(mockCtx("GET", "/api/security/campaigns"));
    expect(campaigns!.status).toBe(200);
    const tools = await handleSecurityRoutes(mockCtx("GET", "/api/security/tools"));
    expect(tools!.status).toBe(200);
    const mcp = await handleSecurityRoutes(mockCtx("GET", "/api/security/mcp"));
    expect(mcp!.status).toBe(200);
  });

  test("unrelated paths return null", async () => {
    const res = await handleSecurityRoutes(mockCtx("GET", "/api/skills"));
    expect(res).toBeNull();
  });
});
