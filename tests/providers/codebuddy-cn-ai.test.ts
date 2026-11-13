import { afterEach, expect, test } from "bun:test";
import { loginWorkBuddy } from "../../src/oauth/workbuddy";
import { buildModelsRequest, OAUTH_PROVIDERS } from "../../src/oauth";
import { createWorkBuddyAdapter } from "../../src/adapters/workbuddy";
import { fetchWorkBuddyQuota } from "../../src/providers/quota/workbuddy";
import { credentialPinnedProviderConfigError } from "../../src/config/provider-validation";
import { mayResolveModelsOAuth } from "../../src/oauth/model-discovery-auth";
import { assertWorkBuddyDestination, CODEBUDDY_CN_AI_PROFILE, WORKBUDDY_PROFILE } from "../../src/providers/workbuddy";
import { parseRequest } from "../../src/responses/parser";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import type { OAuthCredentials } from "../../src/oauth/types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const CN = "https://copilot.tencent.com", CN_LOGIN = "https://www.codebuddy.cn";
const token = { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 3600, refreshExpiresIn: 7200 };
const credential = (): OAuthCredentials => ({
  access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() + 3_600_000,
  accountId: "a", workbuddy: { uid: "fixture-user", domain: "www.codebuddy.cn" },
});
type Call = { url: string; headers: Headers };
function record(calls: Call[], reply: (url: string) => unknown) {
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    expect(init?.redirect).toBe("error");
    return Response.json({ code: 0, data: reply(url) });
  }) as typeof fetch;
}

test("CN login runs on the CodeBuddy CN site and stores the CN account domain", async () => {
  const calls: Call[] = [];
  record(calls, url => url.includes("/auth/state") ? { state: "fixture-state", authUrl: `${CN_LOGIN}/login?state=s` }
    : url.includes("/auth/token") ? token : { uid: "fixture-user", type: "personal" });
  let loginUrl = "";
  const cred = await OAUTH_PROVIDERS["codebuddy-cn-ai"]!.login({ onAuth: info => { loginUrl = info.url; } });
  expect(new URL(loginUrl).origin).toBe(CN_LOGIN);
  expect(calls.map(c => new URL(c.url).origin)).toEqual([CN_LOGIN, CN_LOGIN, CN_LOGIN]);
  expect(calls[0]!.url).toContain("platform=workbuddy");
  expect(calls[0]!.headers.get("user-agent")).toBe("CLI/2.179.3 CodeBuddy/2.179.3");
  expect(cred.workbuddy).toMatchObject({ uid: "fixture-user", domain: "www.codebuddy.cn" });
});

test("CN login trusts only CN sign-in pages", async () => {
  for (const authUrl of ["https://www.workbuddy.ai/login", "https://www.codebuddy.ai/login", "https://other.example/login"]) {
    globalThis.fetch = (async () => Response.json({ code: 0, data: { state: "s", authUrl } })) as typeof fetch;
    await expect(loginWorkBuddy({}, CODEBUDDY_CN_AI_PROFILE)).rejects.toThrow("CodeBuddy CN returned an untrusted login URL");
  }
});

test("registered refresh keeps the CN host even when the store passes an account id", async () => {
  const calls: Call[] = [];
  record(calls, () => ({ ...token, accessToken: "fixture-next", refreshToken: "fixture-next-refresh" }));
  const refreshed = await OAUTH_PROVIDERS["codebuddy-cn-ai"]!.refresh("fixture-refresh", undefined, credential(), "fixture-account");
  expect(calls[0]!.url).toBe(`${CN}/v2/plugin/auth/token/refresh`);
  expect(calls[0]!.headers.get("x-domain")).toBe("www.codebuddy.cn");
  expect(calls[0]!.headers.get("x-private-data")).toBe("false");
  expect(refreshed.access).toBe("fixture-next");
  expect(refreshed.workbuddy?.domain).toBe("www.codebuddy.cn");
});

test("CN adapter sends CLI identity to copilot.tencent.com only", async () => {
  const provider = { ...OAUTH_PROVIDERS["codebuddy-cn-ai"]!.providerConfig, apiKey: "fixture-access" };
  const parsed = parseRequest({ model: "hy3", input: "Hello" });
  parsed._workbuddyAuthContext = { uid: "fixture-user", domain: "www.codebuddy.cn", enterpriseId: "fixture-team" };
  const req = await createWorkBuddyAdapter(provider, CODEBUDDY_CN_AI_PROFILE)
    .buildRequest(parsed, { headers: new Headers(), translatorBudget: createTestTranslatorBudget() });
  expect(req.url).toBe(`${CN}/v2/chat/completions`);
  expect(req.headers["X-IDE-Type"]).toBe("CLI");
  expect(req.headers["X-Domain"]).toBe("www.codebuddy.cn");
  expect(req.headers["X-Private-Data"]).toBe("true");
  expect(JSON.parse(req.body).stream).toBe(true);
});

test("regions never accept each other's destination", () => {
  expect(() => assertWorkBuddyDestination(`${CN}/v2`, CODEBUDDY_CN_AI_PROFILE)).not.toThrow();
  expect(() => assertWorkBuddyDestination(`${CN}/v2`, WORKBUDDY_PROFILE)).toThrow();
  expect(() => assertWorkBuddyDestination("https://www.workbuddy.ai/v2", CODEBUDDY_CN_AI_PROFILE)).toThrow();
  expect(() => assertWorkBuddyDestination(`${CN_LOGIN}/v2`, CODEBUDDY_CN_AI_PROFILE)).toThrow();
  const provider = OAUTH_PROVIDERS["codebuddy-cn-ai"]!.providerConfig;
  expect(credentialPinnedProviderConfigError("codebuddy-cn-ai", provider)).toBeNull();
  expect(credentialPinnedProviderConfigError("codebuddy-cn-ai", { ...provider, baseUrl: "https://www.workbuddy.ai/v2" }))
    .toBe("CodeBuddy CN credentials require https://copilot.tencent.com/v2");
  expect(credentialPinnedProviderConfigError("codebuddy-cn-ai", { ...provider, adapter: "workbuddy-ai" }))
    .toBe('adapter must stay "codebuddy-cn-ai"');
  expect(mayResolveModelsOAuth("codebuddy-cn-ai", provider)).toBe(true);
  expect(mayResolveModelsOAuth("workbuddy-ai", provider)).toBe(false);
});

test("CN catalog and credits read from the CN API host with account headers", async () => {
  const provider = OAUTH_PROVIDERS["codebuddy-cn-ai"]!.providerConfig, cred = credential();
  const models = buildModelsRequest(provider, cred.access, "codebuddy-cn-ai", { workbuddy: cred.workbuddy });
  expect(models.url).toBe(`${CN}/v3/config`);
  expect(models.headers["X-User-Id"]).toBe("fixture-user");
  const calls: Call[] = [];
  record(calls, () => ({ TotalCredits: { Total: "100", Used: "40", Remain: "60" }, Packages: [] }));
  const report = await fetchWorkBuddyQuota("codebuddy-cn-ai", cred);
  expect(calls[0]!.url).toBe(`${CN}/billing/meter/get-user-resource-summary`);
  expect(calls[0]!.headers.get("authorization")).toBe("Bearer fixture-access");
  expect(report).toMatchObject({ provider: "codebuddy-cn-ai", label: "CodeBuddy CN",
    quota: { workbuddyCredits: { total: 100, used: 40, remaining: 60 } } });
});
