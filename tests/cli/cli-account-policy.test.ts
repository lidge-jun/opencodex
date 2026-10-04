import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { handleAccountPolicyCommand as policy } from "../../src/cli/account-policy";
import { repoRoot } from "../helpers/repo-root";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { unifiedPoolSettingsDto } from "../../src/oauth/pool-settings-capability";
import type { OcxConfig } from "../../src/types";

let home: TempHome;
let stdout: ReturnType<typeof spyOn>, stderr: ReturnType<typeof spyOn>, network: ReturnType<typeof spyOn>;
beforeEach(() => {
  home = createTempHome("ocx-account-policy-");
  stdout = spyOn(console, "log").mockImplementation(() => {});
  stderr = spyOn(console, "error").mockImplementation(() => {});
  network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Network denied"); });
});
afterEach(() => { network.mockRestore(); stdout.mockRestore(); stderr.mockRestore(); home.remove(); });
const PRIVATE = "SECRET_MUST_NOT_APPEAR";
const rows = [{ id: "a", alias: "Alpha", autoSwitchThresholdOverride: null, quota: { shortWindowSeconds: 18000, shortResetAt: 123, weeklyResetAt: 456 } },
  { id: "b", alias: "Beta", autoSwitchThresholdOverride: 0, quota: null },
  { id: "__main__", autoSwitchThresholdOverride: null, quota: null }];
const grants = { accountId: "anthropic-one", eligible: false, ineligibleReason: "no_grant", atLimit: false, grants: [],
  nextGrantId: null, weeklyResetsAt: null, cooldownUntil: null, pendingOperation: null, journalAvailable: true };
type Call = { path: string; method: string; body?: Record<string, unknown>; url: string };
function fixture(handler?: (call: Call, index: number) => unknown | Promise<unknown>) {
  const calls: Call[] = []; let probes = 0;
  const deps: RuntimeApiDeps = {
    findLiveProxy: async () => { probes++; return { port: 31200 + probes, hostname: "127.0.0.1", pid: 1, source: "runtime" }; },
    fetchImpl: (async (input, init) => {
      expect(init?.redirect).toBe("error");
      const url = String(input), u = new URL(url);
      const call = { path: u.pathname + u.search, method: init?.method ?? "GET", url,
        ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) };
      calls.push(call);
      const custom = await handler?.(call, calls.length);
      if (custom instanceof Response) return custom;
      if (custom !== undefined) return Response.json(custom);
      if (call.path === "/api/codex-auth/accounts") return Response.json({ accounts: rows, token: PRIVATE });
      if (call.path === "/api/codex-auth/active") return Response.json({ autoSwitchThreshold: 65, secret: PRIVATE });
      if (call.path === "/api/codex-auth/auto-switch") return Response.json({ ok: true, id: call.body!.id,
        autoSwitchThresholdOverride: call.body!.threshold, autoSwitchThreshold: call.body!.threshold ?? 65, token: PRIVATE });
      if (call.path === "/api/codex-auth/accounts/credits") return Response.json(call.body!.all !== undefined
        ? { ok: true, all: call.body!.all, ids: call.body!.all ? ["__main__", "a", "b"] : [], token: PRIVATE }
        : { ok: true, ...call.body, token: PRIVATE });
      if (call.path === "/api/settings") {
        const change = call.body!.codexQuotaAutoRefresh as { id: string; window: string; enabled: boolean };
        return Response.json({ ok: true, codexQuotaAutoRefresh: { [change.id]: { fiveHour: false, weekly: false, [change.window]: change.enabled } }, token: PRIVATE });
      }
      if (call.path.startsWith("/api/anthropic/reset-grants")) return Response.json({ ...grants, token: PRIVATE });
      throw new Error("Unexpected fixture route");
    }) as typeof fetch,
  };
  return { calls, deps, probes: () => probes };
}
function result() { expect(stdout.mock.calls).toHaveLength(1); return JSON.parse(stdout.mock.calls[0]![0]); }
function privateOutput() { expect(JSON.stringify([...stdout.mock.calls, ...stderr.mock.calls])).not.toContain(PRIVATE); }

