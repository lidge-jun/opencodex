import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleZcodeDesktopRoutes } from "../../src/server/management/zcode-desktop-routes";
import type { ManagementContext } from "../../src/server/management/context";

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import { activateDesktopProvider, desktopActivation } from "../../src/server/management/zcode-desktop-activation";
let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-zcode-activation-"));
  previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
const models = [{ id: "builtin:zai-coding-plan/glm-5.3", providerId: "builtin:zai-coding-plan", modelId: "glm-5.3", label: "GLM-5.3" },
  { id: "builtin:zai-coding-plan/glm-5.3-flash", providerId: "builtin:zai-coding-plan", modelId: "glm-5.3-flash", label: "GLM-5.3-Flash" }];
const status = { connected: false, issue: undefined, runtimes: ["/installed/ZCode"], runtime: "/installed/ZCode", workspace: "/project", models, platform: "linux" as const };
function context(path: string, body: unknown, principal?: ManagementContext["principal"]): ManagementContext {
  const req = new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost", "x-opencodex-gui-session": "forged" }, body: JSON.stringify(body) });
  const config = getDefaultConfig();
  const catalog = join(home, "catalog.json");
  return { req, url: new URL(req.url), principal, config,
    deps: { saveConfigPreservingClaudeCode: c => writeFileSync(join(home, "config.json"), JSON.stringify(c)) },
    convergeCodexCatalog: async () => {
      writeFileSync(catalog, JSON.stringify(models.map(m => "zcode/" + m.id.replaceAll("/", "-"))));
      return { status: "committed", changed: true, degraded: false, notices: [] };
    },
  } as ManagementContext;
}
function fixture() {
  let calls = 0;
  const deps = { desktopStatus: () => status, connectDesktop: async () => { calls++; return { ...status, connected: true }; }, disconnectDesktop: async () => { calls++; }, readDesktopCatalogSlugs: () => { try { return JSON.parse(readFileSync(join(home, "catalog.json"), "utf8")); } catch { return []; } } };
  return { deps, calls: () => calls };
}
describe("ZCode Desktop management consent", () => {
  for (const principal of [undefined, "admin-token"] as const) {
    test(`rejects native execution configuration from ${principal ?? "missing"} principal`, async () => {
      const f = fixture();
      for (const action of ["connect", "disconnect", "test"]) {
        const response = await handleZcodeDesktopRoutes(context(`/api/zcode-desktop/${action}`, { consent: true, runtime: "/installed/ZCode", workspace: "/project" }, principal), f.deps);
        expect(response?.status).toBe(403);
      }
      expect(f.calls()).toBe(0);
    });
  }
  test("requires an explicit consent checkbox, not just a GUI session", async () => {
    const f = fixture(); const response = await handleZcodeDesktopRoutes(context("/api/zcode-desktop/connect", { runtime: "/installed/ZCode", workspace: "/project" }, "gui-session"), f.deps);
    expect(response?.status).toBe(400); expect(f.calls()).toBe(0);
  });
  test("connection enables the provider and publishes models without changing defaults", async () => {
    const f = fixture(); const ctx = context("/api/zcode-desktop/connect", { consent: true, runtime: "/installed/ZCode", workspace: "/project" }, "gui-session");
    const before = ctx.config.defaultProvider;
    const response = await handleZcodeDesktopRoutes(ctx, f.deps);
    expect(await response?.json()).toMatchObject({ connected: true, activation: "ready", providerRegistered: true });
    expect(f.calls()).toBe(1);
    expect(ctx.config.defaultProvider).toBe(before);
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).providers.zcode).toMatchObject({ adapter: "zcode", disabled: false, authMode: "local" });
    expect(f.deps.readDesktopCatalogSlugs()).toEqual(models.map(m => "zcode/" + m.id.replaceAll("/", "-")));
  });
  test("oversized setup payload is rejected before runtime execution", async () => {
    const f = fixture(); const response = await handleZcodeDesktopRoutes(context("/api/zcode-desktop/connect", { consent: true, runtime: "x".repeat(14000), workspace: "/project" }, "gui-session"), f.deps);
    expect(response?.status).toBe(400); expect(f.calls()).toBe(0);
  });
});

