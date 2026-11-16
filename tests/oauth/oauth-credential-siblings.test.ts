import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { deriveProviderPresets } from "../../src/providers/derive";
import { OAUTH_CREDENTIAL_SIBLINGS, oauthCredentialSlot } from "../../src/oauth/credential-siblings";
import { getLoginStatus, getValidAccessTokenSnapshot, OAUTH_PROVIDERS, runLogin, UnsupportedOAuthProviderError, upsertOAuthProvider } from "../../src/oauth";
import { captureOAuthAccountSelection, commitOAuthAccountSelection, getAccountSet, getCredential, saveCredential } from "../../src/oauth/store";
import { releaseRemovedProviderCredentials } from "../../src/server/management/provider-credential-release";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const KIMI_ROW: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://api.kimi.com/coding/v1", authMode: "oauth" };
const SIBLING_ROW: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://api.kimi.com/coding/v1", authMode: "oauth" };
const FAR_FUTURE = Date.now() + 365 * 24 * 60 * 60 * 1000;

let home: TempHome;
let network: ReturnType<typeof spyOn>;

beforeEach(() => {
  home = createTempHome("ocx-oauth-siblings-");
  network = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Unexpected network"); });
});
afterEach(() => {
  network.mockRestore();
  home.remove();
});

function authStore(): Record<string, unknown> {
  return JSON.parse(readFileSync(home.path("auth.json"), "utf8")) as Record<string, unknown>;
}

function config(providers: Record<string, OcxProviderConfig>): OcxConfig {
  return { port: 0, hostname: "127.0.0.1", defaultProvider: Object.keys(providers)[0] ?? "kimi", providers } as OcxConfig;
}