describe("account policy argument and identity boundaries", () => {
  const invalid: [Parameters<typeof policy>[0], string[]][] = [
    ["credits", ["openai", "a"]], ["credits", ["openai", "a", "on", "--all"]],
    ["credits", ["openai", "--all", "on", "--all"]], ["credits", ["openai", "--all", "true"]],
    ["credits", ["anthropic", "a", "on"]], ["credits", ["openai", "a", "on", "--json", "--json"]],
    ["auto-switch", ["openai", "on"]], ["auto-switch", ["openai", "threshold", "101", "--account", "a"]],
    ["auto-switch", ["openai", "threshold", "2.5", "--account", "a"]],
    ["auto-switch", ["openai", "on", "--account", "a", "--account", "b"]],
    ["auto-switch", ["anthropic", "on", "--account", "a"]],
    ["quota-activation", ["openai", "a", "--window", "five-hour", "on"]],
    ["quota-activation", ["openai", "a", "--window", "weekly", "on", "--window", "weekly"]],
    ["pool", ["openai", "--sticky", "0"]], ["pool", ["openai", "--strategy", "least-loaded"]],
    ["pool", ["anthropic", "--strategy", "reset-first"]], ["pool", ["kiro", "--quota-window", "weekly"]],
    ["pool", ["anthropic", "--quota-window", "fiveHour"]], ["pool", ["kiro", "--enabled", "on", "--enabled", "off"]],
    ["anthropic-reset-grants", ["id", "--consume"]], ["anthropic-reset-grants", ["--all"]],
  ];
  test.each(invalid)("refuses invalid %s operands before discovery %j", async (sub, args) => {
    const f = fixture(); expect(await policy(sub, args, f.deps)).toBe(2);
    expect(f.probes()).toBe(0); expect(f.calls).toHaveLength(0); expect(stdout.mock.calls).toHaveLength(0);
  });
  for (const accounts of [null, {}, [null], [{ id: "__proto__" }], [{ id: "a", alias: 7 }], [{ id: "a" }, { id: "a" }], [{ id: "bad/id" }]]) {
    test(`rejects malformed whole roster ${JSON.stringify(accounts)}`, async () => {
      const f = fixture(() => ({ accounts }));
      expect(await policy("credits", ["openai", "main", "on"], f.deps)).toBe(1);
      expect(f.calls).toHaveLength(1); expect(stdout.mock.calls).toHaveLength(0);
    });
  }
  test.each(["a", "Alpha", "alpha", "main", "__main__"])("resolves %s on one pinned runtime", async id => {
    const f = fixture(); expect(await policy("credits", ["openai", id, "off", "--json"], f.deps)).toBe(0);
    expect(f.probes()).toBe(1); expect(new Set(f.calls.map(c => new URL(c.url).origin)).size).toBe(1);
    expect(result()).toEqual({ ok: true, id: id === "main" || id === "__main__" ? "__main__" : "a", creditsAfterLimit: false });
    privateOutput();
  });
  test.each([["auto", 2], ["missing", 4]] as const)("refuses selector %s", async (id, code) => {
    const f = fixture(); expect(await policy("credits", ["openai", id, "on"], f.deps)).toBe(code); expect(f.calls).toHaveLength(1);
  });
  test("refuses ambiguous aliases and never echoes selector text", async () => {
    const f = fixture(() => ({ accounts: [{ id: "a", alias: PRIVATE }, { id: "b", alias: PRIVATE }] }));
    expect(await policy("credits", ["openai", PRIVATE, "on"], f.deps)).toBe(2); privateOutput();
  });
  test.each([401, 404, 409, 503])("preserves failure status %i without roster fallback or raw error", async status => {
    const f = fixture(() => Response.json({ error: PRIVATE }, { status }));
    expect(await policy("credits", ["openai", "a", "on"], f.deps)).toBe(status === 404 ? 4 : status === 409 ? 5 : 1);
    expect(f.calls).toHaveLength(1); privateOutput();
  });
});