test("reconnection preserves custom settings and restart observes actual persisted catalog", async () => {
  const f = fixture(), ctx = context("/api/zcode-desktop/connect", {}, "gui-session");
  const custom = { adapter: "zcode" as const, authMode: "local" as const, baseUrl: "https://zcode.z.ai", disabled: true,
    defaultModel: models[0]!.id, note: "custom note", contextWindow: 64000 };
  ctx.config.providers.zcode = custom;
  const connected = { ...status, connected: true };
  await activateDesktopProvider(ctx, connected, f.deps.readDesktopCatalogSlugs);
  await activateDesktopProvider(ctx, connected, f.deps.readDesktopCatalogSlugs);
  expect(ctx.config.providers.zcode).toEqual({ ...custom, disabled: false });
  expect(Object.values(ctx.config.providers).filter(p => p.adapter === "zcode")).toHaveLength(1);
  ctx.config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  expect(desktopActivation(ctx, connected, f.deps.readDesktopCatalogSlugs).activation).toBe("ready");
  rmSync(join(home, "catalog.json"));
  expect(desktopActivation(ctx, connected, f.deps.readDesktopCatalogSlugs).activation).toBe("catalog_pending");
});

test("registration failure rolls back config, preserves protocol state and allows retry", async () => {
  const f = fixture(), ctx = context("/api/zcode-desktop/connect", {}, "gui-session");
  const save = ctx.deps.saveConfigPreservingClaudeCode;
  ctx.deps.saveConfigPreservingClaudeCode = () => { throw new Error("private profile content"); };
  const connected = { ...status, connected: true };
  const result = await activateDesktopProvider(ctx, connected, f.deps.readDesktopCatalogSlugs);
  expect(result).toMatchObject({ connected: true, activation: "provider_pending", error: "provider_registration_failed" });
  expect(JSON.stringify(result)).not.toContain("private profile content");
  expect(ctx.config.providers.zcode).toBeUndefined();
  ctx.deps.saveConfigPreservingClaudeCode = save;
  expect((await activateDesktopProvider(ctx, connected, f.deps.readDesktopCatalogSlugs)).activation).toBe("ready");
});

test("failed or skipped catalog and committed-but-missing models remain partial", async () => {
  const f = fixture(), ctx = context("/api/zcode-desktop/connect", {}, "gui-session");
  const converge = ctx.convergeCodexCatalog, connected = { ...status, connected: true };
  for (const outcome of [
    { status: "skipped", reason: "busy", retryable: true },
    { status: "failed", reason: "disk", phase: "commit", retryable: true, partialWrite: true },
    { status: "committed", changed: false, degraded: true, notices: [] },
  ] as const) {
    ctx.convergeCodexCatalog = async () => outcome;
    expect(await activateDesktopProvider(ctx, connected, f.deps.readDesktopCatalogSlugs)).toMatchObject({
      connected: true, providerRegistered: true, activation: "catalog_pending", error: "catalog_update_failed",
    });
  }
  ctx.convergeCodexCatalog = converge;
  expect((await activateDesktopProvider(ctx, connected, f.deps.readDesktopCatalogSlugs)).activation).toBe("ready");
});

test("a different provider occupying zcode is never overwritten", async () => {
  const f = fixture(), ctx = context("/api/zcode-desktop/connect", {}, "gui-session");
  ctx.config.providers.zcode = { adapter: "openai-chat", baseUrl: "https://example.invalid" };
  const before = structuredClone(ctx.config.providers);
  expect((await activateDesktopProvider(ctx, { ...status, connected: true }, f.deps.readDesktopCatalogSlugs)).activation).toBe("provider_pending");
  expect(ctx.config.providers).toEqual(before);
});
