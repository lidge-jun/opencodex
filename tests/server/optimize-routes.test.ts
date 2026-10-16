import { describe, expect, test } from "bun:test";
import { handleOptimizeRoutes, getOptimizeSettings } from "../../src/server/management/optimize-routes";
import type { OcxConfig } from "../../src/types/config";
import type { ManagementContext } from "../../src/server/management/context";

describe("Management optimize routes (/api/optimize)", () => {
  test("GET /api/optimize returns defaults", async () => {
    const config: OcxConfig = { port: 3000 };
    const ctx = {
      url: new URL("http://localhost:3000/api/optimize"),
      req: new Request("http://localhost:3000/api/optimize", { method: "GET" }),
      config,
      deps: {},
    } as unknown as ManagementContext;

    const res = await handleOptimizeRoutes(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const body = await res!.json() as Record<string, unknown>;
    expect(body.rtkEnabled).toBe(true);
    expect(body.headroomEnabled).toBe(false);
    expect(body.headroomUrl).toBe("http://localhost:8787");
    expect(body.ponytailEnabled).toBe(false);
    expect(body.ponytailLevel).toBe("full");
  });

  test("PATCH /api/optimize updates settings", async () => {
    const config: OcxConfig = { port: 3000 };
    const payload = {
      rtkEnabled: false,
      headroomEnabled: true,
      headroomUrl: "http://127.0.0.1:9090",
      ponytailEnabled: true,
      ponytailLevel: "ultra",
    };

    const ctx = {
      url: new URL("http://localhost:3000/api/optimize"),
      req: new Request("http://localhost:3000/api/optimize", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      config,
      deps: {},
    } as unknown as ManagementContext;

    const res = await handleOptimizeRoutes(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const settings = getOptimizeSettings(config);
    expect(settings.rtkEnabled).toBe(false);
    expect(settings.headroomEnabled).toBe(true);
    expect(settings.headroomUrl).toBe("http://127.0.0.1:9090");
    expect(settings.ponytailEnabled).toBe(true);
    expect(settings.ponytailLevel).toBe("ultra");
  });

  test("POST /api/optimize/test runs RTK test sandbox", async () => {
    const config: OcxConfig = { port: 3000 };
    const sampleDiff = [
      "diff --git a/test.ts b/test.ts",
      "--- a/test.ts",
      "+++ b/test.ts",
      "@@ -1,150 +1,150 @@",
      ...Array.from({ length: 150 }, (_, i) => `+line ${i} test payload exceeding 500 bytes`),
    ].join("\n");

    const ctx = {
      url: new URL("http://localhost:3000/api/optimize/test"),
      req: new Request("http://localhost:3000/api/optimize/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: sampleDiff }),
      }),
      config,
      deps: {},
    } as unknown as ManagementContext;

    const res = await handleOptimizeRoutes(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);

    const body = await res!.json() as { filter: string; saved: number; originalLength: number; compressedLength: number };
    expect(body.filter).toBe("git-diff");
    expect(body.saved).toBeGreaterThan(0);
    expect(body.compressedLength).toBeLessThan(body.originalLength);
  });

  test("POST /api/optimize/headroom/start rejects non-loopback url", async () => {
    const config: OcxConfig = {
      port: 3000,
      optimize: { headroomUrl: "https://remote-headroom.example.com" },
    };
    const ctx = {
      url: new URL("http://localhost:3000/api/optimize/headroom/start"),
      req: new Request("http://localhost:3000/api/optimize/headroom/start", {
        method: "POST",
      }),
      config,
      deps: {},
    } as unknown as ManagementContext;

    const res = await handleOptimizeRoutes(ctx);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(400);

    const body = await res!.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("loopback");
  });
});