describe("policy tasks and safe receipts", () => {
  test.each([["on", 80], ["off", 0], ["inherit", null], ["threshold", 42]] as const)("per-account threshold %s", async (action, threshold) => {
    const f = fixture();
    expect(await policy("auto-switch", ["openai", action, ...(action === "threshold" ? ["42"] : []), "--account", "Alpha", "--json"], f.deps)).toBe(0);
    expect(f.calls[1]!.body).toEqual({ id: "a", threshold });
    expect(result()).toMatchObject({ id: "a", autoSwitchThresholdOverride: threshold }); privateOutput();
  });
  test.each([["a", 65], ["b", 0]] as const)("status uses observed inheritance for %s", async (id, value) => {
    const f = fixture(); expect(await policy("auto-switch", ["openai", "status", "--account", id, "--json"], f.deps)).toBe(0);
    expect(result().autoSwitchThreshold).toBe(value); expect(f.calls.every(c => c.method === "GET")).toBe(true);
  });
  test("missing inherited threshold cannot become default 80", async () => {
    const f = fixture(c => c.path.endsWith("/active") ? {} : undefined);
    expect(await policy("auto-switch", ["openai", "status", "--account", "a", "--json"], f.deps)).toBe(1); expect(stdout.mock.calls).toHaveLength(0);
  });
  test.each(["on", "off"])("credits --all %s writes only explicit scope", async flag => {
    const f = fixture(); expect(await policy("credits", ["openai", "--all", flag, "--json"], f.deps)).toBe(0);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.body).toEqual({ all: flag === "on" });
    expect(result().ids).toEqual(flag === "on" ? ["__main__", "a", "b"] : []); privateOutput();
  });
  test.each([{ ok: true, all: false, ids: ["a"] }, { ok: true, all: false, ids: ["__proto__"] }, { ok: true, all: true, ids: ["__main__", "__main__"] }])("malformed credit receipt is nonzero", async receipt => {
    const f = fixture(() => receipt); expect(await policy("credits", ["openai", "--all", "off", "--json"], f.deps)).toBe(1); expect(stdout.mock.calls).toHaveLength(0);
  });
  for (const window of ["fiveHour", "weekly"]) for (const flag of ["on", "off"]) {
    test(`quota activation ${window} ${flag} projects only selected setting`, async () => {
      const f = fixture(); expect(await policy("quota-activation", ["openai", "Alpha", "--window", window, flag, "--json"], f.deps)).toBe(0);
      expect(f.calls[1]!.body).toEqual({ codexQuotaAutoRefresh: { id: "a", window, enabled: flag === "on" } });
      expect(result()).toEqual({ ok: true, id: "a", window, enabled: flag === "on", available: true }); privateOutput();
    });
  }
  test("quota unavailable enable is conflict and never retries/disables", async () => {
    const f = fixture(c => c.method === "PUT" ? Response.json({ error: PRIVATE }, { status: 409 }) : undefined);
    expect(await policy("quota-activation", ["openai", "a", "--window", "weekly", "on"], f.deps)).toBe(5); expect(f.calls).toHaveLength(2); privateOutput();
  });
  test("quota final disable accepts server removal of the empty entry", async () => {
    const f = fixture(c => c.method === "PUT" ? { ok: true, codexQuotaAutoRefresh: {} } : undefined);
    expect(await policy("quota-activation", ["openai", "b", "--window", "weekly", "off", "--json"], f.deps)).toBe(0);
    expect(result()).toEqual({ ok: true, id: "b", window: "weekly", enabled: false, available: false });
  });
  test("quota read-back failure after acceptance is nonzero", async () => {
    const f = fixture((_c, n) => n === 3 ? Response.json({ error: PRIVATE }, { status: 503 }) : undefined);
    expect(await policy("quota-activation", ["openai", "a", "--window", "weekly", "off", "--json"], f.deps)).toBe(1); expect(stdout.mock.calls).toHaveLength(0); privateOutput();
  });
  test.each([undefined, "anthropic-one"])("reset read %s makes exactly one GET, not consumption", async id => {
    const f = fixture(); expect(await policy("anthropic-reset-grants", [...(id ? [id] : []), "--json"], f.deps)).toBe(0);
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.method).toBe("GET"); expect(result()).toEqual(grants); privateOutput();
  });
  test("reset pending and nullable status fields survive while secret extras disappear", async () => {
    const payload = { ...grants, journalAvailable: false, pendingOperation: { operationId: "00000000-0000-4000-8000-000000000000", grantId: "g1", createdAt: 1, retryableUntil: 2, token: PRIVATE },
      grants: [{ id: "g1", label: "Reset", resetsTotal: 2, resetsLeft: 1, startsAt: null, endsAt: null, clears: ["five_hour"], paused: false,
        usableNow: true, useRequiresLimit: true, percentUsed: { five_hour: 100, token: PRIVATE }, token: PRIVATE }] };
    const f = fixture(() => payload); expect(await policy("anthropic-reset-grants", ["--json"], f.deps)).toBe(0);
    expect(result().pendingOperation.retryableUntil).toBe(2); privateOutput();
  });
  test("reset upstream refusal uses known actionable fixed code", async () => {
    const f = fixture(() => Response.json({ error: { code: "auth_failed", message: PRIVATE } }, { status: 401 }));
    expect(await policy("anthropic-reset-grants", [], f.deps)).toBe(1); expect(stderr.mock.calls[0]![0]).toContain("Sign in"); privateOutput();
  });
});

