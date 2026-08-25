import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearGenericFailoverHealth,
  eligibleFailoverAccounts,
  genericFailoverRetryAfterSeconds,
  isGenericFailoverProvider,
  isGenericOAuthFailoverEnabled,
  rotateGenericOAuthAccountOn429,
} from "../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential } from "../src/oauth/store";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-generic-failover-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
});

afterEach(() => {
  clearGenericFailoverHealth();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
});

const OAUTH_PROVIDER = {
  adapter: "openai-chat",
  baseUrl: "https://api.x.ai/v1",
  authMode: "oauth",
} as unknown as OcxProviderConfig;

function config(enabled: boolean): OcxConfig {
  return {
    providers: { xai: OAUTH_PROVIDER },
    ...(enabled ? { oauthAccountFailover: { enabled: true } } : {}),
  } as unknown as OcxConfig;
}

async function seed(count: number): Promise<string[]> {
  for (let i = 0; i < count; i++) {
    await saveCredential("xai", {
      access: `access-${i}`,
      refresh: `refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `uuid-${i}`,
    } as never, { addAccount: true });
  }
  return getAccountSet("xai")?.accounts.map(a => a.id) ?? [];
}

describe("#2568 generic OAuth account failover", () => {
  test("rotates to another logged-in account and cools the one that 429'd", async () => {
    const [first, second] = await seed(2);
    const next = rotateGenericOAuthAccountOn429(config(true), "xai", first!, null);
    expect(next).toBe(second);
    // The failed account is cooled, so it is not offered again while the window holds.
    expect(eligibleFailoverAccounts("xai")).toEqual([second!]);
  });

  test("a single stored account is a strict no-op", async () => {
    // Rotating to itself would replay the same 429 against the same credential, and cooling
    // the only account would take the provider out of service for nothing.
    const [solo] = await seed(1);
    expect(rotateGenericOAuthAccountOn429(config(true), "xai", solo!, null)).toBeNull();
    expect(eligibleFailoverAccounts("xai")).toEqual([solo!]);
  });

  test("the knob off is a strict no-op regardless of account count", async () => {
    const ids = await seed(2);
    expect(rotateGenericOAuthAccountOn429(config(false), "xai", ids[0]!, null)).toBeNull();
    expect(eligibleFailoverAccounts("xai")).toEqual(ids);
  });

  test("Codex and Anthropic are excluded: their own pools own rotation", () => {
    expect(isGenericFailoverProvider("xai", OAUTH_PROVIDER)).toBe(true);
    expect(isGenericFailoverProvider("openai", OAUTH_PROVIDER)).toBe(false);
    expect(isGenericFailoverProvider("anthropic", OAUTH_PROVIDER)).toBe(false);
  });

  test("a key-auth provider never enters generic OAuth rotation", () => {
    const key = { ...OAUTH_PROVIDER, authMode: "key" } as OcxProviderConfig;
    expect(isGenericFailoverProvider("groq", key)).toBe(false);
  });

  test("all accounts cooled reports the earliest remaining window", async () => {
    const ids = await seed(2);
    const cfg = config(true);
    expect(rotateGenericOAuthAccountOn429(cfg, "xai", ids[0]!, "120")).toBe(ids[1]);
    expect(rotateGenericOAuthAccountOn429(cfg, "xai", ids[1]!, "30")).toBeNull();
    const retryAfter = genericFailoverRetryAfterSeconds("xai");
    // The earliest window wins: a client must not be told to wait for the longest cooldown.
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter!).toBeLessThanOrEqual(30);
  });

  test("Retry-After drives the cooldown length", async () => {
    const ids = await seed(2);
    rotateGenericOAuthAccountOn429(config(true), "xai", ids[0]!, "600");
    expect(genericFailoverRetryAfterSeconds("xai")).toBeGreaterThan(500);
  });

  test("enablement requires both the knob and a participating OAuth provider", async () => {
    await seed(2);
    expect(isGenericOAuthFailoverEnabled(config(true), "xai")).toBe(true);
    expect(isGenericOAuthFailoverEnabled(config(false), "xai")).toBe(false);
    expect(isGenericOAuthFailoverEnabled(config(true), "openai")).toBe(false);
  });
});

