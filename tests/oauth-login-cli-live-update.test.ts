import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../src/config";
import { upsertOAuthProvider } from "../src/oauth";
import { notifyRunningProxyAfterOAuthLogin } from "../src/oauth/login-cli";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";

/**
 * Regression: CLI OAuth login used to POST the bare OAuth preset into a running proxy.
 * That wiped the preserved apiKey / apiKeyPool / authMode:"key" that runLogin had just
 * written, then saved the stripped entry back to disk.
 */
let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

function keyModeXaiConfig(port = 0): OcxConfig {
  return {
    port,
    hostname: "127.0.0.1",
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "live-update-sentinel-key",
        apiKeyPool: [{ id: "livekey01", key: "live-update-sentinel-key" }],
      },
    },
  } as OcxConfig;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-oauth-live-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-oauth-live-"));
  process.env.OPENCODEX_HOME = testDir;
  saveConfig(keyModeXaiConfig());
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe("CLI OAuth live-update credential preservation", () => {
  test("notify after OAuth login keeps key billing on live and disk configs", async () => {
    const server = startServer(0);
    try {
      const port = server.port!;
      const boot = loadConfig();
      boot.port = port;
      saveConfig(boot);

      // Mirror runLogin()'s disk write: upsert preserves key material, then save.
      const afterLogin = loadConfig();
      upsertOAuthProvider(afterLogin, "xai");
      saveConfig(afterLogin);
      expect(afterLogin.providers.xai!.authMode).toBe("key");
      expect(afterLogin.providers.xai!.apiKey).toBe("live-update-sentinel-key");

      await notifyRunningProxyAfterOAuthLogin("xai");

      const listed = await fetch(new URL("/api/providers", server.url)).then(r => r.json()) as Array<{
        name: string;
        authMode?: string;
        hasApiKey?: boolean;
      }>;
      const live = listed.find(entry => entry.name === "xai");
      expect(live?.authMode).toBe("key");
      expect(live?.hasApiKey).toBe(true);

      const pool = await fetch(new URL("/api/providers/keys?name=xai", server.url)).then(r => r.json()) as {
        activeId: string | null;
        keys: Array<{ id: string; active: boolean }>;
      };
      expect(pool.activeId).toBeTruthy();
      expect(pool.keys.some(entry => entry.active)).toBe(true);

      const disk = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8")) as OcxConfig;
      expect(disk.providers.xai!.authMode).toBe("key");
      expect(disk.providers.xai!.apiKey).toBe("live-update-sentinel-key");
      expect(disk.providers.xai!.apiKeyPool?.some(entry => entry.key === "live-update-sentinel-key")).toBe(true);
    } finally {
      await server.stop(true);
    }
  }, 15_000);
});
