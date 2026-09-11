import { handleZcodeAccountRoutes, resetZcodeAccountJobsForTests } from "../../src/server/management/zcode-account-routes";
import { listAccounts, accountProfile } from "../../src/adapters/zcode/accounts";
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
  resetZcodeAccountJobsForTests();
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
      for (const action of ["connect", "activate", "disconnect", "test"]) {
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
  let slugs: string[] = [];
  const deps = {
    resolveDesktopRuntime: (path: string) => path,
    validateDesktopWorkspace: (path: string) => path,
    accountRuntimeBusy: () => active,
    desktopStatus: (accountId?: string) => ({ ...status, sandbox: false, accountId, connected: !!accountId && connected.has(accountId) }),
    connectDesktop: async (_r: string, _w: string, accountId?: string) => {
      connected.add(accountId!); return { ...status, sandbox: false, accountId, connected: true };
    },
    disconnectDesktop: async (id?: string) => { connected.delete(id!); },
    readDesktopCatalogSlugs: () => slugs,
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
  return { ctx, deps, call, login, slugs: () => slugs, hash: (h: string) => { hash = h; },
    failCatalog: (v: boolean) => { failCatalog = v; }, active: (v: boolean) => { active = v; } };
}
test("manual accounts require GUI consent; account login enables an independent provider/catalog", async () => {
  const f = accountFixture(), originalDefault = f.ctx.config.defaultProvider;
  expect((await f.call("login", {}, "admin-token")).status).toBe(403);
  expect((await f.call("login", { consent: false })).status).toBe(400);
  expect(listAccounts()).toHaveLength(0);
  const a = await f.login();
  expect(await (await f.call("complete", { jobId: a.jobId })).json()).toMatchObject({ activation: "ready", accountId: a.accountId });
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

test("concurrent completions cannot register the same identity twice", async () => {
  const f = accountFixture(), a = await f.login(), b = await f.login();
  const connect = f.deps.connectDesktop;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  f.deps.connectDesktop = async (...args) => { await gate; return connect(...args); };
  const first = f.call("complete", {jobId:a.jobId});
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(await (await f.call("complete", {jobId:b.jobId})).json()).toMatchObject({error:"account_busy"});
  release();
  expect(await (await first).json()).toMatchObject({activation:"ready"});
  expect(await (await f.call("complete", {jobId:b.jobId})).json()).toMatchObject({error:"account_duplicate"});
  expect(Object.values(f.ctx.config.providers).filter(p => p.adapter === "zcode")).toHaveLength(1);
});
