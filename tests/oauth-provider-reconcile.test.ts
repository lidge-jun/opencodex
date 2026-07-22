import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { reconcileOAuthProviders } from "../src/oauth";
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
        },
      },
    } satisfies OcxConfig;

    expect(reconcileOAuthProviders(config)).toBe(true);
    const provider = config.providers["google-antigravity"];
    expect(provider.defaultModel).toBe("gemini-3.6-flash");
    expect(provider.models).toEqual([
      "gemini-3.6-flash",
      "gemini-3.1-pro",
      "claude-sonnet-4-6",
      "claude-opus-4-6-thinking",
      "gpt-oss-120b-medium",
    ]);
    expect(provider.models).not.toContain("gemini-3.5-flash-low");
    expect(provider.models).not.toContain("gemini-3.6-flash-low");
    expect(provider.models).not.toContain("gemini-3.6-flash-medium");
    expect(provider.models).not.toContain("gemini-3.6-flash-high");
    expect(provider.modelContextWindows?.["gemini-3.6-flash"]).toBe(1_048_576);
    expect(provider.project).toBe("config-project-sentinel");
    expect(provider.note).toBe("user-owned-note");
    expect(getCredential("google-antigravity")).toMatchObject({
      access: "sentinel-access",
      refresh: "sentinel-refresh",
      projectId: "sentinel-project",
    });

    const persisted = loadConfig();
    expect(persisted.providers["google-antigravity"]?.defaultModel).toBe("gemini-3.6-flash");
    expect(reconcileOAuthProviders(config)).toBe(false);
  });
});
