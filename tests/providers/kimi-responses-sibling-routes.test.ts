import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { managementFetch as fetch } from "../helpers/management-auth";
import { saveConfig, loadConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { deriveProviderPresets } from "../../src/providers/derive";
import { handleProviderLifecycleRuntimeCommand as lifecycle } from "../../src/cli/provider-lifecycle-runtime";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const KIMI_BASE = "https://api.kimi.com/coding/v1";
// Each case starts a real management server; a loaded shared runner needs more than the 5s default.
setDefaultTimeout(20_000);
let home: TempHome;
let codexHome: IsolatedCodexHome | null = null;

function baseConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "fixture",
    providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.example.test/v1", authMode: "key", apiKey: "synthetic-key" },
      kimi: { adapter: "openai-chat", baseUrl: KIMI_BASE, authMode: "oauth" },
    },
  } as OcxConfig;
}

function writeKimiLogin(): void {
  writeFileSync(home.path("auth.json"), JSON.stringify({
    kimi: {
      activeAccountId: "kimi0001",
      accounts: [{ id: "kimi0001", credential: { access: "kimi-access", refresh: "kimi-refresh", expires: 9999999999999, accountId: "kimi-user", source: "oauth" } }],
    },
  }), { mode: 0o600 });
}

function authStore(): Record<string, unknown> {
  return JSON.parse(readFileSync(home.path("auth.json"), "utf8")) as Record<string, unknown>;
}

beforeEach(() => {
  home = createTempHome("ocx-kimi-sibling-");
  codexHome = installIsolatedCodexHome("ocx-kimi-sibling-codex-");
  saveConfig(baseConfig());
  writeKimiLogin();
});
afterEach(() => {
  codexHome?.restore();
  codexHome = null;
  home.remove();
});