describe("pool field masks and actual policy projection", () => {
  for (const [provider, kind] of [["openai", "codex"], ["anthropic", "anthropic"], ["kiro", "generic"], ["gemini", "generic"]] as const) {
    test(`${provider} read preserves null/effective without account availability guesses`, async () => {
      const config: OcxConfig = { port: 10100, defaultProvider: provider, providers: { [provider]: { adapter: "openai-chat", baseUrl: "https://example.test" } }, oauthAccountFailover: { enabled: true } };
      const dto = unifiedPoolSettingsDto(config, provider, kind);
      const f = fixture(() => ({ ...dto, inert: true, secret: PRIVATE }));
      expect(await policy("pool", [provider, "--json"], f.deps)).toBe(0);
      expect(result()).toEqual({ ...dto, inert: true }); privateOutput();
    });
  }
  test("partial enabled false and threshold zero retain independent semantics", async () => {
    const dto = unifiedPoolSettingsDto({ port: 10100, providers: {}, defaultProvider: "anthropic" }, "anthropic", "anthropic");
    const f = fixture(c => c.method === "GET" ? dto : { ...dto, ...c.body, enabledEffective: false });
    expect(await policy("pool", ["anthropic", "--enabled", "off", "--threshold", "0", "--json"], f.deps)).toBe(0);
    expect(f.calls[1]!.body).toEqual({ provider: "anthropic", enabled: false, autoSwitchThreshold: 0 });
    expect(result()).toMatchObject({ enabled: false, enabledEffective: false, autoSwitchThreshold: 0 });
  });
  test("Codex enabled rejects even dishonest supported field list", async () => {
    const dto = unifiedPoolSettingsDto({ port: 10100, providers: {}, defaultProvider: "openai" }, "openai", "codex");
    const f = fixture(() => ({ ...dto, supported: [...dto.supported, "enabled"] }));
    expect(await policy("pool", ["openai", "--enabled", "off"], f.deps)).toBe(2); expect(f.calls).toHaveLength(1);
  });
  test("runtime support mask can refuse an otherwise syntactically valid field", async () => {
    const dto = unifiedPoolSettingsDto({ port: 10100, providers: {}, defaultProvider: "openai" }, "openai", "codex");
    const f = fixture(() => ({ ...dto, supported: ["strategy"] }));
    expect(await policy("pool", ["openai", "--sticky", "3"], f.deps)).toBe(2); expect(f.calls).toHaveLength(1);
  });
  test("pool save keeps the server's fixed bookkeeping warning in JSON and human output", async () => {
    const dto = unifiedPoolSettingsDto({ port: 10100, providers: {}, defaultProvider: "anthropic" }, "anthropic", "anthropic");
    const handler = (call: Call) => call.method === "GET" ? dto : { ...dto, enabled: false, warning: "config_bookkeeping_failed" };
    let f = fixture(handler);
    expect(await policy("pool", ["anthropic", "--enabled", "off", "--json"], f.deps)).toBe(0);
    expect(result().warning).toBe("config_bookkeeping_failed");
    stdout.mockClear(); f = fixture(handler);
    expect(await policy("pool", ["anthropic", "--enabled", "off"], f.deps)).toBe(0);
    expect(String(stdout.mock.calls[0]![0])).toContain("configuration bookkeeping failed");
  });
  test("pool mismatched provider or changed write evidence cannot succeed", async () => {
    const dto = unifiedPoolSettingsDto({ port: 10100, providers: {}, defaultProvider: "openai" }, "openai", "codex");
    const f = fixture(() => dto);
    expect(await policy("pool", ["openai", "--threshold", "0"], f.deps)).toBe(1); expect(stdout.mock.calls).toHaveLength(0);
  });
});

