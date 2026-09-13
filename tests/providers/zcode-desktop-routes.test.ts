import { handleZcodeAccountRoutes, resetZcodeAccountJobsForTests } from "../../src/server/management/zcode-account-routes";
import { allocateAccount, listAccounts, accountProfile, writeAccount } from "../../src/adapters/zcode/accounts";
import { defaultDesktopWorkspace } from "../../src/adapters/zcode/desktop";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleZcodeDesktopRoutes } from "../../src/server/management/zcode-desktop-routes";
import type { ManagementContext } from "../../src/server/management/context";

import { mkdtempSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig } from "../../src/config";
import { activateDesktopProvider, desktopActivation } from "../../src/server/management/zcode-desktop-activation";
import { handleProviderRoutes } from "../../src/server/management/provider-routes";
let home: string;
let previousHome: string | undefined;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-zcode-activation-"));
  previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
});
afterEach(() => {
  resetZcodeAccountJobsForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});
const models = [{ id: "builtin:zai-coding-plan/glm-5.3", providerId: "builtin:zai-coding-plan", modelId: "glm-5.3", label: "GLM-5.3" },
  { id: "builtin:zai-coding-plan/glm-5.3-flash", providerId: "builtin:zai-coding-plan", modelId: "glm-5.3-flash", label: "GLM-5.3-Flash" }];
const status = { connected: false, issue: undefined, runtimes: ["/installed/ZCode"], runtime: "/installed/ZCode", workspace: "/project", models, platform: "linux" as const };
function context(path: string, body: unknown, principal?: ManagementContext["principal"], method = "POST"): ManagementContext {
  const req = new Request(`http://localhost${path}`, { method, headers: { "content-type": "application/json", origin: "http://localhost", "x-opencodex-gui-session": "forged" },
    ...(method === "GET" ? {} : { body: JSON.stringify(body) }) });
  const config = getDefaultConfig();
  const catalog = join(home, "catalog.json");
  return { req, url: new URL(req.url), principal, config,
    deps: { saveConfigPreservingClaudeCode: c => writeFileSync(join(home, "config.json"), JSON.stringify(c)) },
    convergeCodexCatalog: async () => {
      const slugs = Object.entries(config.providers).filter(([, provider]) => provider.adapter === "zcode" && provider.disabled !== true)
        .flatMap(([name]) => models.map(model => name + "/" + model.id.replaceAll("/", "-")));
      writeFileSync(catalog, JSON.stringify(slugs));
      return { status: "committed", changed: true, degraded: false, notices: [] };
    },
  } as ManagementContext;
}
function fixture() {
  let calls = 0;
  const probed: string[] = [];
  const deps = { desktopStatus: () => status, connectDesktop: async () => { calls++; return { ...status, connected: true }; },
    disconnectDesktop: async () => { calls++; }, verifyDesktopProtocol: async (model: string) => { probed.push(model); },
    readDesktopCatalogSlugs: () => { try { return JSON.parse(readFileSync(join(home, "catalog.json"), "utf8")); } catch { return []; } } };
  return { deps, calls: () => calls, probed: () => probed };
}
describe("ZCode Desktop management consent", () => {
  for (const principal of [undefined, "admin-token"] as const) {
    test(`rejects native execution configuration from ${principal ?? "missing"} principal`, async () => {
      const f = fixture();
      for (const action of ["connect", "activate", "disconnect", "test"]) {
        const response = await handleZcodeDesktopRoutes(context(`/api/zcode-desktop/${action}`, { consent: true, runtime: "/installed/ZCode", workspace: "/project" }, principal), f.deps);
        expect(response?.status).toBe(403);
      }
      expect(f.calls()).toBe(0);
    });
    test(`rejects Desktop path discovery from ${principal ?? "missing"} principal`, async () => {
      const f = fixture();
      for (const path of ["/api/zcode-desktop", "/api/zcode-desktop/folders"]) {
        const response = await handleZcodeDesktopRoutes(context(path, {}, principal, "GET"), f.deps);
        expect(response?.status).toBe(403);
        expect(await response?.json()).toEqual({ error: "dashboard_required" });
      }
      expect(f.calls()).toBe(0);
    });
  }
  test("GUI sessions can inspect Desktop status without triggering native execution", async () => {
    const f = fixture();
    const response = await handleZcodeDesktopRoutes(context("/api/zcode-desktop", {}, "gui-session", "GET"), f.deps);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ connected: false, activation: "disconnected" });
    expect(f.calls()).toBe(0);
  });
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
  test("optional verification uses protocol metadata without starting an inference turn", async () => {
    const f = fixture();
    f.deps.desktopStatus = () => ({ ...status, connected: true });
    const response = await handleZcodeDesktopRoutes(context("/api/zcode-desktop/test", {
      consent: true, model: models[0]!.id,
    }, "gui-session"), f.deps);
    expect(await response?.json()).toEqual({ ok: true });
    expect(f.probed()).toEqual([models[0]!.id]);
    expect(f.calls()).toBe(0);
  });
  test("protocol verification failures stay bounded and never expose runtime details", async () => {
    const f = fixture();
    f.deps.desktopStatus = () => ({ ...status, connected: true });
    f.deps.verifyDesktopProtocol = async () => { throw new Error("private runtime and profile path"); };
    const response = await handleZcodeDesktopRoutes(context("/api/zcode-desktop/test", {
      consent: true, model: models[0]!.id,
    }, "gui-session"), f.deps);
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ error: "protocol_failed" });
  });
});