describe("Kimi (Responses) row under the shared Kimi login (#8087)", () => {
  test("the dashboard picker is offered the sibling preset", async () => {
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/provider-presets", server.url));
      const body = await response.json() as { providers: Array<{ id: string; auth: string; oauthProvider?: string }> };
      expect(body.providers.find(preset => preset.id === "kimi-responses")).toMatchObject({ auth: "oauth", oauthProvider: "kimi" });
    } finally { await server.stop(true); }
  });

  test("the sibling row reads the Kimi login and roster, and adding it needs no login", async () => {
    const server = startServer(0);
    try {
      const kimiBefore = loadConfig().providers.kimi;
      const add = await fetch(new URL("/api/providers", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "kimi-responses", provider: { adapter: "openai-responses", baseUrl: KIMI_BASE, authMode: "oauth", defaultModel: "kimi-for-coding" } }),
      });
      expect(add.status).toBe(200);
      expect(loadConfig().providers.kimi).toEqual(kimiBefore);
      expect(loadConfig().providers["kimi-responses"]).toMatchObject({ adapter: "openai-responses", baseUrl: KIMI_BASE, authMode: "oauth" });
      const status = await (await fetch(new URL("/api/oauth/status?provider=kimi-responses", server.url))).json() as { loggedIn?: boolean };
      expect(status.loggedIn).toBe(true);
      const roster = await fetch(new URL("/api/oauth/accounts?provider=kimi-responses", server.url));
      expect(roster.status).toBe(200);
      expect(await roster.json()).toMatchObject({ activeAccountId: "kimi0001", accounts: [{ id: "kimi0001", active: true }] });
      expect(Object.keys(authStore())).toEqual(["kimi"]);
    } finally { await server.stop(true); }
  });

  test("deleting either row keeps the login while the other row still uses it", async () => {
    saveConfig({ ...baseConfig(), providers: { ...baseConfig().providers, "kimi-responses": { adapter: "openai-responses", baseUrl: KIMI_BASE, authMode: "oauth" } } });
    const server = startServer(0);
    try {
      expect((await fetch(new URL("/api/providers?name=kimi", server.url), { method: "DELETE" })).status).toBe(200);
      expect(Object.keys(authStore())).toEqual(["kimi"]);
      expect((await fetch(new URL("/api/providers?name=kimi-responses", server.url), { method: "DELETE" })).status).toBe(200);
      expect(authStore().kimi).toBeUndefined();
    } finally { await server.stop(true); }
  });

  test("logging out from the sibling row removes the active shared Kimi account for both rows", async () => {
    saveConfig({ ...baseConfig(), providers: { ...baseConfig().providers, "kimi-responses": { adapter: "openai-responses", baseUrl: KIMI_BASE, authMode: "oauth" } } });
    const second = { id: "kimi0002", credential: { access: "kimi-access-2", refresh: "kimi-refresh-2", expires: 9999999999999, accountId: "kimi-user-2", source: "oauth" } };
    const stored = authStore() as { kimi: { accounts: unknown[] } };
    stored.kimi.accounts.push(second);
    writeFileSync(home.path("auth.json"), JSON.stringify(stored), { mode: 0o600 });
    const server = startServer(0);
    try {
      const logout = async () => fetch(new URL("/api/oauth/logout?provider=kimi-responses", server.url), { method: "POST" });
      const status = async (row: string) => (await fetch(new URL(`/api/oauth/status?provider=${row}`, server.url))).json() as Promise<{ loggedIn?: boolean; activeAccountId?: string }>;
      const first = await logout();
      expect(first.status).toBe(200);
      expect(await first.json()).toEqual({ success: true });
      expect(authStore().kimi).toMatchObject({ activeAccountId: "kimi0002", accounts: [{ id: "kimi0002" }] });
      expect(Object.keys(authStore())).toEqual(["kimi"]);
      for (const row of ["kimi", "kimi-responses"]) expect(await status(row)).toMatchObject({ loggedIn: true, activeAccountId: "kimi0002" });
      expect((await logout()).status).toBe(200);
      expect(authStore().kimi).toBeUndefined();
      for (const row of ["kimi", "kimi-responses"]) expect((await status(row)).loggedIn).toBe(false);
    } finally { await server.stop(true); }
  });

  test("a login publish row must share the login it names", async () => {
    const server = startServer(0);
    try {
      for (const body of [{ provider: "kimi", row: "kimi-code" }, { provider: "xai", row: "kimi-responses" }, { provider: "kimi", row: 7 }]) {
        const response = await fetch(new URL("/api/oauth/login", server.url), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: "row must be a provider that shares this login" });
      }
      const sibling = await fetch(new URL("/api/oauth/login", server.url), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: "kimi-responses" }),
      });
      expect(sibling.status).toBe(400);
    } finally { await server.stop(true); }
  });

  test("ocx provider add kimi-responses posts the shared-login seed from the target catalog", async () => {
    const posted: unknown[] = [];
    const logs = spyOn(console, "log").mockImplementation(() => {});
    const errors = spyOn(console, "error").mockImplementation(() => {});
    const deps: RuntimeApiDeps = {
      findLiveProxy: async () => ({ port: 32101, hostname: "127.0.0.1", pid: 1, source: "runtime" }),
      fetchImpl: (async (input, init) => {
        const path = new URL(String(input)).pathname;
        if ((init?.method ?? "GET") === "GET") {
          return Response.json(path === "/api/providers" ? [{ name: "kimi" }] : { providers: deriveProviderPresets() });
        }
        posted.push(JSON.parse(String(init?.body)));
        return Response.json({ success: true, name: "kimi-responses", catalogRefresh: null });
      }) as typeof globalThis.fetch,
    };
    try {
      expect(await lifecycle("add", ["kimi-responses", "--json"], deps)).toBe(0);
      expect(errors).not.toHaveBeenCalled();
    } finally { logs.mockRestore(); errors.mockRestore(); }
    expect(posted).toEqual([{ name: "kimi-responses", provider: { adapter: "openai-responses", baseUrl: KIMI_BASE, authMode: "oauth", defaultModel: "kimi-for-coding" } }]);
  });
});
