import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

/**
 * The sidecar wiring (#2568).
 *
 * The rotator above is a pure module and the two sidecar loops are covered by their own await
 * tests, but neither reaches the part that actually closes the gap: the `on429` hook `core.ts`
 * injects into the image and web-search loops. That hook is a closure over request-local state
 * (`route`, `genericFailoverAccountId`, `genericFailovers`), so it is not importable, and
 * driving it end to end means standing up a full sidecar request against a stubbed provider.
 *
 * These are structural assertions on the source, in the same spirit as the route-inventory
 * contract in `codex-convergence-contract.test.ts`: they cannot prove the rotation works, and
 * they are not a substitute for the loop tests — but they DO catch the regression that actually
 * threatens this feature, which is one sidecar silently keeping a key-pool-only hook while the
 * other gets the OAuth-aware one. That divergence is exactly how the gap was introduced in the
 * first place: the main response path grew generic rotation and the two sidecars did not.
 */
describe("sidecar on429 wiring", () => {
  const coreSource = readFileSync(
    join(import.meta.dir, "..", "src", "server", "responses", "core.ts"),
    "utf8",
  );

  test("both sidecar loops receive the SAME hook, so neither can drift key-pool-only", () => {
    const hooks = coreSource.match(/^\s*on429: (\w+),$/gm)?.map(line => line.trim()) ?? [];
    // Two injection sites — the image bridge and the web-search loop — and one shared hook.
    expect(hooks).toHaveLength(2);
    expect(new Set(hooks).size).toBe(1);
    expect(hooks[0]).toBe("on429: rotateSidecarProviderOn429,");
  });

  test("the shared hook tries the key pool first and only then the OAuth roster", () => {
    const start = coreSource.indexOf("const rotateSidecarProviderOn429 =");
    expect(start).toBeGreaterThan(-1);
    const body = coreSource.slice(start, coreSource.indexOf("\n  };", start));

    // Key-pool rotation stays first and unconditional: an API-key provider must behave exactly
    // as it did before this hook existed.
    const keyPool = body.indexOf("rotateProviderTransportOn429(");
    const oauth = body.indexOf("rotateGenericOAuthAccountOn429(");
    expect(keyPool).toBeGreaterThan(-1);
    expect(oauth).toBeGreaterThan(keyPool);

    // The OAuth branch is gated on all three of: an account this request actually used, the
    // per-request bound, and the knob. Dropping any one of them turns an opt-in feature into a
    // default-on one, or lets a short Retry-After spin.
    expect(body).toContain("!genericFailoverAccountId");
    expect(body).toContain("genericFailovers >= GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST");
    expect(body).toContain("!isGenericOAuthFailoverEnabled(config, route.providerName)");

    // The FULL snapshot, not a bare bearer: Kiro carries routing metadata and Antigravity pairs
    // an account-matched projectId with its token, so a token-only swap mixes two accounts.
    expect(body).toContain("failoverAccountSnapshot(");
    expect(body).toContain("_kiroAuthContext");
    expect(body).toContain("snapshot.projectId");
  });
});
