import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, loadConfig, saveConfig } from "../../src/config";
import { routedProviderConfig } from "../../src/router";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { setProviderApiKeyPaused } from "../../src/providers/api-key-pause";
import { captureAccountAutoPauseAttempt } from "../../src/oauth/account-auto-pause";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { openAIChatTransport } from "../../src/adapters/openai-chat/wire";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";

const KEY_ID = "key-1";
const KEY_VALUE = "synthetic-key-1";
const refusal = () => Response.json(
  { error: { type: "permission_error", message: "Your subscription has expired." } },
  { status: 403 },
);

const oldHome = process.env.OPENCODEX_HOME;
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "ocx-key-pause-oauth-")); process.env.OPENCODEX_HOME = home; });
afterEach(() => {
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldHome;
  removeTreeWithRetry(home);
});

function keyModeProvider(name: "xai" | "github-copilot", keys: Array<{ id: string; key: string }> = [{ id: KEY_ID, key: KEY_VALUE }]): OcxProviderConfig {
  const provider = providerConfigSeed(getProviderRegistryEntry(name)!);
  provider.authMode = "key";
  provider.apiKey = keys[0]!.key;
  provider.apiKeyPool = keys;
  return provider;
}

function configFor(provider: OcxProviderConfig, name: "xai" | "github-copilot"): OcxConfig {
  const config = getDefaultConfig();
  config.providers = { [name]: provider };
  config.defaultProvider = name;
  return config;
}

/** A stored OAuth account must exist so the regression cannot pass by having nothing to leak. */
async function storeOAuthAccount(name: string): Promise<string> {
  await saveCredential(name, {
    access: "synthetic-access", refresh: "synthetic-refresh",
    expires: Date.now() + 3_600_000, accountId: "synthetic-account", source: "oauth",
  });
  const set = getAccountSet(name)!;
  const id = set.accounts[0]!.id;
  await setActiveAccount(name, id);
  expect(set.accounts.length).toBe(1);
  return id;
}

describe("explicit key mode with stored OAuth and no usable key", () => {
  for (const name of ["xai", "github-copilot"] as const) {
    test(name + ": manual last-key pause stays key auth and the transport refuses", async () => {
      const provider = keyModeProvider(name);
      const config = configFor(provider, name);
      saveConfig(config);
      await storeOAuthAccount(name);

      expect(setProviderApiKeyPaused(config, name, KEY_ID, true)).toBe(true);
      const stored = config.providers[name]!;
      expect(stored.apiKey).toBeUndefined();
      expect(stored.apiKeyPool![0]!.disabled).toBe(true);
      expect(loadConfig().providers[name]!.apiKeyPool![0]!.disabled).toBe(true);

      // authMode "key" is operator intent: an unavailable credential fails closed and must
      // never be reclassified to registry OAuth, which would attach the stored account.
      const routed = routedProviderConfig(name, stored);
      expect(routed.authMode).toBe("key");
      expect(routed.apiKey).toBeUndefined();
      expect(() => openAIChatTransport(routed)).toThrow(/requires a non-empty credential/);
    });

    test(name + ": automatic last-key pause stays key auth and the transport refuses", async () => {
      const provider = keyModeProvider(name);
      provider.accountAutoPause = { enabled: true, consecutiveFailures: 1 };
      const config = configFor(provider, name);
      saveConfig(config);
      await storeOAuthAccount(name);

      const routed = routedProviderConfig(name, config.providers[name]!);
      const observe = captureAccountAutoPauseAttempt(name, routed, { config },
        new Headers({ authorization: "Bearer " + routed.apiKey }))!;
      await observe(refusal());

      const stored = config.providers[name]!;
      expect(stored.apiKeyPool![0]!.disabled).toBe(true);
      expect(stored.apiKey).toBeUndefined();
      const after = routedProviderConfig(name, stored);
      expect(after.authMode).toBe("key");
      expect(after.apiKey).toBeUndefined();
      expect(() => openAIChatTransport(after)).toThrow(/requires a non-empty credential/);
    });

    test(name + ": unpausing the key restores key auth and its Bearer credential", async () => {
      const provider = keyModeProvider(name);
      const config = configFor(provider, name);
      saveConfig(config);
      await storeOAuthAccount(name);

      expect(setProviderApiKeyPaused(config, name, KEY_ID, true)).toBe(true);
      expect(setProviderApiKeyPaused(config, name, KEY_ID, false)).toBe(true);
      const routed = routedProviderConfig(name, config.providers[name]!);
      expect(routed.authMode).toBe("key");
      expect(routed.apiKey).toBe(KEY_VALUE);
      const transport = openAIChatTransport(routed);
      expect(transport.hasCredential).toBe(true);
      expect(transport.headers.Authorization).toBe("Bearer " + KEY_VALUE);
    });

    test(name + ": an unresolved env key reference stays key mode and fails closed", async () => {
      const envName = "OCX_KEY_PAUSE_BOUNDARY_" + name.replace(/-/g, "_").toUpperCase();
      const previous = process.env[envName];
      delete process.env[envName];
      try {
        const provider = keyModeProvider(name, [{ id: KEY_ID, key: "$" + "{" + envName + "}" }]);
        const config = configFor(provider, name);
        saveConfig(config);
        await storeOAuthAccount(name);

        const routed = routedProviderConfig(name, config.providers[name]!);
        expect(routed.authMode).toBe("key");
        expect(routed.apiKey).toBeUndefined();
        expect(() => openAIChatTransport(routed)).toThrow(/requires a non-empty credential/);
      } finally {
        if (previous === undefined) delete process.env[envName];
        else process.env[envName] = previous;
      }
    });

    test(name + ": pausing one pool key rotates to the next key", async () => {
      const provider = keyModeProvider(name, [
        { id: "key-1", key: "synthetic-key-1" },
        { id: "key-2", key: "synthetic-key-2" },
      ]);
      const config = configFor(provider, name);
      saveConfig(config);

      expect(setProviderApiKeyPaused(config, name, "key-1", true)).toBe(true);
      const routed = routedProviderConfig(name, config.providers[name]!);
      expect(routed.authMode).toBe("key");
      expect(routed.apiKey).toBe("synthetic-key-2");
      expect(openAIChatTransport(routed).headers.Authorization).toBe("Bearer synthetic-key-2");
    });

    test(name + ": an explicit oauth authMode still routes through OAuth", () => {
      const provider = keyModeProvider(name);
      provider.authMode = "oauth";
      const config = configFor(provider, name);
      const routed = routedProviderConfig(name, config.providers[name]!);
      expect(routed.authMode).toBe("oauth");
    });

    test(name + ": an unset authMode keeps the registry OAuth lane", () => {
      const provider = providerConfigSeed(getProviderRegistryEntry(name)!);
      delete provider.authMode;
      provider.apiKey = KEY_VALUE;
      const config = configFor(provider, name);
      const routed = routedProviderConfig(name, config.providers[name]!);
      expect(routed.authMode).toBe("oauth");
    });
  }
});
