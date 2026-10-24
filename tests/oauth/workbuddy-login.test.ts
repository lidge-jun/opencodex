import { afterEach, expect, test } from "bun:test";
import { loginWorkBuddy, refreshWorkBuddyToken, workBuddyApi } from "../../src/oauth/workbuddy";
import { normalizeAuthStoreBuffer, credentialGeneration } from "../../src/oauth/store";
import type { OAuthCredentials } from "../../src/oauth/types";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const token = { accessToken: "fixture-access", refreshToken: "fixture-refresh", expiresIn: 3600, refreshExpiresIn: 7200, domain: "international" };
function replies(who: unknown, calls: Array<{ url: string; headers: Headers }> = []) {
  globalThis.fetch = (async (input, init) => {
    const url = String(input); calls.push({ url, headers: new Headers(init?.headers) });
    expect(init?.redirect).toBe("error");
    const data = url.includes("/auth/state") ? { state: "fixture-state", authUrl: "https://www.codebuddy.ai/login" }
      : url.includes("/auth/token") ? token : who;
    return Response.json({ code: 0, data });
  }) as typeof fetch;
}

test("browser login binds tokens to authoritative personal/team identity", async () => {
  const calls: Array<{ url: string; headers: Headers }> = [];
  replies({ uid: "fixture-user", type: "enterprise", enterpriseId: "fixture-team" }, calls);
  let loginUrl = "";
  const cred = await loginWorkBuddy({ onAuth: info => { loginUrl = info.url; } });
  expect(new URL(loginUrl).origin).toBe("https://www.codebuddy.ai");
  expect(new URL(loginUrl).searchParams.get("version")).toBe("2.0.0");
  expect(cred.accountId).toBe(JSON.stringify(["fixture-user", "fixture-team"]));
  expect(cred.workbuddy).toMatchObject({ uid: "fixture-user", domain: "international", enterpriseId: "fixture-team" });
  expect(cred.expires).toBeGreaterThan(Date.now());
  expect(calls[2]!.headers.get("authorization")).toBe("Bearer fixture-access");
  expect(calls[0]!.url).toContain("platform=workbuddy-ai");
});

test("missing identity and ambiguous team refuse credential creation", async () => {
  replies({ nickname: "not-an-identity" });
  await expect(loginWorkBuddy({})).rejects.toThrow("identity unavailable");
  replies({ uid: "fixture-user", type: "enterprise", accounts: [] });
  await expect(loginWorkBuddy({})).rejects.toThrow("team identity unavailable");
});

test("cancellation stops polling without saving a credential", async () => {
  const abort = new AbortController();
  replies({ uid: "fixture-user" });
  await expect(loginWorkBuddy({ signal: abort.signal, onAuth: () => abort.abort() })).rejects.toThrow();
});

test("login rejects foreign URLs and never projects upstream error text", async () => {
  globalThis.fetch = (async () => Response.json({ code: 0, data: { state: "s", authUrl: "https://other.example/login" } })) as typeof fetch;
  await expect(loginWorkBuddy({})).rejects.toThrow("untrusted login URL");
  globalThis.fetch = (async () => Response.json({ code: 0, data: { state: "s", authUrl: "private-fixture-invalid-url" } })) as typeof fetch;
  await expect(loginWorkBuddy({})).rejects.toThrow("WorkBuddy AI returned an invalid login URL");
  globalThis.fetch = (async () => Response.json({ code: 11140, msg: "secret-fixture-access" }, { status: 403 })) as typeof fetch;
  await expect(loginWorkBuddy({})).rejects.toThrow("HTTP 403, code 11140");
});

test("refresh preserves account/team, rotates tokens and rejects expired refresh grants", async () => {
  replies({ uid: "fixture-user", enterpriseId: "fixture-team" });
  const previous = await loginWorkBuddy({});
  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("x-refresh-token")).toBe(previous.refresh);
    expect(headers.get("x-tenant-id")).toBe("fixture-team");
    return Response.json({ code: 0, data: { ...token, accessToken: "fixture-next", refreshToken: "fixture-next-refresh" } });
  }) as typeof fetch;
  const refreshed = await refreshWorkBuddyToken(previous.refresh, undefined, previous);
  expect(refreshed.access).toBe("fixture-next");
  expect(refreshed.accountId).toBe(previous.accountId);
  expect(refreshed.workbuddy?.enterpriseId).toBe("fixture-team");
  await expect(refreshWorkBuddyToken(previous.refresh, undefined, {
    ...previous, workbuddy: { ...previous.workbuddy!, refreshExpiresAt: 1 },
  })).rejects.toThrow("expired");
});

test("bounded API response refuses oversized and malformed data", async () => {
  globalThis.fetch = (async () => new Response("x".repeat(256 * 1024 + 1))) as typeof fetch;
  await expect(workBuddyApi("/v2/plugin/auth/state", {})).rejects.toThrow("invalid response");
  globalThis.fetch = (async () => Response.json({ data: {} })) as typeof fetch;
  await expect(workBuddyApi("/v2/plugin/auth/state", {})).rejects.toThrow("code -1");
  globalThis.fetch = (async () => Response.json({ code: null, data: {} })) as typeof fetch;
  await expect(workBuddyApi("/v2/plugin/auth/state", {})).rejects.toThrow("code -1");
});

test("protected store retains validated metadata and fences identity changes", () => {
  const cred: OAuthCredentials = { access: "fixture-access", refresh: "fixture-refresh", expires: 123,
    workbuddy: { uid: "fixture-user", domain: "international", enterpriseId: "fixture-team" } };
  const result = normalizeAuthStoreBuffer(Buffer.from(JSON.stringify({ "workbuddy-ai": cred })));
  expect(result.kind).toBe("ready");
  if (result.kind === "ready") expect(result.store["workbuddy-ai"]?.accounts[0]?.credential.workbuddy).toEqual(cred.workbuddy);
  expect(credentialGeneration({ ...cred, workbuddy: { ...cred.workbuddy!, enterpriseId: "other" } })).not.toBe(credentialGeneration(cred));
  const invalid = normalizeAuthStoreBuffer(Buffer.from(JSON.stringify({ "workbuddy-ai": { ...cred, workbuddy: { uid: "bad\nheader", domain: "international" } } })));
  if (invalid.kind === "ready") expect(invalid.store["workbuddy-ai"]?.accounts[0]?.credential.workbuddy).toBeUndefined();
});