test("generic ZCode provider test reports an empty local catalog as a failure", async () => {
  const zcodeHome = join(home, "advanced-home");
  const workspace = join(home, "workspace");
  mkdirSync(join(zcodeHome, ".zcode/cli"), { recursive: true }); mkdirSync(workspace);
  writeFileSync(join(zcodeHome, ".zcode/cli/config.json"), JSON.stringify({ provider: {} }));
  const keys = ["OCX_ZCODE_NATIVE_TOOLS", "OCX_ZCODE_COMMAND", "OCX_ZCODE_HOME", "OCX_ZCODE_WORKSPACE"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.OCX_ZCODE_NATIVE_TOOLS = "1";
    process.env.OCX_ZCODE_COMMAND = JSON.stringify(["/fixture-launcher"]);
    process.env.OCX_ZCODE_HOME = zcodeHome;
    process.env.OCX_ZCODE_WORKSPACE = workspace;
    const ctx = context("/api/providers/test?name=zcode", {}, "gui-session");
    ctx.config.providers.zcode = { adapter: "zcode", authMode: "local", baseUrl: "https://zcode.z.ai" };
    const result = await (await handleProviderRoutes(ctx))?.json();
    expect(result).toEqual({ ok: false, models: 0, latencyMs: 0, error: "ZCode local catalog has no available models." });
    expect(result).not.toHaveProperty("message");
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
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

test("activation readiness follows selected and disabled model visibility", () => {
  const ctx = context("/api/zcode-desktop/activate", {}, "gui-session");
  const connected = { ...status, connected: true };
  ctx.config.providers.zcode = { adapter: "zcode", authMode: "local", baseUrl: "https://zcode.z.ai",
    selectedModels: [models[0]!.id] };
  const firstSlug = "zcode/" + models[0]!.id.replaceAll("/", "-");
  const secondSlug = "zcode/" + models[1]!.id.replaceAll("/", "-");
  expect(desktopActivation(ctx, connected, () => [firstSlug])).toMatchObject({ activation: "ready" });

  delete ctx.config.providers.zcode.selectedModels;
  ctx.config.disabledModels = [firstSlug];
  expect(desktopActivation(ctx, connected, () => [secondSlug])).toMatchObject({ activation: "ready" });
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

test("disconnect disables the provider, preserves customization and removes its catalog rows", async () => {
  const f = fixture(), ctx = context("/api/zcode-desktop/disconnect", {}, "gui-session");
  const beforeDefault = ctx.config.defaultProvider;
  ctx.config.providers.zcode = { adapter: "zcode", authMode: "local", baseUrl: "https://zcode.z.ai",
    disabled: false, defaultModel: models[0]!.id, note: "keep custom settings", contextWindow: 64_000 };
  await ctx.convergeCodexCatalog();
  expect(f.deps.readDesktopCatalogSlugs()).toHaveLength(2);
  const response = await handleZcodeDesktopRoutes(ctx, f.deps);
  expect(await response?.json()).toMatchObject({ connected: false, activation: "disconnected", providerRegistered: false });
  expect(ctx.config.providers.zcode).toEqual({ adapter: "zcode", authMode: "local", baseUrl: "https://zcode.z.ai",
    disabled: true, defaultModel: models[0]!.id, note: "keep custom settings", contextWindow: 64_000 });
  expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).providers.zcode.disabled).toBe(true);
  expect(f.deps.readDesktopCatalogSlugs()).toEqual([]);
  expect(ctx.config.defaultProvider).toBe(beforeDefault);
});

test("Desktop disconnect holds the activation transition lock until cleanup finishes", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.deps.disconnectDesktop = async () => { entered(); await gate; };
  const disconnect = handleZcodeDesktopRoutes(
    context("/api/zcode-desktop/disconnect", {}, "gui-session"), f.deps,
  );
  await started;
  const overlapping = await handleZcodeDesktopRoutes(context("/api/zcode-desktop/connect", {
    consent: true, runtime: "/installed/ZCode", workspace: "/project",
  }, "gui-session"), f.deps);
  expect(overlapping?.status).toBe(409);
  expect(await overlapping?.json()).toEqual({ error: "busy" });
  expect(f.calls()).toBe(0);
  release();
  expect((await disconnect)?.status).toBe(200);
});

test("partial disconnect cleanup is explicit and idempotently retryable", async () => {
  const f = fixture(), ctx = context("/api/zcode-desktop/disconnect", {}, "gui-session");
  ctx.config.providers.zcode = { adapter: "zcode", authMode: "local", baseUrl: "https://zcode.z.ai", disabled: false };
  await ctx.convergeCodexCatalog();
  const converge = ctx.convergeCodexCatalog;
  ctx.convergeCodexCatalog = async () => ({ status: "failed", reason: "disk", phase: "commit", retryable: true, partialWrite: false });
  expect(await (await handleZcodeDesktopRoutes(ctx, f.deps))?.json()).toMatchObject({
    connected: false, providerRegistered: false, error: "catalog_update_failed",
  });
  expect(f.deps.readDesktopCatalogSlugs()).toHaveLength(2);
  ctx.convergeCodexCatalog = converge;
  const retry = context("/api/zcode-desktop/disconnect", {}, "gui-session");
  ctx.req = retry.req; ctx.url = retry.url;
  expect(await (await handleZcodeDesktopRoutes(ctx, f.deps))?.json()).toMatchObject({
    connected: false, providerRegistered: false, activation: "disconnected",
  });
  expect(f.deps.readDesktopCatalogSlugs()).toEqual([]);
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

test("ambiguous legacy ZCode bindings are not collapsed or overwritten", async () => {
  const f = fixture(), ctx = context("/api/zcode-desktop/connect", {}, "gui-session");
  const first = { adapter: "zcode" as const, authMode: "local" as const, baseUrl: "https://zcode.z.ai", disabled: true, note: "canonical" };
  const second = { ...first, note: "legacy alias" };
  ctx.config.providers.zcode = first;
  ctx.config.providers["zcode-legacy"] = second;
  const before = structuredClone(ctx.config.providers);
  expect(await activateDesktopProvider(ctx, { ...status, connected: true }, f.deps.readDesktopCatalogSlugs)).toMatchObject({
    activation: "provider_pending", error: "provider_registration_failed",
  });
  expect(ctx.config.providers).toEqual(before);
});

test("activation retry is consent-gated and never repeats the protocol probe", async () => {
  const f = fixture(), ctx = context("/api/zcode-desktop/activate", {
    consent: true, runtime: "/installed/ZCode", workspace: "/project",
  }, "gui-session");
  f.deps.desktopStatus = () => ({ ...status, connected: true });
  const response = await handleZcodeDesktopRoutes(ctx, f.deps);
  expect(await response?.json()).toMatchObject({ activation: "ready" });
  expect(f.calls()).toBe(0);
});

test("an existing renamed ZCode provider is reused without adding canonical zcode", async () => {
  const ctx = context("/api/zcode-desktop/activate", {}, "gui-session");
  ctx.config.providers.desktop = { adapter: "zcode", authMode: "local", baseUrl: "https://zcode.z.ai", note: "keep" };
  const slugs = models.map(m => "desktop/" + m.id.replaceAll("/", "-"));
  const result = await activateDesktopProvider(ctx, { ...status, connected: true }, () => slugs);
  expect(result).toMatchObject({ activation: "ready", providerName: "desktop" });
  expect(ctx.config.providers.zcode).toBeUndefined();
  expect(ctx.config.providers.desktop?.note).toBe("keep");
});

function accountFixture() {
  const ctx = context("/api/zcode-accounts/login", {}, "gui-session");
  const connected = new Set<string>();
  let hash = "a".repeat(64), failCatalog = false, active = false;
  let slugs: string[] = [], catalogReads = 0;
  const workspaceValidations: Array<{ path: string; accountId?: string }> = [];
  const statusRuntimeHints: Array<readonly string[] | undefined> = [];
  const deps = {
    resolveDesktopRuntime: (path: string) => path,
    validateDesktopWorkspace: (path: string, accountId?: string) => { workspaceValidations.push({ path, accountId }); return path; },
    accountRuntimeBusy: () => active,
    desktopStatus: (accountId?: string, detectedRuntimes?: readonly string[]) => {
      statusRuntimeHints.push(detectedRuntimes);
      return { ...status, runtimes: detectedRuntimes ? [...detectedRuntimes] : status.runtimes,
        sandbox: false, accountId, connected: !!accountId && connected.has(accountId) };
    },
    connectDesktop: async (_r: string, _w: string, accountId?: string) => {
      connected.add(accountId!); return { ...status, sandbox: false, accountId, connected: true };
    },
    disconnectDesktop: async (id?: string) => { connected.delete(id!); },
    readDesktopCatalogSlugs: () => { catalogReads++; return slugs; },
    runNativeOAuth: async (options: { onEvent: (e: any) => void }) => {
      options.onEvent({ type: "authenticated", subjectHash: hash });
    },
  };
  ctx.convergeCodexCatalog = async () => {
    if (failCatalog) throw new Error("fixture catalog failure");
    slugs = Object.entries(ctx.config.providers).filter(([, p]) => p.adapter === "zcode")
      .flatMap(([name]) => models.map(m => name + "/" + m.id.replaceAll("/", "-")));
    return { status: "committed", changed: true, degraded: false, notices: [] };
  };
  const call = async (action: string, body: object, principal: ManagementContext["principal"] = "gui-session") => {
    const request = context("/api/zcode-accounts/" + action, { consent: true, ...body }, principal);
    ctx.req = request.req; ctx.url = request.url; ctx.principal = principal;
    return (await handleZcodeAccountRoutes(ctx, deps))!;
  };
  const login = async (extra = {}) => {
    const result = await (await call("login", { label: "Personal", runtime: "/runtime", workspace: "/project", ...extra })).json();
    await Promise.resolve(); await Promise.resolve();
    return result;
  };
  return { ctx, deps, call, login, slugs: () => slugs, catalogReads: () => catalogReads,
    statusRuntimeHints: () => statusRuntimeHints, workspaceValidations: () => workspaceValidations,
    hash: (h: string) => { hash = h; },
    failCatalog: (v: boolean) => { failCatalog = v; }, active: (v: boolean) => { active = v; } };
}
test("new accounts validate the displayed managed workspace in their eventual account scope", async () => {
  const f = accountFixture();
  const account = await f.login({ workspace: defaultDesktopWorkspace() });
  expect(f.workspaceValidations()).toEqual([{ path: defaultDesktopWorkspace(account.accountId), accountId: account.accountId }]);
  expect(await (await f.call("complete", { jobId: account.jobId })).json()).toMatchObject({ activation: "ready" });
});

test("account workspace remapping recognizes the canonical target of a symlinked config root", async () => {
  if (process.platform === "win32") return;
  const realConfig = join(home, "real-config");
  const linkedConfig = join(home, "linked-config");
  mkdirSync(realConfig);
  symlinkSync(realConfig, linkedConfig);
  process.env.OPENCODEX_HOME = linkedConfig;
  mkdirSync(defaultDesktopWorkspace(), { recursive: true });
  const displayedCanonicalWorkspace = realpathSync(defaultDesktopWorkspace());
  const f = accountFixture();
  const account = await f.login({ workspace: displayedCanonicalWorkspace });
  expect(f.workspaceValidations()).toEqual([{
    path: defaultDesktopWorkspace(account.accountId), accountId: account.accountId,
  }]);
});

test("workspace validation failure removes the newly allocated draft account", async () => {
  const f = accountFixture();
  f.deps.validateDesktopWorkspace = () => { throw new Error("workspace_invalid"); };
  expect(await (await f.call("login", { label: "Invalid", runtime: "/runtime", workspace: "/denied" })).json())
    .toEqual({ error: "workspace_invalid" });
  expect(listAccounts()).toEqual([]);
  expect(readdirSync(join(home, "zcode-accounts"))).toEqual([]);
});
test("reconnect validation failure removes only its draft and preserves the saved account", async () => {
  const f = accountFixture();
  const account = await f.login();
  expect(await (await f.call("complete", { jobId: account.jobId })).json()).toMatchObject({ activation: "ready" });
  writeFileSync(join(accountProfile(account.accountId), "sentinel"), "original");
  f.deps.validateDesktopWorkspace = () => { throw new Error("workspace_invalid"); };
  expect(await f.login({ accountId: account.accountId, workspace: "/denied" }))
    .toEqual({ error: "workspace_invalid" });
  expect(listAccounts().map(saved => saved.id)).toEqual([account.accountId]);
  expect(readdirSync(join(home, "zcode-accounts"))).toEqual([account.accountId]);
  expect(readFileSync(join(accountProfile(account.accountId), "sentinel"), "utf8")).toBe("original");
});
test("account listing after restart removes only orphaned hidden reconnect drafts", async () => {
  const f = accountFixture();
  const account = await f.login();
  expect(await (await f.call("complete", { jobId: account.jobId })).json()).toMatchObject({ activation: "ready" });
  const reconnect = await f.login({ accountId: account.accountId });
  expect(reconnect).not.toHaveProperty("error");
  expect(readdirSync(join(home, "zcode-accounts"))).toHaveLength(2);

  const liveRequest = context("/api/zcode-accounts", {}, "gui-session", "GET");
  f.ctx.req = liveRequest.req; f.ctx.url = liveRequest.url;
  expect(await (await handleZcodeAccountRoutes(f.ctx, f.deps))!.json()).toMatchObject({
    accounts: [{ id: account.accountId }],
  });
  expect(readdirSync(join(home, "zcode-accounts"))).toHaveLength(2);

  resetZcodeAccountJobsForTests();
  const restartedRequest = context("/api/zcode-accounts", {}, "gui-session", "GET");
  f.ctx.req = restartedRequest.req; f.ctx.url = restartedRequest.url;
  expect(await (await handleZcodeAccountRoutes(f.ctx, f.deps))!.json()).toMatchObject({
    accounts: [{ id: account.accountId }],
  });
  expect(readdirSync(join(home, "zcode-accounts"))).toEqual([account.accountId]);
});
test("account listing after restart removes an orphaned hidden new-account draft", async () => {
  const f = accountFixture();
  const account = await f.login();
  expect(listAccounts()).toEqual([]);
  expect(readdirSync(join(home, "zcode-accounts"))).toEqual([account.accountId]);

  const liveRequest = context("/api/zcode-accounts", {}, "gui-session", "GET");
  f.ctx.req = liveRequest.req; f.ctx.url = liveRequest.url;
  expect(await (await handleZcodeAccountRoutes(f.ctx, f.deps))!.json()).toEqual({ accounts: [] });
  expect(readdirSync(join(home, "zcode-accounts"))).toEqual([account.accountId]);

  resetZcodeAccountJobsForTests();
  const restartedRequest = context("/api/zcode-accounts", {}, "gui-session", "GET");
  f.ctx.req = restartedRequest.req; f.ctx.url = restartedRequest.url;
  expect(await (await handleZcodeAccountRoutes(f.ctx, f.deps))!.json()).toEqual({ accounts: [] });
  expect(readdirSync(join(home, "zcode-accounts"))).toEqual([]);
});
test("manual accounts require GUI consent; account login enables an independent provider/catalog", async () => {
  const f = accountFixture(), originalDefault = f.ctx.config.defaultProvider;
  expect((await f.call("login", {}, "admin-token")).status).toBe(403);
  expect((await f.call("login", { consent: false })).status).toBe(400);
  expect(listAccounts()).toHaveLength(0);
  const a = await f.login();
  expect(listAccounts()).toHaveLength(0);
  expect(await (await f.call("complete", { jobId: a.jobId })).json()).toMatchObject({ activation: "ready", accountId: a.accountId });
  expect(listAccounts()).toHaveLength(1);
  f.hash("b".repeat(64));
  const b = await f.login({ label: "Work" });
  expect(await (await f.call("complete", { jobId: b.jobId })).json()).toMatchObject({ activation: "ready", accountId: b.accountId });
  const providers = Object.values(f.ctx.config.providers).filter(p => p.adapter === "zcode");
  expect(providers.map(p => p.zcodeAccountId).sort()).toEqual([a.accountId, b.accountId].sort());
  expect(accountProfile(a.accountId)).not.toBe(accountProfile(b.accountId));
  expect(f.slugs()).toHaveLength(4);
  expect(f.ctx.config.defaultProvider).toBe(originalDefault);
  expect(JSON.stringify(await (await f.call("complete", { jobId: a.jobId })).json())).not.toContain("subjectHash");
});
test("account listing shares one host discovery and one catalog read", async () => {
  const f = accountFixture();
  const first = await f.login();
  await f.call("complete", { jobId: first.jobId });
  f.hash("b".repeat(64));
  const second = await f.login({ label: "Work" });
  await f.call("complete", { jobId: second.jobId });
  const statusCalls = f.statusRuntimeHints().length;
  const catalogReads = f.catalogReads();

  const request = context("/api/zcode-accounts", {}, "gui-session", "GET");
  f.ctx.req = request.req; f.ctx.url = request.url;
  const listed = await (await handleZcodeAccountRoutes(f.ctx, f.deps))!.json();

  expect(listed.accounts).toHaveLength(2);
  expect(f.statusRuntimeHints().slice(statusCalls)).toEqual([undefined, status.runtimes]);
  expect(f.catalogReads() - catalogReads).toBe(1);
});
test("duplicate identity is rejected and reconnect preserves provider settings and account id", async () => {
  const f = accountFixture(), a = await f.login();
  const ready = await (await f.call("complete", { jobId: a.jobId })).json();
  f.ctx.config.providers[ready.providerName].contextWindow = 64000;
  const duplicate = await f.login();
  expect(await (await f.call("complete", { jobId: duplicate.jobId })).json()).toMatchObject({ error: "account_duplicate", accountId: a.accountId });
  await f.call("cancel", { jobId: duplicate.jobId });
  const reconnect = await f.login({ accountId: a.accountId });
  expect(await (await f.call("complete", { jobId: reconnect.jobId })).json()).toMatchObject({ activation: "ready", accountId: a.accountId });
  expect(listAccounts()).toHaveLength(1);
  expect(f.ctx.config.providers[ready.providerName].contextWindow).toBe(64000);
});
test("reconnect reserves a hidden draft when twenty accounts are already saved", async () => {
  const f = accountFixture();
  let firstId = "";
  for (let i = 0; i < 20; i++) {
    f.hash(i.toString(16).padStart(64, "0"));
    const account = await f.login({ label: `Account ${i}` });
    await f.call("complete", { jobId: account.jobId });
    firstId ||= account.accountId;
  }
  expect(listAccounts()).toHaveLength(20);
  f.hash("0".repeat(64));
  const reconnect = await f.login({ accountId: firstId });
  expect(reconnect).not.toHaveProperty("error");
  expect(listAccounts()).toHaveLength(20);
  expect(await (await f.call("complete", { jobId: reconnect.jobId })).json()).toMatchObject({ activation: "ready", accountId: firstId });
  expect(listAccounts()).toHaveLength(20);
  expect(await (await f.call("login", { label: "Overflow", runtime: "/runtime", workspace: "/project" })).json())
    .toMatchObject({ error: "account_limit" });
});
test("a hidden new-account draft reserves the last account slot only while its job is active", async () => {
  const f = accountFixture();
  for (let i = 0; i < 19; i++) {
    f.hash(i.toString(16).padStart(64, "0"));
    const account = await f.login({ label: `Account ${i}` });
    await f.call("complete", { jobId: account.jobId });
  }
  expect(listAccounts()).toHaveLength(19);

  f.hash("f".repeat(64));
  const pending = await f.login({ label: "Pending" });
  expect(listAccounts()).toHaveLength(19);
  expect(await (await f.call("login", { label: "Overflow", runtime: "/runtime", workspace: "/project" })).json())
    .toMatchObject({ error: "account_limit" });

  await f.call("cancel", { jobId: pending.jobId });
  expect(await f.login({ label: "Replacement" })).not.toHaveProperty("error");
});
test("account enumeration considers saved accounts after more than one hundred reconnect drafts", () => {
  const target = "11111111-1111-4111-8111-111111111111";
  for (let i = 0; i < 100; i++) {
    writeAccount({
      id: `00000000-0000-4000-8000-${i.toString().padStart(12, "0")}`,
      label: `Reconnect ${i}`,
      draftFor: target,
    });
  }
  for (let i = 0; i < 20; i++) {
    writeAccount({
      id: `ffffffff-ffff-4fff-8fff-${i.toString().padStart(12, "0")}`,
      label: `Saved ${i}`,
      subjectHash: i.toString(16).padStart(64, "0"),
    });
  }
  expect(listAccounts()).toHaveLength(20);
  expect(() => allocateAccount("Overflow")).toThrow("account_limit");
});
test("partial catalog activation retries without login; busy and referenced accounts cannot be removed", async () => {
  const f = accountFixture(), a = await f.login();
  f.failCatalog(true);
  const partial = await (await f.call("complete", { jobId: a.jobId })).json();
  expect(partial).toMatchObject({ activation: "catalog_pending", error: "catalog_update_failed" });
  f.failCatalog(false);
  expect(await (await f.call("activate", { accountId: a.accountId })).json()).toMatchObject({ activation: "ready" });
  f.active(true);
  expect(await (await f.call("remove", { accountId: a.accountId })).json()).toMatchObject({ error: "account_busy" });
  f.active(false);
  f.ctx.config.defaultProvider = partial.providerName;
  expect(await (await f.call("remove", { accountId: a.accountId })).json()).toMatchObject({ error: "account_referenced" });
});

test("account removal recognizes case-insensitive provider and model aliases in routed selectors", async () => {
  const f = accountFixture(), account = await f.login();
  const ready = await (await f.call("complete", { jobId: account.jobId })).json();
  f.ctx.config.providers[ready.providerName].alias = "personal";
  f.ctx.config.subagentModels = [`PeRsOnAl/${models[0]!.id}`];
  expect(await (await f.call("remove", { accountId: account.accountId })).json())
    .toEqual({ error: "account_referenced" });
  expect(listAccounts().map(saved => saved.id)).toEqual([account.accountId]);
  expect(f.ctx.config.providers[ready.providerName]).toBeDefined();

  f.ctx.config.providers[ready.providerName].modelAliases = { [models[0]!.id]: "personal-glm" };
  f.ctx.config.subagentModels = ["PeRsOnAl-GlM"];
  expect(await (await f.call("remove", { accountId: account.accountId })).json())
    .toEqual({ error: "account_referenced" });
  expect(listAccounts().map(saved => saved.id)).toEqual([account.accountId]);
  expect(f.ctx.config.providers[ready.providerName]).toBeDefined();

  f.ctx.config.subagentModels = [];
  expect(await (await f.call("remove", { accountId: account.accountId })).json()).toEqual({ ok: true });
  expect(listAccounts()).toEqual([]);
});

test("account removal ignores alias-shaped prose outside routing selector fields", async () => {
  const f = accountFixture(), account = await f.login();
  const ready = await (await f.call("complete", { jobId: account.jobId })).json();
  f.ctx.config.providers[ready.providerName].modelAliases = { [models[0]!.id]: "fast" };
  f.ctx.config.providers.reviewer = {
    adapter: "openai-responses", baseUrl: "https://reviewer.example.invalid/v1", note: "fast",
  };

  expect(await (await f.call("remove", { accountId: account.accountId })).json()).toEqual({ ok: true });
  expect(listAccounts()).toEqual([]);
  expect(f.ctx.config.providers.reviewer?.note).toBe("fast");
});

test("account removal scans routed selectors in providers that will remain configured", async () => {
  const f = accountFixture(), account = await f.login();
  const ready = await (await f.call("complete", { jobId: account.jobId })).json();
  const target = f.ctx.config.providers[ready.providerName];
  target.alias = "personal";
  target.modelAliases = { [models[0]!.id]: "personal-glm" };
  f.ctx.config.providers.reviewer = {
    adapter: "openai-responses", baseUrl: "https://reviewer.example.invalid/v1",
  };
  for (const selector of [
    `${ready.providerName}/${models[0]!.id}`,
    `PeRsOnAl/${models[0]!.id}`,
    "PeRsOnAl-GlM",
  ]) {
    f.ctx.config.providers.reviewer.autoReviewModel = selector;
    expect(await (await f.call("remove", { accountId: account.accountId })).json())
      .toEqual({ error: "account_referenced" });
    expect(f.ctx.config.providers[ready.providerName]).toBeDefined();
  }
  delete f.ctx.config.providers.reviewer.autoReviewModel;
  f.ctx.config.providers.reviewer.autoReviewModelOverrides = {
    [models[1]!.id]: `${ready.providerName}/${models[1]!.id}`,
  };
  expect(await (await f.call("remove", { accountId: account.accountId })).json())
    .toEqual({ error: "account_referenced" });
  delete f.ctx.config.providers.reviewer.autoReviewModelOverrides;
  expect(await (await f.call("remove", { accountId: account.accountId })).json()).toEqual({ ok: true });
  expect(f.ctx.config.providers.reviewer).toBeDefined();
});

test("failed provider save after account revocation is explicit and idempotently retryable", async () => {
  const f = accountFixture(), account = await f.login();
  const ready = await (await f.call("complete", { jobId: account.jobId })).json();
  const save = f.ctx.deps.saveConfigPreservingClaudeCode;
  f.ctx.deps.saveConfigPreservingClaudeCode = () => { throw new Error("private config path and token"); };

  const partial = await (await f.call("remove", { accountId: account.accountId })).json();
  expect(partial).toEqual({ error: "account_removal_partial" });
  expect(JSON.stringify(partial)).not.toContain("private config path and token");
  expect(f.deps.desktopStatus(account.accountId).connected).toBe(false);
  expect(listAccounts().map(saved => saved.id)).toEqual([account.accountId]);
  expect(f.ctx.config.providers[ready.providerName]).toBeDefined();

  f.ctx.deps.saveConfigPreservingClaudeCode = save;
  expect(await (await f.call("remove", { accountId: account.accountId })).json()).toEqual({ ok: true });
  expect(listAccounts()).toEqual([]);
  expect(f.ctx.config.providers[ready.providerName]).toBeUndefined();
});

test("thrown catalog cleanup after account revocation stays explicit and retryable", async () => {
  const f = accountFixture(), account = await f.login();
  const ready = await (await f.call("complete", { jobId: account.jobId })).json();
  f.failCatalog(true);

  expect(await (await f.call("remove", { accountId: account.accountId })).json())
    .toEqual({ error: "catalog_update_failed" });
  expect(f.deps.desktopStatus(account.accountId).connected).toBe(false);
  expect(listAccounts().map(saved => saved.id)).toEqual([account.accountId]);
  expect(f.ctx.config.providers[ready.providerName]).toBeUndefined();

  f.failCatalog(false);
  expect(await (await f.call("remove", { accountId: account.accountId })).json()).toEqual({ ok: true });
  expect(listAccounts()).toEqual([]);
  expect(f.slugs()).toEqual([]);
});

test("rename preserves custom model labels and saved accounts survive config reload", async () => {
  const f = accountFixture(), a = await f.login();
  const ready = await (await f.call("complete", { jobId: a.jobId })).json();
  const provider = f.ctx.config.providers[ready.providerName];
  provider.modelDisplayNames![models[1]!.id] = "Custom flash";
  expect(await (await f.call("rename", { accountId: a.accountId, label: "Work" })).json()).toMatchObject({ activation: "ready" });
  f.ctx.config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  expect(listAccounts().map(a => a.label)).toEqual(["Work"]);
  expect(f.ctx.config.providers[ready.providerName].modelDisplayNames).toEqual({
    [models[0]!.id]: "Work / GLM-5.3", [models[1]!.id]: "Custom flash",
  });
  expect(await (await f.call("activate", { accountId: a.accountId })).json()).toMatchObject({ activation: "ready" });
  expect(await (await f.call("remove", { accountId: a.accountId })).json()).toEqual({ ok: true });
  expect(listAccounts()).toHaveLength(0);
  expect(f.ctx.config.providers[ready.providerName]).toBeUndefined();
  expect(f.slugs()).toHaveLength(0);
});
test("reconnecting a different identity or failed protocol preserves the original account", async () => {
  const f = accountFixture(), a = await f.login();
  const ready = await (await f.call("complete", { jobId: a.jobId })).json();
  writeFileSync(join(accountProfile(a.accountId), "sentinel"), "original");
  const before = structuredClone(f.ctx.config.providers);
  f.hash("b".repeat(64));
  const wrong = await f.login({ accountId: a.accountId });
  expect(await (await f.call("complete", { jobId: wrong.jobId })).json()).toMatchObject({ error: "account_identity_mismatch" });
  await f.call("cancel", { jobId: wrong.jobId });
  f.hash("a".repeat(64));
  const retry = await f.login({ accountId: a.accountId });
  f.deps.connectDesktop = async () => { throw new Error("runtime_failed"); };
  expect(await (await f.call("complete", { jobId: retry.jobId })).json()).toMatchObject({ error: "runtime_failed" });
  expect(readFileSync(join(accountProfile(a.accountId), "sentinel"), "utf8")).toBe("original");
  expect(f.ctx.config.providers).toEqual(before);
  expect(f.ctx.config.providers[ready.providerName].zcodeAccountId).toBe(a.accountId);
  await f.call("cancel", { jobId: retry.jobId });
  expect(listAccounts()).toHaveLength(1);
});
test("failed official OAuth has a safe error and cancel removes the draft only", async () => {
  const f = accountFixture();
  f.deps.runNativeOAuth = async () => { throw new Error("private vendor token"); };
  const a = await f.login();
  const poll = context("/api/zcode-accounts/login?jobId=" + a.jobId, {}, "gui-session");
  poll.req = new Request(poll.url);
  const result = await (await handleZcodeAccountRoutes(poll, f.deps))!.json();
  expect(result).toMatchObject({ phase: "failed", error: "native_oauth_failed" });
  expect(JSON.stringify(result)).not.toContain("private vendor token");
  expect(await (await f.call("cancel", { jobId: a.jobId })).json()).toEqual({ ok: true });
  expect(listAccounts()).toHaveLength(0);
});

test("failed reconnect retains one hidden draft and blocks retry until explicit cancel", async () => {
  const f = accountFixture();
  const account = await f.login();
  expect(await (await f.call("complete", { jobId: account.jobId })).json()).toMatchObject({ activation: "ready" });
  f.deps.runNativeOAuth = async () => { throw new Error("private reconnect failure"); };
  const failed = await f.login({ accountId: account.accountId });
  const poll = context("/api/zcode-accounts/login?jobId=" + failed.jobId, {}, "gui-session", "GET");
  const result = await (await handleZcodeAccountRoutes(poll, f.deps))!.json();
  expect(result).toMatchObject({ phase: "failed", error: "native_oauth_failed", accountId: account.accountId });
  expect(readdirSync(join(home, "zcode-accounts"))).toHaveLength(2);

  expect(await f.login({ accountId: account.accountId })).toEqual({ error: "account_busy" });
  expect(readdirSync(join(home, "zcode-accounts"))).toHaveLength(2);
  expect(await (await f.call("cancel", { jobId: failed.jobId })).json()).toEqual({ ok: true });
  expect(readdirSync(join(home, "zcode-accounts"))).toEqual([account.accountId]);

  f.deps.runNativeOAuth = async options => {
    options.onEvent({ type: "authenticated", subjectHash: "a".repeat(64) });
  };
  const retry = await f.login({ accountId: account.accountId });
  expect(retry).not.toHaveProperty("error");
  await f.call("cancel", { jobId: retry.jobId });
});

test("concurrent completions cannot register the same identity twice", async () => {
  const f = accountFixture(), a = await f.login(), b = await f.login();
  const connect = f.deps.connectDesktop;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  f.deps.connectDesktop = async (...args) => { entered(); await gate; return connect(...args); };
  const first = f.call("complete", {jobId:a.jobId});
  await firstEntered;
  expect(await (await f.call("complete", {jobId:b.jobId})).json()).toMatchObject({error:"account_busy"});
  release();
  expect(await (await first).json()).toMatchObject({activation:"ready"});
  expect(await (await f.call("complete", {jobId:b.jobId})).json()).toMatchObject({error:"account_duplicate"});
  expect(Object.values(f.ctx.config.providers).filter(p => p.adapter === "zcode")).toHaveLength(1);
});
