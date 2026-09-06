import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, writePid, writeRuntimePort } from "../../src/config";
import { commitKeyLoginProvider, providerConfigFromKeyLoginProvider } from "../../src/oauth/login-cli";
import { KEY_LOGIN_PROVIDERS } from "../../src/oauth/key-providers";
import { startServer } from "../../src/server";
import { createLocalAttestationSecret } from "../../src/lib/local-management-attestation";
import type { LocalProviderReloadResult } from "../../src/server/local-provider-reload-client";
import type { OcxConfig } from "../../src/types";
import { refreshUserCostOverlays } from "../../src/usage/user-cost-overlays";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { managementFetch as fetch } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Regression: `ocx login <key-provider>` used to POST the unmerged preset row
 * into a running proxy. The proxy then saved the replacement without the
 * preserved modelCosts overlay, undoing the just-written disk state until a
 * restart (the live row had no existingCosts to carry forward).
 */
let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let upstream: ReturnType<typeof Bun.serve> | undefined;

function umansKeyConfig(baseUrl: string, port = 0): OcxConfig {
  return {
    port,
    hostname: "127.0.0.1",
    defaultProvider: "umans",
    providers: {
      umans: {
        adapter: "anthropic",
        baseUrl,
        allowPrivateNetwork: true,
        apiKey: "sk-old",
      },
    },
  } as OcxConfig;
}

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-key-login-live-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-key-login-live-"));
  process.env.OPENCODEX_HOME = testDir;
  // Reload validates the provider destination before adopting disk state. Use an
  // owned literal address so this persistence regression cannot wait on public DNS.
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ data: [{ id: "umans-coder", type: "model" }] }),
  });
  saveConfig(umansKeyConfig(upstream.url.toString()));
});

afterEach(async () => {
  try {
    await upstream?.stop(true);
  } finally {
    upstream = undefined;
    // The overlay registry is module-level; reset it so rows added through the
    // live provider update path cannot leak into later tests in a shared run.
    refreshUserCostOverlays({ providers: {} } as unknown as OcxConfig);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
  }
});

describe("CLI key-login live-update overlay preservation", () => {
  test("notify after key login pushes the merged row and keeps modelCosts on live and disk", async () => {
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

      // The proxy booted before the overlay existed; a hand-edit then adds
      // modelCosts to disk only, so the live in-memory row has no overlay yet.
      const edited = loadConfig();
      edited.providers.umans!.modelCosts = {
        "umans-coder": { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
      };
      saveConfig(edited);

      const config = loadConfig();
      const replacement = {
        ...providerConfigFromKeyLoginProvider(KEY_LOGIN_PROVIDERS.umans, "sk-rotated", config.providers.umans!.baseUrl),
        allowPrivateNetwork: true,
      };
      const reloads: Array<LocalProviderReloadResult | null> = [];
      const merged = await commitKeyLoginProvider(config, "umans", replacement, result => { reloads.push(result); });
      expect(reloads).toEqual([{ kind: "reloaded" }]);
      expect(merged.modelCosts).toEqual(edited.providers.umans!.modelCosts);

      // Reload treats disk as authoritative and never re-saves it.
      const disk = JSON.parse(readFileSync(join(testDir, "config.json"), "utf-8")) as OcxConfig;
      expect(disk.providers.umans!.modelCosts).toEqual(edited.providers.umans!.modelCosts);
      expect(disk.providers.umans!.apiKey).toBe("sk-rotated");

      // The running proxy must also carry the overlay in its live config:
      // A silent early return or failed reload would leave the in-memory DTO stale
      // even though disk is correct.
      const response = await fetch(new URL("/api/config", server.url));
      expect(response.status).toBe(200);
      const live = (await response.json()) as {
        providers: Record<string, { modelCosts?: Record<string, unknown> }>;
      };
      expect(live.providers.umans?.modelCosts).toEqual(edited.providers.umans!.modelCosts);
    } finally {
      await server.stop(true);
    }
  }, 15_000);
});
