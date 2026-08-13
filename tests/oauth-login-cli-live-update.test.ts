import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { managementFetch as fetch } from "./helpers/management-auth";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, writePid, writeRuntimePort } from "../src/config";
import { upsertOAuthProvider } from "../src/oauth";
import {
  commitKeyLoginProvider,
  notifyRunningProxy,
  notifyRunningProxyAfterOAuthLogin,
} from "../src/oauth/login-cli";
import { startServer } from "../src/server";
import { createLocalAttestationSecret } from "../src/lib/local-management-attestation";
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
  test("does not post provider credentials when a legacy health listener has no verified pid", async () => {
    const receivedPaths: string[] = [];
    let healthProbeCount = 0;
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/healthz") {
          healthProbeCount += 1;
          return Response.json({ status: "ok", version: "2.6.16", uptime: 5 });
        }
        receivedPaths.push(url.pathname);
        return Response.json({ ok: true });
      },
    });
    try {
      saveConfig(keyModeXaiConfig(listener.port));

      await notifyRunningProxy("xai");

      expect(healthProbeCount).toBeGreaterThan(0);
      expect(receivedPaths).toEqual([]);
    } finally {
      await listener.stop(true);
    }
  }, 15_000);

  test("does not probe or post for a provider outside the login-owned allowlist", async () => {
    const receivedPaths: string[] = [];
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        receivedPaths.push(new URL(request.url).pathname);
        return Response.json({ status: "ok" });
      },
    });
    try {
      const custom = keyModeXaiConfig(listener.port);
      custom.defaultProvider = "custom";
      custom.providers.custom = {
        adapter: "openai-chat",
        baseUrl: "https://custom.example.test/v1",
        apiKey: "custom-sentinel-key",
      };
      saveConfig(custom);

      await notifyRunningProxy("custom");

      expect(receivedPaths).toEqual([]);
    } finally {
      await listener.stop(true);
    }
  });

  test("notify after OAuth login keeps key billing on live and disk configs", async () => {
    const localAttestationSecret = createLocalAttestationSecret();
    const server = startServer(0, { localAttestationSecret });
    try {
      const port = server.port!;
      writeRuntimePort({
        pid: process.pid,
        port,
        hostname: "127.0.0.1",
        attestationSecret: localAttestationSecret,
      });
      writePid(process.pid);
      const boot = loadConfig();
      boot.port = port;
      saveConfig(boot);

      // Mirror runLogin()'s disk write: upsert preserves key material, then save.
      const afterLogin = loadConfig();
      upsertOAuthProvider(afterLogin, "xai");
      saveConfig(afterLogin);
      expect(afterLogin.providers.xai!.authMode).toBe("key");
      expect(afterLogin.providers.xai!.apiKey).toBe("live-update-sentinel-key");

      const beforeNotify = readFileSync(join(testDir, "config.json"));
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
      expect(readFileSync(join(testDir, "config.json"))).toEqual(beforeNotify);
    } finally {
      await server.stop(true);
    }
  }, 15_000);
});

/**
 * Regression: the reload outcome used to be discarded, so a CLI talking to a proxy that
 * predates attested reload printed unconditional success while the running process kept
 * routing with the previous credential. The credential does reach disk — that part was
 * always fine — but the operator had no way to learn a restart was required.
 */
describe("live reload outcome is reported to the caller", () => {
  test("an unattested running proxy yields a diagnosable reason, not silence", async () => {
    let healthProbeCount = 0;
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/healthz") {
          healthProbeCount += 1;
          // A pre-update proxy: healthy, but it advertises no attestation capability.
          return Response.json({ status: "ok", version: "2.6.16", uptime: 5 });
        }
        return Response.json({ ok: true });
      },
    });
    try {
      saveConfig(keyModeXaiConfig(listener.port));

      const result = await notifyRunningProxy("xai");

      expect(healthProbeCount).toBeGreaterThan(0);
      // The caller can tell "could not reload" apart from "nothing to reload".
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("unavailable");
    } finally {
      await listener.stop(true);
    }
  }, 15_000);

  test("no running proxy is null, which must not warn", async () => {
    // Nothing is listening, so there is nothing to reload and nothing to warn about.
    const result = await notifyRunningProxy("xai");
    expect(result).toBeNull();
  }, 15_000);

  test("a provider outside the live-reload allowlist is null rather than a failure", async () => {
    const custom = keyModeXaiConfig();
    custom.providers.custom = {
      adapter: "openai-chat",
      baseUrl: "https://custom.example.test/v1",
      apiKey: "custom-sentinel-key",
    };
    saveConfig(custom);

    expect(await notifyRunningProxy("custom")).toBeNull();
  });

  /**
   * `onLiveReload?.(await notifyRunningProxy(name))` reads as "reload, then hand the result
   * to an optional callback", but optional-call short-circuiting skips the entire argument
   * list when the callback is absent — so the reload silently never happens for every caller
   * that does not pass one. That regression was caught once; pin it.
   */
  test("commit still reloads when no outcome callback is supplied", async () => {
    let healthProbeCount = 0;
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/healthz") healthProbeCount += 1;
        return Response.json({ status: "ok", version: "2.6.16", uptime: 5 });
      },
    });
    try {
      saveConfig(keyModeXaiConfig(listener.port));
      const config = loadConfig();

      // No callback argument on purpose: this is the short-circuit shape.
      await commitKeyLoginProvider(config, "xai", config.providers.xai!);

      expect(healthProbeCount).toBeGreaterThan(0);
    } finally {
      await listener.stop(true);
    }
  }, 15_000);
});
