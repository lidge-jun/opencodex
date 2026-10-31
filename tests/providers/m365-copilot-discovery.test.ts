import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTempHome } from "../helpers/temp-home";
import { saveCredential, getCredential, credentialGeneration } from "../../src/oauth/store";
import { OAUTH_PROVIDERS, getValidAccessTokenSnapshot } from "../../src/oauth";
import { clearModelCache, getProviderLiveModelCount } from "../../src/codex/model-cache";
import { fetchProviderModels } from "../../src/codex/catalog/provider-models";
import { normalizeM365WebSession, parseM365ModelBootstrap, readM365ModelBootstrap, M365_COPILOT_WEB_URL } from "../../src/providers/m365-copilot-discovery";
import { getToneForModel } from "../../src/providers/m365-copilot-models";
import { applyNewModelPolicy } from "../../src/providers/new-model-policy";
import { readM365BrowserWebSession } from "../../src/oauth/m365-copilot-web-session";
import { probeM365CopilotProvider } from "../../src/server/management/m365-copilot-provider-probe";

const oid = "11111111-1111-1111-1111-111111111111", tid = "22222222-2222-2222-2222-222222222222";
const accountId = oid + "@" + tid;
const cookie = "OhpAuth=fixture-web-session; SSRUserType=AAD";
const item = (id: string, name = id) => ({ id, type: "item", menuItemTitle: name });
const html = (rows: unknown[] = [item("Magic"), { id: "Claude", type: "itemGroup", itemGroup: [item("Claude_Sonnet", "Sonnet fixture")] }], user = oid) => {
  const h = { loaderData: { root: { store: { accountInfo: { objectId: user, tenantId: tid } }, __queryState: { queries: [{ state: { data: {
    bizchatAsAgentGpt: { clientPreferences: { modelSelectorMetadata: { availableModelSelectionOptions: rows } } },
    agentList: [{ clientPreferences: { modelSelectorMetadata: { availableModelSelectionOptions: [item("Forum")] } } }],
  } } }] } } } };
  return "<script>window.__staticRouterHydrationData = JSON.parse(" + JSON.stringify(JSON.stringify(h)) + ");</script>";
};
const credential = () => ({ access: "header." + Buffer.from(JSON.stringify({ oid, tid, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url") + ".signature",
  refresh: "fixture-refresh", expires: Date.now() + 3_600_000, accountId, m365: { cookie, accountId } });
let home: ReturnType<typeof createTempHome>;
const originalFetch = globalThis.fetch;
beforeEach(() => { home = createTempHome("ocx-m365-discovery-"); clearModelCache("m365-copilot"); });
afterEach(() => { globalThis.fetch = originalFetch; clearModelCache("m365-copilot"); home.remove(); });

test("parses only the main account chat roster, nested groups, duplicates and quota status", () => {
  const parsed = parseM365ModelBootstrap(html([item("Magic"), { type: "itemGroup", itemGroup: [item("Claude_Sonnet", "Sonnet fixture"), { ...item("Claude_Opus"), disabled: true }, item("Magic")] }]));
  expect(parsed.accountId).toBe(accountId);
  expect(parsed.items.map(m => m.id)).toEqual(["Magic", "Claude_Sonnet", "Claude_Opus"]);
  expect(parsed.items[2]?.m365_disabled).toBe(true);
  expect(parsed.items.every(m => JSON.stringify(m.input_modalities) === JSON.stringify(["text", "image"]))).toBe(true);
  expect(parsed.items.some(m => m.id === "Forum")).toBe(false);
  expect(getToneForModel("Future_Model_99")).toBe("Future_Model_99");
});
test("rejects missing, malformed, oversized and account-mismatched metadata without executing scripts", async () => {
  expect(() => parseM365ModelBootstrap("<script>throw new Error('never execute');</script>")).toThrow("web sign-in");
  expect(() => parseM365ModelBootstrap(html([item("../../foreign")]))).toThrow("invalid model selector");
  expect(() => parseM365ModelBootstrap(html(Array.from({ length: 257 }, () => item("Magic"))))).toThrow("limits");
  await expect(readM365ModelBootstrap(new Response(html()), tid + "@" + tid)).rejects.toThrow("account mismatch");
  await expect(readM365ModelBootstrap(new Response("x".repeat(2 * 1024 * 1024 + 1)), accountId)).rejects.toThrow("limits");
});
test("stores only bounded account-matched cookies and includes session rotation in credential authority", async () => {
  expect(normalizeM365WebSession({ cookie: cookie + "; foreign=fixture", accountId })).toBeUndefined();
  expect(normalizeM365WebSession({ cookie: "OhpAuth=fixture\r\nX-Injected: value", accountId })).toBeUndefined();
  const c = credential(); await saveCredential("m365-copilot", c);
  expect(getCredential("m365-copilot")?.m365).toEqual(c.m365);
  expect(credentialGeneration({ ...c, m365: { ...c.m365, cookie: "OhpAuth=rotated" } })).not.toBe(credentialGeneration(c));
  const mismatched = { ...c, m365: { cookie, accountId: tid + "@" + tid } };
  await saveCredential("m365-copilot", mismatched);
  expect(getCredential("m365-copilot")?.m365).toBeUndefined();
});
test("live refresh discovers a future selector and the existing new-model policy keeps it disabled until enabled", async () => {
  await saveCredential("m365-copilot", credential()); let calls = 0;
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe(M365_COPILOT_WEB_URL); const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toBe(cookie); expect(headers.has("authorization")).toBe(false);
    expect(init?.redirect).toBe("manual"); calls++;
    return new Response(html(calls === 1 ? [item("Magic")] : [item("Magic"), item("Future_Model_99", "Future model")]));
  }) as typeof fetch;
  const provider = { ...OAUTH_PROVIDERS["m365-copilot"]!.providerConfig, fetch: ((u, o) => globalThis.fetch(u, o)) as typeof fetch };
  expect((await fetchProviderModels("m365-copilot", provider, 60_000)).map(m => m.id)).toEqual(["Magic"]);
  await fetchProviderModels("m365-copilot", provider, 60_000); expect(calls).toBe(1);
  const next = await fetchProviderModels("m365-copilot", provider, 0);
  expect(next.map(m => m.id)).toEqual(["Magic", "Future_Model_99"]);
  expect(next[1]?.displayName).toBe("M365 Copilot Future model"); expect(getProviderLiveModelCount("m365-copilot")).toBe(2);
  expect(next[1]?.inputModalities).toEqual(["text", "image"]);
  const baseline = applyNewModelPolicy({ provider: "m365-copilot", discoveredIds: ["Magic"], policy: "off", now: "2026-10-27T00:00:00Z" }).nextBaseline;
  const policy = applyNewModelPolicy({ provider: "m365-copilot", discoveredIds: next.map(m => m.id), baseline, policy: "off", now: "2026-10-27T01:00:00Z" });
  expect(policy.newIds).toEqual(["Future_Model_99"]);
  expect(policy.slugsToDisable).toEqual(["m365-copilot/Future_Model_99"]);
});
test("never sends a web cookie to a retargeted provider or publishes aliases after an unauthenticated response", async () => {
  await saveCredential("m365-copilot", credential()); let calls = 0;
  globalThis.fetch = (async () => { calls++; return new Response("<html>sign in</html>"); }) as typeof fetch;
  const provider = { ...OAUTH_PROVIDERS["m365-copilot"]!.providerConfig, models: ["claude-sonnet"], fetch: ((u, o) => globalThis.fetch(u, o)) as typeof fetch };
  expect(await fetchProviderModels("m365-copilot", { ...provider, baseUrl: "https://example.invalid" }, 0)).toEqual([]);
  expect(calls).toBe(0);
  expect(await fetchProviderModels("m365-copilot", provider, 0)).toEqual([]); expect(calls).toBe(1);
});
test("captures web discovery sessions using Chrome and Firefox protocol shapes", async () => {
  for (const firefox of [false, true]) {
    const methods: string[] = [];
    const browser = { async command(method: string, params?: Record<string, unknown>) {
      methods.push(method);
      if (/evaluate/.test(method)) return { result: { value: accountId } };
      if (/getCookies/.test(method)) return { cookies: [{ name: "OhpAuth", value: firefox ? { type: "string", value: "fixture" } : "fixture", domain: ".copilot.cloud.microsoft", path: "/", secure: true },
        { name: "foreign", value: "excluded", domain: ".example.invalid", path: "/", secure: true }] };
      expect(params?.url).toBe(M365_COPILOT_WEB_URL); return {};
    } };
    expect(await readM365BrowserWebSession(browser, "context", new AbortController().signal, firefox)).toEqual({ accountId, cookie: "OhpAuth=fixture" });
    expect(methods).toContain(firefox ? "storage.getCookies" : "Network.getCookies");
  }
});

test("dashboard connectivity probe uses live account metadata and never treats a stale catalog as connectivity", async () => {
  await saveCredential("m365-copilot", credential());
  const snapshot = await getValidAccessTokenSnapshot("m365-copilot");
  globalThis.fetch = (async () => new Response(html())) as typeof fetch;
  const provider = { ...OAUTH_PROVIDERS["m365-copilot"]!.providerConfig, fetch: ((u, o) => globalThis.fetch(u, o)) as typeof fetch };
  const ok = await probeM365CopilotProvider("m365-copilot", provider, snapshot, new AbortController().signal);
  expect(await ok.json()).toMatchObject({ ok: true, models: 2 });
  globalThis.fetch = (async () => new Response("sign in")) as typeof fetch;
  const failed = await probeM365CopilotProvider("m365-copilot", provider, snapshot, new AbortController().signal);
  expect(await failed.json()).toMatchObject({ ok: false });
});
