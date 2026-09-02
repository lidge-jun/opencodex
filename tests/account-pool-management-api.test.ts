import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleCodexAuthAPI } from "../src/codex/auth-api";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { removeTreeWithRetry } from "./helpers/remove-tree";

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
    removeTreeWithRetry(TEST_DIR);
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
    }), { mode: 0o600 });
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
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

  test("GET returns quotaWindow five-hour by default", async () => {
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ quotaWindow: "five-hour" });
    } finally {
      await server.stop(true);
    }
  });

  test("PUT persists each valid quotaWindow value", async () => {
    const server = startServer(0);
    try {
      for (const quotaWindow of ["weekly", "max-utilization", "five-hour"]) {
        const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "anthropic", enabled: true, quotaWindow }),
        });
        expect(put.status).toBe(200);
        expect(await put.json()).toMatchObject({ ok: true, quotaWindow });

        const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
        expect(await get.json()).toMatchObject({ quotaWindow });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("PUT rejects invalid quotaWindow with 400", async () => {
    const server = startServer(0);
    try {
      for (const bad of ["monthly", "", "Weekly", 1, null]) {
        const res = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ provider: "anthropic", enabled: true, quotaWindow: bad }),
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toMatchObject({
          error: "quotaWindow must be one of: five-hour, weekly, max-utilization",
        });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("PUT without quotaWindow preserves the existing value", async () => {
    const server = startServer(0);
    try {
      const first = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", enabled: true, quotaWindow: "weekly" }),
      });
      expect(first.status).toBe(200);

      const second = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "anthropic", enabled: false, autoSwitchThreshold: 55 }),
      });
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({ quotaWindow: "weekly" });

      const get = await fetch(new URL("/api/oauth/accounts/pool?provider=anthropic", server.url));
      expect(await get.json()).toMatchObject({
        enabled: false,
        autoSwitchThreshold: 55,
        quotaWindow: "weekly",
      });
    } finally {
      await server.stop(true);
    }
  });
});

describe("generic OAuth pool-settings contract (#695)", () => {
  let previousHome: string | undefined;
  let testDir = "";
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    testDir = mkdtempSync(join(tmpdir(), "ocx-pool-generic-"));
    process.env.OPENCODEX_HOME = testDir;
    saveConfig({
      port: 0,
      hostname: "127.0.0.1",
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": { adapter: "google", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" },
        deepseek: { adapter: "openai-chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "deepseek-key-fixture" },
      },
    } as OcxConfig);
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (testDir) removeTreeWithRetry(testDir);
  });

  test("GET/PUT round-trip for a generic OAuth provider; api-key providers and bad values get 400", async () => {
    const server = startServer(0);
    try {
      const absent = await fetch(new URL("/api/oauth/accounts/pool?provider=google-antigravity", server.url));
      expect(absent.status).toBe(200);
      expect(await absent.json()).toEqual({ provider: "google-antigravity", kind: "generic", enabled: null, strategy: null, autoSwitchThreshold: null, inert: true });

      const put = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", strategy: "fill-first", autoSwitchThreshold: 90, enabled: true }),
      });
      expect(put.status).toBe(200);
      expect(await put.json()).toMatchObject({ ok: true, strategy: "fill-first", autoSwitchThreshold: 90, enabled: true, inert: true });
      const saved = JSON.parse(readFileSync(join(testDir, "config.json"), "utf8"));
      expect(saved.providers["google-antigravity"].oauthAccountFailover).toEqual({ enabled: true, strategy: "fill-first", autoSwitchThreshold: 90 });

      for (const body of [
        { provider: "google-antigravity", strategy: "weighted" },
        { provider: "google-antigravity", autoSwitchThreshold: 101 },
        { provider: "google-antigravity", stickyLimit: 3 },
        { provider: "deepseek", strategy: "quota" },
      ]) {
        const bad = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        expect(bad.status).toBe(400);
      }
      expect((await fetch(new URL("/api/oauth/accounts/pool?provider=deepseek", server.url))).status).toBe(400);

      const clear = await fetch(new URL("/api/oauth/accounts/pool", server.url), {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: "google-antigravity", strategy: null, autoSwitchThreshold: null }),
      });
      expect(clear.status).toBe(200);
      expect(await clear.json()).toMatchObject({ strategy: null, autoSwitchThreshold: null, enabled: true });
    } finally {
      await server.stop(true);
    }
  });
});
