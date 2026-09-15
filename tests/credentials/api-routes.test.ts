import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCredentialRoutes } from "../../src/server/management/credential-routes";
import { resetCredentialRuntimeServiceForTests } from "../../src/credentials/service";
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

describe("Credential Runtime Management API Routes", () => {
  const prevFlag = process.env.CREDENTIAL_RUNTIME_ENABLED;
  const prevDb = process.env.PAO_CREDENTIAL_DB_PATH;
  const prevKey = process.env.CREDENTIAL_MASTER_KEY;

  afterEach(() => {
    if (prevFlag === undefined) delete process.env.CREDENTIAL_RUNTIME_ENABLED;
    else process.env.CREDENTIAL_RUNTIME_ENABLED = prevFlag;
    if (prevDb === undefined) delete process.env.PAO_CREDENTIAL_DB_PATH;
    else process.env.PAO_CREDENTIAL_DB_PATH = prevDb;
    if (prevKey === undefined) delete process.env.CREDENTIAL_MASTER_KEY;
    else process.env.CREDENTIAL_MASTER_KEY = prevKey;
    resetCredentialRuntimeServiceForTests();
  });

  function isolateDb(): void {
    process.env.PAO_CREDENTIAL_DB_PATH = join(mkdtempSync(join(tmpdir(), "crd-api-")), "credentials.sqlite");
    process.env.CREDENTIAL_MASTER_KEY = process.env.CREDENTIAL_MASTER_KEY || "unit-api-master-key";
    resetCredentialRuntimeServiceForTests();
  }

  test("GET /api/credentials/overview", async () => {
    isolateDb();
    const res = await handleCredentialRoutes(mockCtx("GET", "/api/credentials/overview"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const data = await res!.json() as { data: { enabled: boolean; total: number } };
    expect(typeof data.data.enabled).toBe("boolean");
    expect(typeof data.data.total).toBe("number");
  });

  test("GET /api/credentials and providers", async () => {
    isolateDb();
    const list = await handleCredentialRoutes(mockCtx("GET", "/api/credentials"));
    expect(list!.status).toBe(200);
    const listed = await list!.json() as { data: unknown[] };
    expect(Array.isArray(listed.data)).toBe(true);

    const providers = await handleCredentialRoutes(mockCtx("GET", "/api/credentials/providers"));
    expect(providers!.status).toBe(200);
    const body = await providers!.json() as { data: Array<{ slug: string }> };
    expect(body.data.some(p => p.slug === "local")).toBe(true);
  });

  test("POST /api/credentials is 403 when flag off", async () => {
    isolateDb();
    delete process.env.CREDENTIAL_RUNTIME_ENABLED;
    const res = await handleCredentialRoutes(mockCtx("POST", "/api/credentials", {
      provider: "local",
      name: "x",
      secret: ["local", "demo"].join("-"),
    }));
    expect(res!.status).toBe(403);
  });

  test("unrelated paths return null; unmatched credential paths 404", async () => {
    isolateDb();
    const unrelated = await handleCredentialRoutes(mockCtx("GET", "/api/security/overview"));
    expect(unrelated).toBeNull();
    const missing = await handleCredentialRoutes(mockCtx("GET", "/api/credentials/oauth"));
    expect(missing!.status).toBe(404);
  });

  test("GET list never includes a long plaintext secret", async () => {
    isolateDb();
    process.env.CREDENTIAL_RUNTIME_ENABLED = "true";
    process.env.CREDENTIAL_MASTER_KEY = "unit-api-master-key";
    resetCredentialRuntimeServiceForTests();
    const secret = ["local", "plaintext", "must", "not", "leak"].join("-");
    const created = await handleCredentialRoutes(mockCtx("POST", "/api/credentials", {
      provider: "local",
      name: "listed",
      secret,
      actor: "operator",
    }));
    expect(created!.status).toBe(201);
    const list = await handleCredentialRoutes(mockCtx("GET", "/api/credentials"));
    const dumped = JSON.stringify(await list!.json());
    expect(dumped).not.toContain(secret);
  });
});