test("isolated real handlers persist one/all credits, thresholds, pool and selected windows with native/upstream effects stubbed", async () => {
  // Child-owned mock registry cannot leak mocked native effects into another test file.
  const script = `
    import { mock } from 'bun:test';
    import assert from 'node:assert/strict';
    import {mkdirSync} from 'node:fs';
    mkdirSync(process.env.CODEX_HOME,{recursive:true});
    globalThis.fetch = async () => { throw Error('NETWORK DENIED'); };
    const quota = await import('./src/codex/quota.ts');
    const fixtureQuota = {shortWindowSeconds:18000, shortResetAt:123, weeklyResetAt:456, updatedAt:1};
    mock.module('./src/codex/quota.ts', () => ({...quota, getAccountQuota: () => fixtureQuota}));
    const refresh = await import('./src/codex/quota-auto-refresh.ts');
    let scheduled = 0;
    mock.module('./src/codex/quota-auto-refresh.ts', () => ({...refresh, runCodexQuotaAutoRefresh: async () => { scheduled++; }}));
    const desktop = await import('./src/codex/desktop-switches.ts');
    mock.module('./src/codex/desktop-switches.ts', () => ({...desktop,
      observedCodexDesktopSwitchApply: async () => ({status:'deferred', reason:'fixture'}),
      applyCodexConfigInjection: async () => { throw Error('NATIVE APPLY DENIED'); }
    }));
    const {handleCodexAuthAPI} = await import('./src/codex/auth-api/routes.ts');
    const {handleOauthAccountRoutes} = await import('./src/server/management/oauth-account-routes.ts');
    const {handleConfigRoutes} = await import('./src/server/management/config-routes.ts');
    const {handleAnthropicResetGrantRoutes} = await import('./src/server/management/anthropic-reset-grant-routes.ts');
    let grantReads = 0;
    const {handleAccountPolicyCommand} = await import('./src/cli/account-policy.ts');
    const {saveConfig,loadConfig} = await import('./src/config.ts');
    const {startupHealthFixture} = await import('./tests/helpers/startup-health.ts');
    const config = {port:10100, defaultProvider:'openai', providers:{
      openai:{adapter:'openai-chat',baseUrl:'https://example.test',authMode:'forward'},
      anthropic:{adapter:'anthropic',baseUrl:'https://example.test',authMode:'oauth'}},
      codexAccounts:[{id:'a',email:'fixture@example.test',isMain:false,addedAt:1},{id:'b',email:'fixture2@example.test',isMain:false,addedAt:1}],
      showCodexCredits:false, autoSwitchThreshold:65};
    saveConfig(config);
    const captured=[]; console.log = v => captured.push(JSON.parse(v));
    const fetchImpl = async (input,init) => {
      assert.equal(init.redirect,'error'); const req = new Request(String(input),init), url = new URL(req.url);
      if(url.pathname === '/api/codex-auth/accounts') return Response.json({accounts:[
        {id:'a',alias:'Alpha',autoSwitchThresholdOverride:config.codexAccountAutoSwitchThresholds?.a ?? null,quota:fixtureQuota},
        {id:'b',autoSwitchThresholdOverride:null,quota:null}, {id:'__main__',autoSwitchThresholdOverride:null,quota:null}]});
      const ctx = {req,url,config,version:'test',deps:{getCachedStartupHealth:async()=>startupHealthFixture()},
        trustedLoopbackIngress:true,guiSessionIssuance:null,
        convergeCodexCatalog:async()=>{throw Error('CATALOG NOT EXPECTED');},syncClaudeAgentDefsBestEffort:async()=>{throw Error('NATIVE NOT EXPECTED');}};
      const res = url.pathname.startsWith('/api/codex-auth/') ? await handleCodexAuthAPI(req,url,config)
        : url.pathname === '/api/pool/settings' ? await handleOauthAccountRoutes(ctx)
        : url.pathname === '/api/anthropic/reset-grants' ? await handleAnthropicResetGrantRoutes(ctx, {
          listAccountIds:()=>['anthropic-one'], activeAccountId:()=> 'anthropic-one', accessTokenFor:async()=> 'synthetic-token',
          journalPath:process.env.OPENCODEX_HOME + '/grant-journal.json',
          fetchFn:async(_url,init)=>{assert.equal(init.method,'GET');grantReads++;return Response.json({cedar_ember:{eligible:true,at_limit:true,
            grants:[{id:'g1',label:'Grant',resets_total:2,resets_left:1,starts_at:'2026-10-04',clears:['five_hour'],usable_now:true}],next_grant_id:'g1'}});}
        }) : await handleConfigRoutes(ctx);
      assert(res); return res;
    };
    const run = async (sub,args) => {const code=await handleAccountPolicyCommand(sub,[...args,'--json'],{baseUrl:'http://127.0.0.1:32100',fetchImpl});assert.equal(code,0);return captured.at(-1);};
    await run('credits',['openai','Alpha','on']); assert.deepEqual(config.creditCodexAccountIds,['a']);
    const all = await run('credits',['openai','--all','on']); assert.deepEqual(all.ids,['__main__','a','b']);
    assert.deepEqual(loadConfig().creditCodexAccountIds,['__main__','a','b']); assert.equal(config.showCodexCredits,false);
    await run('credits',['openai','--all','off']); assert.deepEqual(config.creditCodexAccountIds,undefined);
    await run('auto-switch',['openai','off','--account','Alpha']); assert.equal(config.codexAccountAutoSwitchThresholds.a,0);
    assert.equal((await run('auto-switch',['openai','inherit','--account','a'])).autoSwitchThreshold,65);
    await run('pool',['anthropic','--enabled','off','--threshold','0','--quota-window','weekly']);
    assert.equal(config.anthropicAccountPool.enabled,false); assert.equal(config.anthropicAccountPool.autoSwitchThreshold,0);
    await run('quota-activation',['openai','a','--window','weekly','on']); assert.equal(config.codexQuotaAutoRefresh.a.weekly,true);
    await run('quota-activation',['openai','a','--window','fiveHour','on']); assert.deepEqual(config.codexQuotaAutoRefresh.a,{weekly:true,fiveHour:true});
    await run('quota-activation',['openai','a','--window','weekly','off']); assert.deepEqual(config.codexQuotaAutoRefresh.a,{fiveHour:true});
    await run('quota-activation',['openai','a','--window','fiveHour','off']); assert.equal(config.codexQuotaAutoRefresh,undefined);
    assert.equal(scheduled,4); assert.equal(config.showCodexCredits,false);
    const grants = await run('anthropic-reset-grants',[]); assert.equal(grantReads,1);
    assert.equal(grants.grants[0].startsAt,'2026-10-04');assert.equal(grants.grants[0].resetsLeft,1);assert.equal(grants.pendingOperation,null);
    process.stdout.write('REAL_HANDLER_PROOF_PASS');
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    cwd: repoRoot(), env: { ...process.env, HOME: home.root }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ code, err }).toEqual({ code: 0, err: "" }); expect(out).toBe("REAL_HANDLER_PROOF_PASS");
}, 20000);

describe("unverified outcomes refuse success", () => {
  test.each([
    { ok: false, id: "a", creditsAfterLimit: true },
    { ok: true, id: "b", creditsAfterLimit: true },
    { ok: true, id: "a", creditsAfterLimit: false },
    { ok: true, id: "a", creditsAfterLimit: "true" },
  ])("credit receipt must acknowledge exact account and policy %j", async reply => {
    const f = fixture(c => c.method === "PUT" ? reply : undefined);
    expect(await policy("credits", ["openai", "a", "on", "--json"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(2); expect(stdout.mock.calls).toHaveLength(0);
  });
  test("missing target never invokes transport or falls back to local state", async () => {
    const f = fixture(); f.deps.findLiveProxy = async () => null;
    expect(await policy("credits", ["openai", "a", "on", "--json"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(0); expect(stdout.mock.calls).toHaveLength(0);
  });
  test("transport failure is static and never retries", async () => {
    const f = fixture(() => { throw new Error(PRIVATE); });
    expect(await policy("credits", ["openai", "--all", "on", "--json"], f.deps)).toBe(1);
    expect(f.calls).toHaveLength(1); privateOutput();
  });
  test("reset unavailable/malformed status does not masquerade as empty grants", async () => {
    const f = fixture(() => ({ accountId: "anthropic-one", eligible: false, grants: [], error: PRIVATE }));
    expect(await policy("anthropic-reset-grants", ["--json"], f.deps)).toBe(1); expect(stdout.mock.calls).toHaveLength(0); privateOutput();
  });
  test("human terminal output escapes grant labels", async () => {
    const f = fixture(() => ({ ...grants, accountId: "fixture\u001b[2J" }));
    expect(await policy("anthropic-reset-grants", [], f.deps)).toBe(0);
    expect(JSON.stringify(stdout.mock.calls)).not.toContain("\\u001b");
  });
});
