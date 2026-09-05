import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearGenericFailoverHealth,
  eligibleFailoverAccounts,
  genericFailoverRetryAfterSeconds,
  hasFailoverAccountQuorum,
  isGenericFailoverProvider,
  isGenericOAuthFailoverEnabled,
  preferredInitialAccount,
  rotateGenericOAuthAccountOn429,
} from "../../src/oauth/generic-account-failover";
import { getAccountSet, markAccountNeedsReauth, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import { resolveCopilotApiBaseUrl } from "../../src/oauth/github-copilot";
import { resolveProviderTransport } from "../../src/providers/xai-transport";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const originalHome = process.env.OPENCODEX_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-generic-failover-"));
  process.env.OPENCODEX_HOME = home;
  clearGenericFailoverHealth();
});

afterEach(() => {
  clearGenericFailoverHealth();
  clearAccountQuotaCache("xai");
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

const OAUTH_PROVIDER = {
  adapter: "openai-chat",
  baseUrl: "https://api.x.ai/v1",
  authMode: "oauth",
} as unknown as OcxProviderConfig;

/**
 * `enabled: undefined` means the key is ABSENT, which after #2568d is the case that matters most:
 * it is what every install that never edited its config looks like.
 */
function config(enabled?: boolean, perProvider?: boolean): OcxConfig {
  return {
    providers: {
      xai: perProvider === undefined
        ? OAUTH_PROVIDER
        : { ...OAUTH_PROVIDER, oauthAccountFailover: { enabled: perProvider } },
    },
    ...(enabled === undefined ? {} : { oauthAccountFailover: { enabled } }),
  } as unknown as OcxConfig;
}

async function seed(count: number, offset = 0): Promise<string[]> {
  for (let i = offset; i < offset + count; i++) {
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
  test("two logged-in accounts rotate with NO configuration at all (#2568d)", async () => {
    // The reported workflow: three xAI accounts are logged in, the active one hits its limit, and
    // the operator never went looking for a toggle. Presence is the consent signal.
    const [first, second] = await seed(2);
    const next = rotateGenericOAuthAccountOn429(config(), "xai", first!, null);
    expect(next).toBe(second);
    // The failed account is cooled, so it is not offered again while the window holds.
    expect(eligibleFailoverAccounts("xai")).toEqual([second!]);
  });

  test("an explicit knob no longer disables REACTIVE rotation", async () => {
    // This assertion is deliberately the reverse of what it was under #2568d. The knob used to
    // suppress rotation entirely; it now governs only the proactive pre-dispatch preference.
    // The choice it offered here was between retrying on the second account the operator
    // deliberately logged in and returning a 429 while that account sat idle -- and the second
    // is a defect, not a preference. Refusing rotation is expressed by not storing a second
    // account, exactly as it is for an apiKeyPool.
    const ids = await seed(2);
    expect(rotateGenericOAuthAccountOn429(config(false), "xai", ids[0]!, null)).toBe(ids[1]);
    clearGenericFailoverHealth();
    expect(rotateGenericOAuthAccountOn429(config(true), "xai", ids[0]!, null)).toBe(ids[1]);
  });

  test("rotation continues AFTER the failed account, not from the top of the roster", async () => {
    // Quota ranking now orders the candidates, so this pins the property the ranking must
    // not disturb: with three accounts and no quota evidence anywhere, a 429 on the middle
    // account moves to the one after it. Ranking the store's own order would answer the
    // first account instead, silently changing every quota-less provider's traversal.
    const ids = await seed(3);
    expect(rotateGenericOAuthAccountOn429(config(), "xai", ids[1]!, null)).toBe(ids[2]);
  });

  test("the ring wraps when the failed account is last", async () => {
    const ids = await seed(3);
    expect(rotateGenericOAuthAccountOn429(config(), "xai", ids[2]!, null)).toBe(ids[0]);
  });

  test("an unknown failed account still yields a candidate", async () => {
    // The account may have been removed between dispatch and the 429 landing.
    const ids = await seed(2);
    expect(rotateGenericOAuthAccountOn429(config(), "xai", "not-a-real-account", null)).toBe(ids[0]);
  });

  test("neither switch can turn REACTIVE rotation off, in either direction", async () => {
    // Also reversed from #2568d. Reactive rotation is presence-only now, so a per-provider
    // false, a global false, and any combination of the two all still rotate. What the override
    // still buys is the PROACTIVE preference, covered by its own test below.
    const ids = await seed(2);
    expect(isGenericOAuthFailoverEnabled(config(true, false), "xai")).toBe(true);
    expect(isGenericOAuthFailoverEnabled(config(false, true), "xai")).toBe(true);
    expect(isGenericOAuthFailoverEnabled(config(false, false), "xai")).toBe(true);
    expect(rotateGenericOAuthAccountOn429(config(true, false), "xai", ids[0]!, null)).toBe(ids[1]);
  });

  test("the knob still refuses the PROACTIVE pre-dispatch preference", async () => {
    // The half of the old contract that survives: steering a request upstream has NOT refused
    // is a real behavioural choice, so an explicit false must still be able to decline it.
    // Without headroom evidence the preference is a no-op anyway, so this pins the refusal
    // rather than the ranking.
    const ids = await seed(2);
    setCachedProviderAccountQuotaForTests("xai", ids[0]!, { fiveHourPercent: 99 });
    setCachedProviderAccountQuotaForTests("xai", ids[1]!, { fiveHourPercent: 1 });
    expect(preferredInitialAccount(config(false), "xai")).toBeNull();
    expect(preferredInitialAccount(config(true, false), "xai")).toBeNull();
  });

  test("a provider-level true overrides a global proactive opt-out", async () => {
    // The documented precedence is narrow-over-broad in BOTH directions. A per-provider false
    // refuses the preference under a global true (pinned above); the mirror case is an operator
    // who declines steering globally and opts one provider back in. Honouring only `false`
    // silently drops that opt-in.
    const ids = await seed(2);
    await setActiveAccount("xai", ids[0]!);
    clearGenericFailoverHealth("xai");
    setCachedProviderAccountQuotaForTests("xai", ids[0]!, { fiveHourPercent: 99 });
    setCachedProviderAccountQuotaForTests("xai", ids[1]!, { fiveHourPercent: 1 });

    expect(preferredInitialAccount(config(false, true), "xai")).toBe(ids[1]);
  });

  test("a second account flagged for reauth is not a quorum", async () => {
    // A revoked account cannot serve the replay, so counting it would arm the failover machinery
    // for a user who still has exactly one usable credential.
    const ids = await seed(2);
    expect(hasFailoverAccountQuorum("xai")).toBe(true);
    await markAccountNeedsReauth("xai", ids[1]!, true);
    clearGenericFailoverHealth();
    expect(hasFailoverAccountQuorum("xai")).toBe(false);
    expect(isGenericOAuthFailoverEnabled(config(), "xai")).toBe(false);
  });

  test("the presence answer is cached, but a fresh login is visible within the TTL window", async () => {
    // The predicate now runs on requests that never see a 429, and loadAuthStore has no cache of
    // its own — it chmods and re-reads the whole store every call. A count is memoized; a
    // credential never is.
    const start = Date.now();
    await seed(1);
    expect(hasFailoverAccountQuorum("xai", start)).toBe(false);
    await seed(1, 1);
    // Same instant: still the memoized answer.
    expect(hasFailoverAccountQuorum("xai", start)).toBe(false);
    // Past the window: the new login is seen without any explicit invalidation call.
    expect(hasFailoverAccountQuorum("xai", start + 2_001)).toBe(true);
  });

  test("a single stored account is a strict no-op", async () => {
    // Rotating to itself would replay the same 429 against the same credential, and cooling
    // the only account would take the provider out of service for nothing.
    const [solo] = await seed(1);
    expect(rotateGenericOAuthAccountOn429(config(), "xai", solo!, null)).toBeNull();
    expect(isGenericOAuthFailoverEnabled(config(), "xai")).toBe(false);
    expect(eligibleFailoverAccounts("xai")).toEqual([solo!]);
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
    const cfg = config();
    expect(rotateGenericOAuthAccountOn429(cfg, "xai", ids[0]!, "120")).toBe(ids[1]);
    expect(rotateGenericOAuthAccountOn429(cfg, "xai", ids[1]!, "30")).toBeNull();
    const retryAfter = genericFailoverRetryAfterSeconds("xai");
    // The earliest window wins: a client must not be told to wait for the longest cooldown.
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter!).toBeLessThanOrEqual(30);
  });

  test("Retry-After drives the cooldown length", async () => {
    const ids = await seed(2);
    rotateGenericOAuthAccountOn429(config(), "xai", ids[0]!, "600");
    expect(genericFailoverRetryAfterSeconds("xai")).toBeGreaterThan(500);
  });

  test("an excluded provider is never enabled, however many accounts it has", async () => {
    await seed(2);
    // Codex and Anthropic own quota scopes, probe leases and affinity that this must not
    // reimplement, so presence does not speak for them.
    expect(isGenericOAuthFailoverEnabled(config(), "openai")).toBe(false);
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
    repoPath("src", "server", "responses", "core.ts"),
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
    // per-request bound, and the activation predicate. Dropping the bound lets a short
    // Retry-After spin; dropping the account binding lets a rotation cool an innocent account.
    // The gate is a POSITIVE else-if, not an early return: an early bare return here made the
    // Anthropic arm below unreachable, because Anthropic never has a genericFailoverAccountId.
    expect(body).toContain("genericFailoverAccountId");
    expect(body).toContain("genericFailovers < GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST");
    expect(body).toContain("isGenericOAuthFailoverEnabled(config, route.providerName)");

    // Anthropic's pool is excluded from generic failover, so it needs its own arm here or a 429
    // inside a web-search/image turn is terminal while the same 429 on the main path rotates.
    const anthropic = body.indexOf("rotateAnthropicAccountOn429(");
    expect(anthropic).toBeGreaterThan(oauth);

    // REACHABILITY, not mention. The first draft of this arm sat behind an unconditional early
    // return and was dead code that a grep for "anthropic" would have happily passed. Every gate
    // ahead of it must therefore be a positive `else if`; a plain `else` block would swallow the
    // request and never fall through, which is precisely how the dead version was shaped.
    // (A `return null` INSIDE an arm is fine — that is a rotation that genuinely found no
    // candidate. What must not exist is a gate that returns before the arm is considered.)
    const chainStart = body.indexOf("if (rotated) {");
    expect(chainStart).toBeGreaterThan(-1);
    expect(body.slice(chainStart, anthropic)).not.toContain("} else {");
    // ...and the chain still ends in a terminal else, so an unrotatable 429 is not swallowed.
    expect(body.slice(anthropic)).toContain("} else {");

    // The FULL snapshot, not a bare bearer, and applied through the shared helper rather than
    // inline. Inlining is what produced the original defect: three sites each swapped `apiKey`
    // and only two of them remembered the routing metadata paired with it.
    expect(body).toContain("failoverAccountSnapshot(");
    expect(body).toContain("applyFailoverSnapshot(snapshot)");
    expect(body).not.toContain("apiKey: snapshot.accessToken");
  });

  test("every rotation site applies the credential through the one shared helper", () => {
    // The pairing rules (Copilot's account-scoped origin, Antigravity's account-matched project,
    // Kiro's routing metadata) live in exactly one place. A fourth rotation site that swaps the
    // bearer by hand would reintroduce the mixed-identity bug this helper exists to prevent.
    const snapshotUses = coreSource.match(/failoverAccountSnapshot\(/g) ?? [];
    const helperUses = coreSource.match(/applyFailoverSnapshot\(snapshot(?:, nextParsed)?\)/g) ?? [];
    // Five includes native Responses passthrough, which returns before the Chat bridge loop.
    // The explicit count keeps a newly added rotation site from skipping identity pairing.
    expect(snapshotUses.length).toBe(5);
    expect(helperUses.length).toBe(snapshotUses.length);
    // The bearer is written in exactly one place — inside the helper. Any other occurrence is a
    // rotation site that skipped the pairing rules.
    const bearerWrites = coreSource.match(/apiKey: snapshot\.accessToken/g) ?? [];
    expect(bearerWrites.length).toBe(1);
    const helperStart = coreSource.indexOf("const applyFailoverSnapshot =");
    expect(coreSource.indexOf("apiKey: snapshot.accessToken")).toBeGreaterThan(helperStart);
  });

  test("every 429 recovery loop carries all three rotators (#3495 follow-up)", () => {
    // This unit found the same defect twice: the streaming loop grew generic OAuth rotation and
    // the continuation loop did not, and the sidecar hook grew generic rotation while Anthropic
    // stayed excluded. Both times a loop shipped with a SUBSET of the rotators, and both times
    // nothing failed -- the gap is invisible unless you diff the loops against each other.
    //
    // A rotator set is the contract: any site that recovers a 429 by swapping a credential must
    // be able to swap ALL of them, or some provider's rate limit is terminal there while the
    // identical limit recovers one loop over.
    const rotators = {
      key: /hasKeyPoolFailover\(/g,
      anthropic: /rotateAnthropicAccountOn429\(/g,
      generic: /rotateGenericOAuthAccountOn429\(/g,
    };
    const counts = Object.fromEntries(
      Object.entries(rotators).map(([name, re]) => [name, (coreSource.match(re) ?? []).length]),
    );

    // The counts differ by rotator because the recovery sites differ, and each number is a
    // statement about which providers can recover where:
    //
    //   generic  = 5: streaming loop, continuation loop, sidecar hook, runTurn preflight,
    //                native Responses passthrough. The new default only moves OAuth traffic;
    //                key-auth defaults and Anthropic's own wire/pool remain unchanged.
    //   anthropic = 3: the same, MINUS runTurn -- that path is Cursor-only (cursor.ts is the
    //                  sole adapter implementing runTurn), so Anthropic cannot reach it.
    //   key       = 3: hasKeyPoolFailover guards the two 429 response loops plus the
    //                  pre-stream 401 recovery site (a rejected key rotates instead of
    //                  failing the request); the sidecar reaches the key pool through
    //                  rotateProviderTransportOn429 instead.
    //
    // Adding a fifth recovery site means deciding, deliberately, which rotators it needs and
    // updating the matching number. That decision is the thing this test exists to force.
    expect(counts.generic).toBe(5);
    expect(counts.anthropic).toBe(3);
    expect(counts.key).toBe(3);
  });

  test("the helper fails closed rather than pairing a new bearer with an old identity", () => {
    const start = coreSource.indexOf("const applyFailoverSnapshot =");
    expect(start).toBeGreaterThan(-1);
    const body = coreSource.slice(start, coreSource.indexOf("\n  };", start));

    // Antigravity: a rotated account with no project must abort the rotation, NOT inherit the
    // failed account's project. Its refresh path tolerates discovery failure, so this is
    // reachable with ordinary stored credentials.
    expect(body).toContain("cloud-code-assist");
    expect(body).toContain("!snapshot.projectId");

    // Copilot: the bearer is pinned to an account-scoped regional origin, so transport is
    // re-resolved with the rotated account's own apiBaseUrl.
    expect(body).toContain("github-copilot");
    expect(body).toContain("snapshot.apiBaseUrl");
    // ...and RESOLVED before it is handed over, so a rotated account with no stored origin
    // cannot fall through to the previous account's inherited baseUrl. See the behavioral
    // test below for why asserting the bare expression was not enough.
    expect(body).toContain("resolveCopilotApiBaseUrl(snapshot.apiBaseUrl)");
    expect(body).toContain("resolveProviderTransport(");

    // Kiro routing metadata still travels with its own token.
    expect(body).toContain("_kiroAuthContext");
    // ...and reaches the object actually retried. The terminal-guard continuation dispatches a
    // shallow clone, so writing only the outer request pairs the rotated bearer with the failed
    // account's region/profile.
    expect(coreSource).toContain("applyFailoverSnapshot(snapshot, nextParsed)");
  });

  test("pre-dispatch selection replaces the CCA project instead of inheriting one", () => {
    // The same pairing rule as the rotation helper, at the OTHER site that can change which
    // account serves a request. The ordinary path is guarded by `!route.provider.project`,
    // so without an explicit branch a preferred account would install its own bearer next
    // to the configured account's project — #2841 in its original shape.
    const start = coreSource.indexOf("const preferredAccountId =");
    expect(start).toBeGreaterThan(-1);
    const region = coreSource.slice(start, start + 6000);
    expect(region).toContain("usedPreferredAccount && resolved.projectId");
    // A project-less preferred account falls BACK to the ordinary active-account resolution
    // rather than erroring: a preference must never turn a working request into a failure,
    // and Antigravity tolerates project discovery failing, so an account with no project is
    // an ordinary stored state.
    expect(region).toContain("usedPreferredAccount = false");
    expect(region).not.toContain("has no Cloud Code Assist project");
    // Both fallbacks — a project-less account and an unresolvable one — must reach the SAME
    // active-account resolution, so neither can dispatch on a half-applied identity.
    const fallbacks = region.match(/usedPreferredAccount = false;/g) ?? [];
    expect(fallbacks.length).toBe(2);
    expect(region).toContain("forgetGenericFailoverRoster(route.providerName)");
  });
});

/**
 * The rotation pairing bug that source-text guards could not see.
 *
 * `applyFailoverSnapshot` clones the FAILED account's provider (`{ ...route.provider }`) and then
 * re-resolves Copilot transport with the rotated account's `snapshot.apiBaseUrl`. When the
 * rotated account has no stored origin — a malformed or manually seeded state, because login and
 * refresh always persist a resolved origin — the resolver's own fallback chain is
 *
 *     validateCopilotApiBaseUrl(apiBaseUrl)          // undefined for account B
 *  ?? validateCopilotApiBaseUrl(provider.baseUrl)    // still account A's regional origin
 *  ?? GITHUB_COPILOT_DEFAULT_API_BASE
 *
 * so B's bearer is sent to A's accepted origin. The defense-in-depth defect is in the PAIRING,
 * and only a test that supplies one account WITH an origin and one WITHOUT can observe it.
 */
describe("#2807 a 429 rotation pairs the bearer with its OWN origin", () => {
  const REGIONAL = "https://proxy.githubcopilot.com";
  const CANONICAL = "https://api.githubcopilot.com";

  /** The failed account's provider as `applyFailoverSnapshot` receives it: already resolved. */
  function providerAfterAccountA(): OcxProviderConfig {
    return {
      adapter: "openai-chat",
      authMode: "oauth",
      baseUrl: REGIONAL,
      apiKey: "bearer-account-a",
    } as unknown as OcxProviderConfig;
  }

  test("an account with its own regional origin keeps it", () => {
    const rotated = resolveProviderTransport(
      "github-copilot",
      { ...providerAfterAccountA(), apiKey: "bearer-account-b" },
      undefined,
      resolveCopilotApiBaseUrl("https://other.githubcopilot.com"),
    ) as OcxProviderConfig;
    expect(rotated.baseUrl).toBe("https://other.githubcopilot.com");
    expect(rotated.apiKey).toBe("bearer-account-b");
  });

  test("an account with NO stored origin falls back to canonical, never to the failed account's", () => {
    // This is the regression. Before the fix, `undefined` reached the transport resolver and its
    // second fallback returned the cloned REGIONAL origin — account A's — paired with B's bearer.
    const rotated = resolveProviderTransport(
      "github-copilot",
      { ...providerAfterAccountA(), apiKey: "bearer-account-b" },
      undefined,
      resolveCopilotApiBaseUrl(undefined),
    ) as OcxProviderConfig;
    expect(rotated.baseUrl).toBe(CANONICAL);
    expect(rotated.baseUrl).not.toBe(REGIONAL);
    expect(rotated.apiKey).toBe("bearer-account-b");
  });

  test("the unresolved form is what made the pairing possible", () => {
    // Proves the assertion above is not vacuous: hand the resolver the raw snapshot value the
    // way the code used to, and account A's origin comes back with account B's bearer.
    const leaked = resolveProviderTransport(
      "github-copilot",
      { ...providerAfterAccountA(), apiKey: "bearer-account-b" },
      undefined,
      undefined,
    ) as OcxProviderConfig;
    expect(leaked.baseUrl).toBe(REGIONAL);
    expect(leaked.apiKey).toBe("bearer-account-b");
  });

  test("a crafted non-Copilot origin on the rotated account is refused, not forwarded", () => {
    const rotated = resolveProviderTransport(
      "github-copilot",
      { ...providerAfterAccountA(), apiKey: "bearer-account-b" },
      undefined,
      resolveCopilotApiBaseUrl("https://attacker.example.com"),
    ) as OcxProviderConfig;
    expect(rotated.baseUrl).toBe(CANONICAL);
  });
});