describe("Kimi (Responses) is a reachable sibling of the Kimi login (#8087)", () => {
  test("the sibling map is exactly the registry rows that borrow another OAuth login", () => {
    const derived = Object.fromEntries(PROVIDER_REGISTRY
      .filter(entry => entry.authKind === "oauth" && entry.oauthId !== undefined && entry.oauthId !== entry.id)
      .map(entry => [entry.id, entry.oauthId]));
    expect(OAUTH_CREDENTIAL_SIBLINGS).toEqual(derived);
    expect(OAUTH_CREDENTIAL_SIBLINGS).toEqual({ "kimi-responses": "kimi" });
    expect(oauthCredentialSlot("kimi-responses")).toBe("kimi");
    expect(oauthCredentialSlot("kimi")).toBe("kimi");
    expect(oauthCredentialSlot("constructor")).toBe("constructor");
  });

  test("the preset catalog offers Kimi (Responses) beside the default Chat preset, and no other hidden login", () => {
    const presets = deriveProviderPresets();
    const sibling = presets.find(preset => preset.id === "kimi-responses");
    expect(sibling).toMatchObject({
      label: "Kimi (Responses)", adapter: "openai-responses", baseUrl: "https://api.kimi.com/coding/v1",
      auth: "oauth", oauthProvider: "kimi", defaultModel: "kimi-for-coding",
    });
    expect(presets.find(preset => preset.id === "kimi")).toMatchObject({ adapter: "openai-chat", auth: "oauth", oauthProvider: "kimi" });
    for (const hidden of ["devin", "github-copilot", "google-antigravity", "kiro", "meta-muse"]) {
      expect(presets.some(preset => preset.id === hidden)).toBe(false);
    }
  });

  test("one Kimi login serves the sibling row without a second slot", async () => {
    await saveCredential("kimi", { access: "kimi-access-1", refresh: "kimi-refresh-1", expires: FAR_FUTURE, accountId: "kimi-user" });
    const snapshot = await getValidAccessTokenSnapshot("kimi-responses");
    expect(snapshot.accessToken).toBe("kimi-access-1");
    expect(snapshot.provider).toBe("kimi-responses");
    expect(getLoginStatus("kimi-responses").loggedIn).toBe(true);
    const selection = captureOAuthAccountSelection("kimi-responses");
    expect(selection).toEqual(captureOAuthAccountSelection("kimi"));
    expect(await commitOAuthAccountSelection("kimi-responses", selection!.accountId, { expectedSelection: selection! })).toEqual(selection);
    expect(Object.keys(authStore())).toEqual(["kimi"]);
  });

  test("both rows refresh the one rotating Kimi grant in a single flight", async () => {
    await saveCredential("kimi", { access: "kimi-access-old", refresh: "kimi-refresh-old", expires: Date.now() - 1_000, accountId: "kimi-user" });
    let refreshes = 0;
    network.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://auth.kimi.com/api/oauth/token");
      expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("kimi-refresh-old");
      refreshes++;
      return Response.json({ access_token: "kimi-access-new", refresh_token: "kimi-refresh-new", expires_in: 3600 });
    });
    const [chat, responses] = await Promise.all([
      getValidAccessTokenSnapshot("kimi"),
      getValidAccessTokenSnapshot("kimi-responses"),
    ]);
    expect(refreshes).toBe(1);
    expect(chat.accessToken).toBe("kimi-access-new");
    expect(responses.accessToken).toBe("kimi-access-new");
    expect(chat.provider).toBe("kimi");
    expect(responses.provider).toBe("kimi-responses");
    expect(getCredential("kimi")?.refresh).toBe("kimi-refresh-new");
    expect(Object.keys(authStore())).toEqual(["kimi"]);
  });

  test("removing one row keeps the login the other row still uses; the last row releases it", async () => {
    await saveCredential("kimi", { access: "kimi-access-1", refresh: "kimi-refresh-1", expires: FAR_FUTURE, accountId: "kimi-user" });
    const live = config({ "kimi-responses": SIBLING_ROW });
    expect(await releaseRemovedProviderCredentials(live, "kimi")).toBe("retained");
    expect(getAccountSet("kimi")?.accounts).toHaveLength(1);
    delete live.providers["kimi-responses"];
    expect(await releaseRemovedProviderCredentials(live, "kimi-responses")).toBe("released");
    expect(getAccountSet("kimi")).toBeNull();
  });

  test("a remaining key-auth row of the same name does not hold the login", async () => {
    await saveCredential("kimi", { access: "kimi-access-1", refresh: "kimi-refresh-1", expires: FAR_FUTURE, accountId: "kimi-user" });
    const live = config({ kimi: { ...KIMI_ROW, authMode: "key", apiKey: "synthetic" } });
    expect(await releaseRemovedProviderCredentials(live, "kimi-responses")).toBe("released");
    expect(getAccountSet("kimi")).toBeNull();
  });

  test("an unrelated provider still releases its own login on removal", async () => {
    await saveCredential("xai", { access: "xai-access", refresh: "xai-refresh", expires: FAR_FUTURE, accountId: "xai-user" });
    expect(await releaseRemovedProviderCredentials(config({ kimi: KIMI_ROW }), "xai")).toBe("released");
    expect(getAccountSet("xai")).toBeNull();
  });

  test("a login started for the sibling publishes only the sibling row", () => {
    const customKimi: OcxProviderConfig = { ...KIMI_ROW, defaultModel: "operator-choice", models: ["operator-choice"] };
    const withKimi = config({ kimi: structuredClone(customKimi) });
    upsertOAuthProvider(withKimi, "kimi", "kimi-responses");
    expect(withKimi.providers.kimi).toEqual(customKimi);
    expect(withKimi.providers["kimi-responses"]).toMatchObject(SIBLING_ROW);
    const empty = config({});
    upsertOAuthProvider(empty, "kimi", "kimi-responses");
    expect(Object.keys(empty.providers)).toEqual(["kimi-responses"]);
    expect(() => upsertOAuthProvider(config({}), "kimi", "kimi-code")).toThrow(UnsupportedOAuthProviderError);
  });

  test("runLogin refuses a publish row that does not share the login before any login starts", async () => {
    const login = spyOn(OAUTH_PROVIDERS.kimi!, "login");
    try {
      await expect(runLogin("kimi", {}, { publishRow: "kimi-code" })).rejects.toBeInstanceOf(UnsupportedOAuthProviderError);
      await expect(runLogin("xai", {}, { publishRow: "kimi-responses" })).rejects.toBeInstanceOf(UnsupportedOAuthProviderError);
      expect(login).not.toHaveBeenCalled();
    } finally { login.mockRestore(); }
  });

  test("runLogin with the sibling publish row stores the Kimi credential and creates only the sibling row", async () => {
    const login = spyOn(OAUTH_PROVIDERS.kimi!, "login").mockResolvedValue({
      access: "kimi-access-login", refresh: "kimi-refresh-login", expires: FAR_FUTURE, accountId: "kimi-user",
    });
    const saved: OcxConfig[] = [];
    let disk = config({ openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } });
    try {
      await runLogin("kimi", {}, { publishRow: "kimi-responses" }, {
        loadConfig: () => structuredClone(disk),
        saveConfig: next => { disk = structuredClone(next); saved.push(disk); },
      });
    } finally { login.mockRestore(); }
    expect(Object.keys(disk.providers).sort()).toEqual(["kimi-responses", "openai"]);
    expect(disk.providers["kimi-responses"]).toMatchObject(SIBLING_ROW);
    expect(saved.length).toBeGreaterThan(0);
    expect(getCredential("kimi")?.access).toBe("kimi-access-login");
    expect(Object.keys(authStore())).toEqual(["kimi"]);
  });
});
