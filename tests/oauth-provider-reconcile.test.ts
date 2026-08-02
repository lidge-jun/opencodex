import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { OAUTH_PROVIDERS, reconcileOAuthProviders, upsertOAuthProvider } from "../src/oauth";
import { getCredential, saveCredential } from "../src/oauth/store";
import type { OcxConfig } from "../src/types";

const originalHome = process.env.OPENCODEX_HOME;
const homes: string[] = [];

afterEach(() => {
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("OAuth provider reconciliation", () => {
  test("migrates a saved Antigravity 3.5 preset without touching credentials or user fields", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-gemini-36-reconcile-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    await saveCredential("google-antigravity", {
      access: "sentinel-access",
      refresh: "sentinel-refresh",
      expires: Date.now() + 60_000,
      projectId: "sentinel-project",
    });
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          adapter: "google",
          baseUrl: "https://daily-cloudcode-pa.googleapis.com",
          authMode: "oauth",
          googleMode: "cloud-code-assist",
          defaultModel: "gemini-3.5-flash-low",
          models: ["gemini-3.5-flash-low", "gemini-3.5-flash-high"],
          modelContextWindows: { "gemini-3.5-flash-low": 1_048_576 },
          project: "config-project-sentinel",
          note: "user-owned-note",
          // This is deliberately ambiguous: old Provider Settings saves and manual edits
          // persisted the same value, so the versioned migration normalizes both once.
          liveModels: true,
        },
      },
    } satisfies OcxConfig;

    expect(reconcileOAuthProviders(config)).toBe(true);
    const provider = config.providers["google-antigravity"];
    expect(provider.defaultModel).toBe("gemini-3.6-flash");
    expect(provider.models).toEqual([
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "gemini-3.1-flash-image",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    expect(provider.models).not.toContain("gemini-3.5-flash-low");
    expect(provider.models).not.toContain("gemini-3.6-flash-low");
    expect(provider.models).not.toContain("gemini-3.6-flash-medium");
    expect(provider.models).not.toContain("gemini-3.6-flash-high");
    expect(provider.modelContextWindows?.["gemini-3.6-flash"]).toBe(1_048_576);
    expect(provider.liveModels).toBe(false);
    expect(config.googleAntigravityStaticCatalogVersion).toBe(1);
    expect(provider.project).toBe("config-project-sentinel");
    expect(provider.note).toBe("user-owned-note");
    expect(getCredential("google-antigravity")).toMatchObject({
      access: "sentinel-access",
      refresh: "sentinel-refresh",
      projectId: "sentinel-project",
    });

    const persisted = loadConfig();
    expect(persisted.providers["google-antigravity"]?.defaultModel).toBe("gemini-3.6-flash");
    expect(persisted.providers["google-antigravity"]?.liveModels).toBe(false);
    expect(persisted.googleAntigravityStaticCatalogVersion).toBe(1);
    expect(reconcileOAuthProviders(config)).toBe(false);
  });

  test("preserves an explicit Antigravity liveModels override during reconcile and re-login", () => {
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      googleAntigravityStaticCatalogVersion: 1,
      providers: {
        "google-antigravity": {
          ...structuredClone(OAUTH_PROVIDERS["google-antigravity"].providerConfig),
          liveModels: true,
        },
      },
    } satisfies OcxConfig;

    expect(reconcileOAuthProviders(config)).toBe(false);
    expect(config.providers["google-antigravity"].liveModels).toBe(true);

    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(true);
    expect(config.providers["google-antigravity"].models).toHaveLength(6);
  });

  test("normalizes ambiguous pre-marker Antigravity rows even when authMode is omitted or non-OAuth", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-antigravity-authmode-reconcile-"));
    homes.push(home);
    process.env.OPENCODEX_HOME = home;
    const preset = OAUTH_PROVIDERS["google-antigravity"].providerConfig;

    for (const authMode of [undefined, "key"] as const) {
      const provider = {
        ...structuredClone(preset),
        liveModels: true,
        defaultModel: "gemini-3.5-flash-low",
        models: ["gemini-3.5-flash-low", "gemini-3.5-flash-high"],
      };
      if (authMode === undefined) delete provider.authMode;
      else provider.authMode = authMode;
      const config = {
        port: 10100,
        defaultProvider: "google-antigravity",
        providers: { "google-antigravity": provider },
      } satisfies OcxConfig;

      expect(reconcileOAuthProviders(config)).toBe(true);
      expect(config.googleAntigravityStaticCatalogVersion).toBe(1);
      const migrated = config.providers["google-antigravity"];
      expect(migrated.liveModels).toBe(false);
      expect(migrated.defaultModel).toBe(preset.defaultModel);
      expect(migrated.models).toEqual(preset.models);
      expect(migrated.authMode).toBe(authMode);
    }
  });

  test("normalizes ambiguous pre-marker true during re-login, then preserves later overrides", () => {
    const config = {
      port: 10100,
      defaultProvider: "google-antigravity",
      providers: {
        "google-antigravity": {
          ...structuredClone(OAUTH_PROVIDERS["google-antigravity"].providerConfig),
          liveModels: true,
        },
      },
    } satisfies OcxConfig;

    upsertOAuthProvider(config, "google-antigravity");
    expect(config.googleAntigravityStaticCatalogVersion).toBe(1);
    expect(config.providers["google-antigravity"].liveModels).toBe(false);

    config.providers["google-antigravity"].liveModels = true;
    config.providers["google-antigravity"].authMode = "key";
    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(true);

    config.providers["google-antigravity"].authMode = undefined;
    upsertOAuthProvider(config, "google-antigravity");
    expect(config.providers["google-antigravity"].liveModels).toBe(true);
  });
});
