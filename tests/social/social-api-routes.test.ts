import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetSocialPublishingServiceForTests } from "../../src/social/service";
import { handleSocialRoutes } from "../../src/server/management/social-routes";
import type { ManagementContext } from "../../src/server/management/context";

function makeContext(req: Request, url: URL): ManagementContext {
  return {
    req,
    url,
    config: {} as any,
    deps: {} as any,
    convergeCodexCatalog: async () => ({} as any),
    syncClaudeAgentDefsBestEffort: async () => {},
    principal: "gui-session",
    sessionControl: {} as any,
  };
}

describe("social management API routes", () => {
  const prevEnv = process.env.SOCIAL_PUBLISHING_ENABLED;
  const prevDb = process.env.PAO_SOCIAL_DB_PATH;

  beforeEach(() => {
    process.env.PAO_SOCIAL_DB_PATH = join(mkdtempSync(join(tmpdir(), "pao-social-api-")), "social.sqlite");
    process.env.SOCIAL_PUBLISHING_ENABLED = "true";
    resetSocialPublishingServiceForTests();
  });

  afterEach(() => {
    resetSocialPublishingServiceForTests();
    if (prevEnv !== undefined) process.env.SOCIAL_PUBLISHING_ENABLED = prevEnv;
    else delete process.env.SOCIAL_PUBLISHING_ENABLED;
    if (prevDb !== undefined) process.env.PAO_SOCIAL_DB_PATH = prevDb;
    else delete process.env.PAO_SOCIAL_DB_PATH;
  });

  test("GET /api/social/overview returns system status and metrics", async () => {
    const url = new URL("http://localhost:10100/api/social/overview");
    const req = new Request(url);
    const ctx = makeContext(req, url);

    const res = await handleSocialRoutes(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const body = (await res!.json()) as { data: { enabled: boolean; instances_count: number } };
    expect(body.data.enabled).toBe(true);
    expect(body.data.instances_count).toBeGreaterThanOrEqual(1);
  });

  test("mutating route returns 403 when SOCIAL_PUBLISHING_ENABLED is false", async () => {
    delete process.env.SOCIAL_PUBLISHING_ENABLED;
    resetSocialPublishingServiceForTests();

    const url = new URL("http://localhost:10100/api/social/publications");
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_type: "text", master_caption: "Hello" }),
    });
    const ctx = makeContext(req, url);

    const res = await handleSocialRoutes(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toContain("disabled");
  });

  test("POST /api/social/publications creates a publication", async () => {
    const url = new URL("http://localhost:10100/api/social/publications");
    const req = new Request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source_type: "text",
        master_title: "API Created Post",
        master_caption: "Content from API test",
      }),
    });
    const ctx = makeContext(req, url);

    const res = await handleSocialRoutes(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(201);

    const body = (await res!.json()) as { publication: { id: string; master_title: string; status: string } };
    expect(body.publication.id).toBeDefined();
    expect(body.publication.master_title).toBe("API Created Post");
    expect(body.publication.status).toBe("draft");
  });

  test("GET /api/social/accounts returns synced accounts", async () => {
    // First sync via POST
    const syncUrl = new URL("http://localhost:10100/api/social/openpost/instances/main/sync");
    const syncReq = new Request(syncUrl, { method: "POST" });
    await handleSocialRoutes(makeContext(syncReq, syncUrl));

    // Then list via GET
    const url = new URL("http://localhost:10100/api/social/accounts");
    const req = new Request(url);
    const res = await handleSocialRoutes(makeContext(req, url));

    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as { data: Array<{ platform: string }> };
    expect(body.data.length).toBeGreaterThan(0);
  });
});

