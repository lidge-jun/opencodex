import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCodexAuthAPI } from "../src/codex/auth-api";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { handleOauthAccountRoutes } from "../src/server/management/oauth-account-routes";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import {
  bindGoogleAntigravitySessionAffinity,
  getEligibleGoogleAntigravityAccounts,
  getGoogleAntigravityAccountHealthSnapshot,
  googleAntigravitySessionAffinitySizeForTests,
  resetGoogleAntigravityRoutingForManualSelection,
  resolveGoogleAntigravityAccountForSession,
  rotateGoogleAntigravityAccountOnQuotaError,
} from "../src/oauth/google-antigravity-routing";
import { getAccountSet, removeAccount, saveCredential } from "../src/oauth/store";

function makeCodexConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    codexAccounts: [],
    ...overrides,
  };
}

describe("Codex account pool strategy management API", () => {
  const TEST_DIR = join(import.meta.dir, ".tmp-account-pool-mgmt-codex");
  let previousOpencodexHome: string | undefined;

  beforeEach(() => {
    previousOpencodexHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = TEST_DIR;
  });

  afterEach(() => {
    if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpencodexHome;
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  test("GET /api/codex-auth/active surfaces strategy defaults", async () => {
    const req = new Request("http://localhost/api/codex-auth/active", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toMatchObject({
      accountPoolStrategy: "quota",
      accountPoolStickyLimit: 1,
    });
  });

  test("GET /api/codex-auth/active surfaces configured strategy", async () => {
    const config = makeCodexConfig({
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 3,
    });
    const req = new Request("http://localhost/api/codex-auth/active", { method: "GET" });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(await resp!.json()).toMatchObject({
      accountPoolStrategy: "round-robin",
      accountPoolStickyLimit: 3,
    });
  });

  test("PUT /api/codex-auth/pool-strategy rejects invalid strategy", async () => {
    for (const bad of ["weighted", "", 1, null, "Quota"]) {
      const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ strategy: bad }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
      expect(resp!.status).toBe(400);
    }
  });

  test("PUT /api/codex-auth/pool-strategy rejects invalid stickyLimit", async () => {
    for (const bad of [0, 101, 1.5, "2", null, Number.NaN]) {
      const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stickyLimit: bad }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
      expect(resp!.status).toBe(400);
    }
  });

  test("PUT /api/codex-auth/pool-strategy accepts valid values and mutates runtime", async () => {
    const config = makeCodexConfig();
    const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "fill-first", stickyLimit: 7 }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toMatchObject({
      ok: true,
      accountPoolStrategy: "fill-first",
      accountPoolStickyLimit: 7,
    });
    expect(config.accountPoolStrategy).toBe("fill-first");
    expect(config.accountPoolStickyLimit).toBe(7);
  });

  test("PATCH /api/codex-auth/pool-strategy accepts round-robin", async () => {
    const config = makeCodexConfig({ accountPoolStrategy: "quota", accountPoolStickyLimit: 1 });
    const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "round-robin", stickyLimit: 2 }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(200);
    expect(config.accountPoolStrategy).toBe("round-robin");
    expect(config.accountPoolStickyLimit).toBe(2);
  });

  test("PUT rejects invalid stickyLimit without mutating a valid strategy in the same body", async () => {
    const config = makeCodexConfig({ accountPoolStrategy: "quota", accountPoolStickyLimit: 1 });
    const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "fill-first", stickyLimit: 0 }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
    expect(resp!.status).toBe(400);
    expect(config.accountPoolStrategy).toBe("quota");
    expect(config.accountPoolStickyLimit).toBe(1);
  });

  test("PUT /api/codex-auth/pool-strategy rejects non-object JSON bodies with 400", async () => {
    for (const raw of ["null", "[]", "\"round-robin\"", "1"]) {
      const req = new Request("http://localhost/api/codex-auth/pool-strategy", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: raw,
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), makeCodexConfig());
      expect(resp!.status).toBe(400);
      expect(await resp!.json()).toMatchObject({ error: "body must be an object" });
    }
  });
});
describe("Anthropic account pool strategy management API", () => {
  let testDir = "";
  let previousHome: string | undefined;
  let isolatedCodexHome: IsolatedCodexHome | null = null;

  function baseConfig(): OcxConfig {
    return {
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "anthropic",
      providers: {
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" },
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          googleMode: "cloud-code-assist",
        },
      },
    } as OcxConfig;
  }

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedCodexHome = installIsolatedCodexHome("ocx-pool-mgmt-codex-");
    testDir = mkdtempSync(join(tmpdir(), "ocx-pool-mgmt-"));
    process.env.OPENCODEX_HOME = testDir;
    saveConfig(baseConfig());
    writeFileSync(join(testDir, "auth.json"), JSON.stringify({
      anthropic: {
        activeAccountId: "aaaa1111",
        accounts: [
          { id: "aaaa1111", credential: { access: "t1", refresh: "r1", expires: 9999999999999, email: "a@example.com", accountId: "acct-1" } },
        ],
      },
      "google-antigravity": {
        activeAccountId: "google-a",
        accounts: [
          { id: "google-a", credential: { access: "ga", refresh: "gra", expires: 9999999999999, projectId: "project-a" } },
          { id: "google-b", credential: { access: "gb", refresh: "grb", expires: 9999999999999, projectId: "project-b" } },
        ],
      },
    }), { mode: 0o600 });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) rmSync(testDir, { recursive: true, force: true });
  });

  test("GET /api/oauth/accounts/pool surfaces strategy defaults", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        strategy: "quota",
        stickyLimit: 1,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool rejects invalid strategy", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          strategy: "weighted",
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool rejects non-object JSON bodies with 400", async () => {
    const server = startServer(0);
    try {
      for (const raw of ["null", "[]", "\"round-robin\""]) {
        const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: raw,
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({ error: "body must be an object" });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool rejects invalid stickyLimit", async () => {
    const server = startServer(0);
    try {
      for (const bad of [0, 101, 2.5]) {
        const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            provider: "anthropic",
            enabled: false,
            stickyLimit: bad,
          }),
        });
        expect(res.status).toBe(400);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("PUT /api/oauth/accounts/pool accepts strategy and stickyLimit; GET reflects them", async () => {
    const server = startServer(0);
    try {
      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          autoSwitchThreshold: 70,
          strategy: "round-robin",
          stickyLimit: 4,
        }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        ok: true,
        enabled: true,
        autoSwitchThreshold: 70,
        strategy: "round-robin",
        stickyLimit: 4,
      });

      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(await get.json()).toMatchObject({
        enabled: true,
        autoSwitchThreshold: 70,
        strategy: "round-robin",
        stickyLimit: 4,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("PUT without strategy fields preserves previously saved strategy", async () => {
    const server = startServer(0);
    try {
      await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          strategy: "fill-first",
          stickyLimit: 9,
        }),
      });
      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: false,
          autoSwitchThreshold: 50,
        }),
      });
      expect(put.status).toBe(200);
      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(await get.json()).toMatchObject({
        enabled: false,
        autoSwitchThreshold: 50,
        strategy: "fill-first",
        stickyLimit: 9,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("PATCH with provider+strategy omits enabled and keeps current enabled", async () => {
    const server = startServer(0);
    try {
      await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          enabled: true,
          strategy: "quota",
        }),
      });
      const patch = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "anthropic",
          strategy: "round-robin",
        }),
      });
      expect(patch.status).toBe(200);
      expect(await patch.json()).toMatchObject({
        ok: true,
        enabled: true,
        strategy: "round-robin",
      });
      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(await get.json()).toMatchObject({
        enabled: true,
        strategy: "round-robin",
      });
    } finally {
      await server.stop(true);
    }
  });

  test("Google Antigravity GET uses backward-compatible pool defaults", async () => {
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/api/oauth/accounts/pool?provider=google-antigravity", server.url));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        provider: "google-antigravity",
        enabled: false,
        autoSwitchThreshold: 80,
        strategy: "quota",
        stickyLimit: 1,
      });
    } finally {
      await server.stop(true);
    }
  });

  test("Google Antigravity PUT validates and persists generic pool settings", async () => {
    const server = startServer(0);
    try {
      const invalid = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          enabled: "yes",
          autoSwitchThreshold: 101,
          strategy: "weighted",
        }),
      });
      expect(invalid.status).toBe(400);

      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "google-antigravity",
          enabled: true,
          autoSwitchThreshold: 65,
          strategy: "fill-first",
          stickyLimit: 6,
        }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({
        ok: true,
        provider: "google-antigravity",
        enabled: true,
        autoSwitchThreshold: 65,
        strategy: "fill-first",
        stickyLimit: 6,
      });

      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=google-antigravity", server.url));
      expect(await get.json()).toMatchObject({ enabled: true, strategy: "fill-first", stickyLimit: 6 });
    } finally {
      await server.stop(true);
    }
  });

  test("Google Antigravity partial updates normalize invalid current pool fields before saving", async () => {
    const invalidConfig = baseConfig() as OcxConfig & {
      googleAntigravityAccountPool: Record<string, unknown>;
    };
    invalidConfig.googleAntigravityAccountPool = {
      enabled: false,
      autoSwitchThreshold: "broken",
      strategy: "weighted",
      stickyLimit: 0,
    };
    const req = new Request("http://localhost/api/oauth/accounts/pool", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider: "google-antigravity", enabled: true }),
    });
    const response = await handleOauthAccountRoutes({
      req,
      url: new URL(req.url),
      config: invalidConfig,
      deps: {},
      convergeCodexCatalog: async () => ({ status: "unchanged" }),
      syncClaudeAgentDefsBestEffort: async () => {},
    });

    expect(response?.status).toBe(200);
    expect(invalidConfig.googleAntigravityAccountPool).toEqual({
      enabled: true,
      autoSwitchThreshold: 80,
      strategy: "quota",
      stickyLimit: 1,
    });
  });

  test("OAuth clear-cooldown rejects unknown accounts but stays idempotent for stored accounts", async () => {
    const server = startServer(0);
    try {
      for (const { provider, knownId } of [
        { provider: "google-antigravity", knownId: "google-b" },
        { provider: "anthropic", knownId: "aaaa1111" },
      ]) {
        const unknownId = `unknown-${provider}-account`;
        const unknown = await fetch(new URL("/api/oauth/accounts/clear-cooldown", server.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, accountId: unknownId }),
        });
        expect(unknown.status).toBe(400);
        const unknownBody = await unknown.json() as { error?: string };
        expect(unknownBody).toMatchObject({ error: "account not found" });
        expect(JSON.stringify(unknownBody)).not.toContain(unknownId);

        const known = await fetch(new URL("/api/oauth/accounts/clear-cooldown", server.url), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider, accountId: knownId }),
        });
        expect(known.status).toBe(200);
        expect(await known.json()).toEqual({ ok: true, cleared: false });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("Google clear-cooldown and manual active selection use provider-owned routing state", async () => {
    const server = startServer(0);
    try {
      const config = baseConfig();
      config.googleAntigravityAccountPool = { enabled: true };
      const set = getAccountSet("google-antigravity")!;
      const aId = set.accounts.find(account => account.id === "google-a")!.id;
      const bId = set.accounts.find(account => account.id === "google-b")!.id;
      bindGoogleAntigravitySessionAffinity("manual-thread", aId);
      expect(rotateGoogleAntigravityAccountOnQuotaError(
        config, aId, "60", "gemini-3.7-flash", "other-thread",
      )).toEqual({ kind: "next-account", accountId: bId });
      expect(getGoogleAntigravityAccountHealthSnapshot(aId)).not.toBeNull();

      const clear = await fetch(new URL("/api/oauth/accounts/clear-cooldown", server.url), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", accountId: aId }),
      });
      expect(clear.status).toBe(200);
      expect(await clear.json()).toMatchObject({ ok: true, cleared: true });
      expect(getGoogleAntigravityAccountHealthSnapshot(aId)).toBeNull();

      const select = await fetch(new URL("/api/oauth/accounts/active", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", accountId: bId }),
      });
      expect(select.status).toBe(200);
      expect(resolveGoogleAntigravityAccountForSession(
        "manual-thread", "gemini-3.7-flash", config,
      )).toMatchObject({ accountId: bId });
    } finally {
      await server.stop(true);
    }
  });

  test("deleting Google account state makes a deterministic re-add immediately eligible", async () => {
    const config = baseConfig();
    config.googleAntigravityAccountPool = { enabled: true, strategy: "round-robin", stickyLimit: 5 };
    saveConfig(config);
    await removeAccount("google-antigravity", "google-a");
    await removeAccount("google-antigravity", "google-b");
    await saveCredential("google-antigravity", {
      access: "delete-access",
      refresh: "delete-refresh",
      expires: Date.now() + 3_600_000,
      accountId: "delete-identity",
      email: "delete@example.test",
      projectId: "delete-project",
    });
    const accountId = getAccountSet("google-antigravity")!.accounts
      .find(account => account.credential.accountId === "delete-identity")!.id;
    rotateGoogleAntigravityAccountOnQuotaError(config, accountId, "120", "gemini-3.7-flash");
    resetGoogleAntigravityRoutingForManualSelection(accountId);
    bindGoogleAntigravitySessionAffinity("deleted-account-thread", accountId);
    expect(getGoogleAntigravityAccountHealthSnapshot(accountId)).not.toBeNull();
    expect(googleAntigravitySessionAffinitySizeForTests()).toBe(1);

    const server = startServer(0);
    try {
      const removed = await fetch(new URL(
        `/api/oauth/accounts?provider=google-antigravity&id=${encodeURIComponent(accountId)}`,
        server.url,
      ), { method: "DELETE" });
      expect(removed.status).toBe(200);
      expect(getGoogleAntigravityAccountHealthSnapshot(accountId)).toBeNull();
      expect(googleAntigravitySessionAffinitySizeForTests()).toBe(0);

      await saveCredential("google-antigravity", {
        access: "replacement-access",
        refresh: "replacement-refresh",
        expires: Date.now() + 3_600_000,
        accountId: "replacement-identity",
        email: "replacement@example.test",
        projectId: "replacement-project",
      });
      const replacementId = getAccountSet("google-antigravity")!.accounts
        .find(account => account.credential.accountId === "replacement-identity")!.id;
      await saveCredential("google-antigravity", {
        access: "delete-access-new",
        refresh: "delete-refresh-new",
        expires: Date.now() + 3_600_000,
        accountId: "delete-identity",
        email: "delete@example.test",
        projectId: "delete-project",
      });
      const readdedId = getAccountSet("google-antigravity")!.accounts
        .find(account => account.credential.accountId === "delete-identity")!.id;
      expect(readdedId).toBe(accountId);
      expect(getEligibleGoogleAntigravityAccounts()).toContain(accountId);
      expect(resolveGoogleAntigravityAccountForSession(
        "post-delete-rotation", "gemini-3.7-flash", config,
      )).toMatchObject({ accountId: replacementId, reason: "round-robin" });
    } finally {
      await server.stop(true);
    }
  });
});
