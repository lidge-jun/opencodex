import { afterEach, expect, test } from "bun:test";
import { loginCodeBuddyAi, refreshCodeBuddyAiToken, codeBuddyAiApi } from "../../src/oauth/codebuddy-ai";
import { normalizeAuthStoreBuffer, credentialGeneration, getAccountSet, saveCredential } from "../../src/oauth/store";
import { getValidAccessSnapshotForAccount, OAuthLoginRequiredError } from "../../src/oauth";
import { createTempHome } from "../helpers/temp-home";
import type { OAuthCredentials } from "../../src/oauth/types";

const originalFetch = globalThis.fetch;
let home: ReturnType<typeof createTempHome> | undefined;
afterEach(() => { globalThis.fetch = originalFetch; home?.remove(); home = undefined; });
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
  const cred = await loginCodeBuddyAi({ onAuth: info => { loginUrl = info.url; } });
  expect(new URL(loginUrl).origin).toBe("https://www.codebuddy.ai");
  expect(new URL(loginUrl).searchParams.get("version")).toBe("2.180.0");
  expect(cred.accountId).toBe(JSON.stringify(["fixture-user", "fixture-team"]));
  expect(cred.codeBuddyAi).toMatchObject({ uid: "fixture-user", domain: "international", enterpriseId: "fixture-team" });
  expect(cred.expires).toBeGreaterThan(Date.now());
  expect(calls[2]!.headers.get("authorization")).toBe("Bearer fixture-access");
  expect(calls[0]!.url).toContain("platform=CLI");
});

test("missing identity and ambiguous team refuse credential creation", async () => {
  replies({ nickname: "not-an-identity" });
  await expect(loginCodeBuddyAi({})).rejects.toThrow("identity unavailable");
  replies({ uid: "fixture-user", type: "enterprise", accounts: [] });
  await expect(loginCodeBuddyAi({})).rejects.toThrow("team identity unavailable");
  replies({ uid: "fixture-user", type: "enterprise", accounts: [
    { uid: "fixture-user", type: "enterprise", enterpriseId: "fixture-team-a" },
    { uid: "fixture-user", type: "enterprise", enterpriseId: "fixture-team-b" },
  ] });
  await expect(loginCodeBuddyAi({})).rejects.toThrow("team identity unavailable");
});

test("cancellation stops polling without saving a credential", async () => {
  const abort = new AbortController();
  replies({ uid: "fixture-user" });
  await expect(loginCodeBuddyAi({ signal: abort.signal, onAuth: () => abort.abort() })).rejects.toThrow();
});

test("login rejects foreign URLs and never projects upstream error text", async () => {
  globalThis.fetch = (async () => Response.json({ code: 0, data: { state: "s", authUrl: "https://other.example/login" } })) as typeof fetch;
  await expect(loginCodeBuddyAi({})).rejects.toThrow("untrusted login URL");
  globalThis.fetch = (async () => Response.json({ code: 0, data: { state: "s", authUrl: "private-fixture-invalid-url" } })) as typeof fetch;
  await expect(loginCodeBuddyAi({})).rejects.toThrow("CodeBuddy AI returned an invalid login URL");
  globalThis.fetch = (async () => Response.json({ code: 11140, msg: "secret-fixture-access" }, { status: 403 })) as typeof fetch;
  const rejected = await loginCodeBuddyAi({}).catch(error => error as Error);
  expect(rejected.message).toBe("CodeBuddy AI request failed (HTTP 403, code 11140)");
  expect(rejected.message).not.toContain("secret-fixture-access");
});

test("refresh preserves account/team, rotates tokens and rejects expired refresh grants", async () => {
  replies({ uid: "fixture-user", enterpriseId: "fixture-team" });
  const previous = await loginCodeBuddyAi({});
  globalThis.fetch = (async (_input, init) => {
    const headers = new Headers(init?.headers);
    expect(headers.get("x-refresh-token")).toBe(previous.refresh);
    expect(headers.get("x-tenant-id")).toBe("fixture-team");
    return Response.json({ code: 0, data: { ...token, accessToken: "fixture-next", refreshToken: "fixture-next-refresh" } });
  }) as typeof fetch;
  const refreshed = await refreshCodeBuddyAiToken(previous.refresh, undefined, previous);
  expect(refreshed.access).toBe("fixture-next");
  expect(refreshed.accountId).toBe(previous.accountId);
  expect(refreshed.codeBuddyAi?.enterpriseId).toBe("fixture-team");
  await expect(refreshCodeBuddyAiToken(previous.refresh, undefined, {
    ...previous, codeBuddyAi: { ...previous.codeBuddyAi!, refreshExpiresAt: 1 },
  })).rejects.toThrow("expired");
});

test("a locally expired refresh grant marks the account needs-reauth instead of retrying", async () => {
  home = createTempHome("ocx-codebuddy-ai-reauth-");
  await saveCredential("codebuddy-ai", {
    access: "fixture-access", refresh: "fixture-refresh", expires: Date.now() - 1, accountId: "fixture-user",
    codeBuddyAi: { uid: "fixture-user", domain: "international", refreshExpiresAt: 1 },
  });
  const accountId = getAccountSet("codebuddy-ai")!.activeAccountId;
  await expect(getValidAccessSnapshotForAccount("codebuddy-ai", accountId)).rejects.toBeInstanceOf(OAuthLoginRequiredError);
  expect(getAccountSet("codebuddy-ai")!.accounts.find(row => row.id === accountId)?.needsReauth).toBe(true);
});

test("bounded API response refuses oversized and malformed data", async () => {
  globalThis.fetch = (async () => new Response("x".repeat(256 * 1024 + 1))) as typeof fetch;
  await expect(codeBuddyAiApi("/v2/plugin/auth/state", {})).rejects.toThrow("invalid response");
  globalThis.fetch = (async () => Response.json({ data: {} })) as typeof fetch;
  await expect(codeBuddyAiApi("/v2/plugin/auth/state", {})).rejects.toThrow("code -1");
  globalThis.fetch = (async () => Response.json({ code: null, data: {} })) as typeof fetch;
  await expect(codeBuddyAiApi("/v2/plugin/auth/state", {})).rejects.toThrow("code -1");
});

test("protected store retains validated metadata and fences identity changes", () => {
  const cred: OAuthCredentials = { access: "fixture-access", refresh: "fixture-refresh", expires: 123,
    codeBuddyAi: { uid: "fixture-user", domain: "international", enterpriseId: "fixture-team" } };
  const result = normalizeAuthStoreBuffer(Buffer.from(JSON.stringify({ "codebuddy-ai": cred })));
  expect(result.kind).toBe("ready");
  if (result.kind === "ready") expect(result.store["codebuddy-ai"]?.accounts[0]?.credential.codeBuddyAi).toEqual(cred.codeBuddyAi);
  expect(credentialGeneration({ ...cred, codeBuddyAi: { ...cred.codeBuddyAi!, enterpriseId: "other" } })).not.toBe(credentialGeneration(cred));
  const invalid = normalizeAuthStoreBuffer(Buffer.from(JSON.stringify({ "codebuddy-ai": { ...cred, codeBuddyAi: { uid: "bad\nheader", domain: "international" } } })));
  expect(invalid.kind).toBe("ready");
  if (invalid.kind !== "ready") return;
  const retained = invalid.store["codebuddy-ai"]?.accounts[0]?.credential;
  expect(retained).toMatchObject({ access: cred.access, refresh: cred.refresh });
  expect(retained?.codeBuddyAi).toBeUndefined();
});
