import { describe, expect, test } from "bun:test";
import { handleAdvisorRoutes, parseAdvisorSettingsPatch } from "../../src/server/management/advisor-routes";
import type { ManagementContext } from "../../src/server/management/context";
import type { OcxConfig } from "../../src/types";

function makeCtx(config: OcxConfig, method: string, body?: unknown): { ctx: ManagementContext; saved: OcxConfig[] } {
  const saved: OcxConfig[] = [];
  const ctx: ManagementContext = {
    req: new Request("http://localhost/api/advisor/settings", {
      method,
      ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}),
    }),
    url: new URL("http://localhost/api/advisor/settings"),
    config,
    deps: {
      saveConfigPreservingClaudeCode: cfg => {
        saved.push(cfg);
      },
    },
    version: "test",
  };
  return { ctx, saved };
}

const baseConfig = (): OcxConfig => ({
  port: 10100,
  providers: {},
}) as OcxConfig;

describe("GET /api/advisor/settings", () => {
  test("returns resolved settings with defaults and availability", async () => {
    const { ctx } = makeCtx(baseConfig(), "GET");
    const response = await handleAdvisorRoutes(ctx);
    expect(response).not.toBeNull();
    const body = await response!.json() as { settings: { enabled: boolean; policy: string }; runnable: boolean };
    expect(body.settings.enabled).toBe(false);
    expect(body.settings.policy).toBe("manual");
    expect(body.runnable).toBe(false);
  });

  test("flags enabled-without-model as a warning the GUI can show", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true };
    const { ctx } = makeCtx(config, "GET");
    const body = await (await handleAdvisorRoutes(ctx))!.json() as { warning?: string; runnable: boolean };
    expect(body.warning).toBe("advisor_enabled_without_model");
    expect(body.runnable).toBe(false);
  });

  test("other paths and methods return null for the dispatcher", async () => {
    const { ctx } = makeCtx(baseConfig(), "DELETE");
    expect(await handleAdvisorRoutes(ctx)).toBeNull();
  });
});

describe("PUT /api/advisor/settings", () => {
  test("partial patch persists in memory and through the locked writer", async () => {
    const config = baseConfig();
    const { ctx, saved } = makeCtx(config, "PUT", { enabled: true, model: "expert/gpt-6-astra" });
    const response = await handleAdvisorRoutes(ctx);
    const body = await response!.json() as { settings: { enabled: boolean; model: string }; runnable: boolean };
    expect(body.settings.enabled).toBe(true);
    expect(body.settings.model).toBe("expert/gpt-6-astra");
    expect(body.runnable).toBe(true);
    expect(saved).toHaveLength(1);
    // In-memory and persisted state agree.
    expect((config as { advisor?: { model?: string } }).advisor?.model).toBe("expert/gpt-6-astra");
  });

  test("patches merge into an existing advisor block instead of replacing it", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true, model: "keep/me", effort: "high" };
    const { ctx } = makeCtx(config, "PUT", { policy: "preflight" });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as { settings: { model: string; effort: string; policy: string } };
    expect(body.settings.model).toBe("keep/me");
    expect(body.settings.effort).toBe("high");
    expect(body.settings.policy).toBe("preflight");
  });

  test("invalid values are refused with a named field and nothing is saved", async () => {
    for (const bad of [
      { effort: "ultra-plus" },
      { policy: "adaptive" },
      { model: 42 },
      { enabled: "yes" },
      { unknown: true },
      { timeoutMs: 5 },
    ]) {
      const config = baseConfig();
      const { ctx, saved } = makeCtx(config, "PUT", bad);
      const response = await handleAdvisorRoutes(ctx);
      expect(response!.status).toBe(400);
      const body = await response!.json() as { error: { code: string; message: string } };
      expect(body.error.code).toMatch(/^invalid_|^unknown_field$/);
      expect(saved).toHaveLength(0);
    }
  });

  test("reset restores the disabled default and persists", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: true, model: "x/y" };
    const { ctx, saved } = makeCtx(config, "PUT", { reset: true });
    const body = await (await handleAdvisorRoutes(ctx))!.json() as { settings: { enabled: boolean } };
    expect(body.settings.enabled).toBe(false);
    expect(saved).toHaveLength(1);
    expect((config as { advisor?: unknown }).advisor).toBeUndefined();
  });

  test("a failed save restores the in-memory snapshot", async () => {
    const config = baseConfig();
    (config as { advisor?: unknown }).advisor = { enabled: false };
    const saved: OcxConfig[] = [];
    const ctx: ManagementContext = {
      req: new Request("http://localhost/api/advisor/settings", {
        method: "PUT",
        body: JSON.stringify({ enabled: true }),
        headers: { "content-type": "application/json" },
      }),
      url: new URL("http://localhost/api/advisor/settings"),
      config,
      deps: {
        saveConfigPreservingClaudeCode: () => {
          throw new Error("disk full");
        },
      },
      version: "test",
    };
    void saved;
    const response = await handleAdvisorRoutes(ctx);
    expect(response!.status).toBe(500);
    expect((config as { advisor?: { enabled?: boolean } }).advisor?.enabled).toBe(false);
  });
});

describe("parseAdvisorSettingsPatch (strict validation)", () => {
  test("valid patches pass through", () => {
    expect(parseAdvisorSettingsPatch({ enabled: true, model: " m/n ", effort: "low", policy: "manual", timeoutMs: 5000 }))
      .toEqual({ ok: true, patch: { enabled: true, model: "m/n", effort: "low", policy: "manual", timeoutMs: 5000 } });
  });
  test("empty body and non-object bodies are refused", () => {
    expect(parseAdvisorSettingsPatch({}).ok).toBe(false);
    expect(parseAdvisorSettingsPatch("x").ok).toBe(false);
    expect(parseAdvisorSettingsPatch([]).ok).toBe(false);
  });
});
