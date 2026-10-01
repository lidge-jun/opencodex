import { readResponsesCoreSource } from "../helpers/responses-core-source";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearGenericFailoverHealth,
  eligibleFailoverAccounts,
  genericFailoverRetryAfterSeconds,
  hasEligibleGenericOAuthFailoverTarget,
  hasFailoverAccountQuorum,
  isGenericFailoverProvider,
  isGenericOAuthFailoverEnabled,
  noteGenericPoolSelection,
  preferredInitialAccount,
  rotateGenericOAuthAccountOn429,
  rotateAntigravityAccountOnAuthRefusal,
} from "../../src/oauth/generic-account-failover";
import { getValidAccessSnapshotForAccount, OAuthAccountPausedError } from "../../src/oauth";
import { credentialGeneration, getAccountSet, markAccountNeedsReauth, replaceProviderAccountSet, saveCredential, setAccountPaused, setActiveAccount } from "../../src/oauth/store";

import { clearAccountQuotaCache, setCachedProviderAccountQuotaForTests } from "../../src/providers/quota";
import { subscribeAccountSelections } from "../../src/lib/account-selection-events";
import { resolveCopilotApiBaseUrl } from "../../src/oauth/github-copilot";
import { resolveProviderTransport } from "../../src/providers/xai-transport";
import { bindRouteReasoningReplayScope } from "../../src/server/responses/core-replay";
import {
  clearReasoningReplayCacheForTests,
  commitReasoningReplayServingIdentity,
} from "../../src/responses/reasoning-replay-cache";
import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
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
  clearAccountQuotaCache("google-antigravity");
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

async function seedProvider(provider: string, count: number, offset = 0): Promise<string[]> {
  for (let i = offset; i < offset + count; i++) {
    await saveCredential(provider, {
      access: `access-${i}`,
      refresh: `refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `uuid-${i}`,
    } as never, { addAccount: true });
  }
  return getAccountSet(provider)?.accounts.map(a => a.id) ?? [];
}

async function seed(count: number, offset = 0): Promise<string[]> {
  return seedProvider("xai", count, offset);
}

describe("#2568 generic OAuth account failover", () => {
  for (const provider of ["xai", "cursor", "kimi", "github-copilot", "google-antigravity", "nous", "kiro", "meta-muse"]) {
    test(`manual selection owns healthy dispatch for ${provider}, with pool off or on`, async () => {
      for (const accountId of ["selected", "spare"]) {
        await saveCredential(provider, {
          access: `synthetic-${accountId}`, refresh: `refresh-${accountId}`,
          expires: Date.now() + 3_600_000, accountId,
        });
      }
      const ids = getAccountSet(provider)!.accounts.map(a => a.id);
      await setActiveAccount(provider, ids[0]!);
      setCachedProviderAccountQuotaForTests(provider, ids[0]!, { weeklyPercent: 30, updatedAt: Date.now() });
      setCachedProviderAccountQuotaForTests(provider, ids[1]!, { weeklyPercent: 11, updatedAt: Date.now() });
      for (const enabled of [undefined, false, true]) {
        const cfg = { providers: { [provider]: { ...OAUTH_PROVIDER,
          ...(enabled === undefined ? {} : { oauthAccountFailover: { enabled } }),
        } } } as OcxConfig;
        expect(preferredInitialAccount(cfg, provider)).toBeNull();
      }
      clearAccountQuotaCache(provider);
    });
  }

  test("proactive exhaustion avoidance requires explicit pool enablement", async () => {
    const [selected, spare] = await seed(2);
    await setActiveAccount("xai", selected!);
    setCachedProviderAccountQuotaForTests("xai", selected!, { weeklyPercent: 100, updatedAt: Date.now() });
    setCachedProviderAccountQuotaForTests("xai", spare!, { weeklyPercent: 11, updatedAt: Date.now() });
    expect(preferredInitialAccount(config(), "xai")).toBeNull();
    expect(preferredInitialAccount(config(false), "xai")).toBeNull();
    expect(preferredInitialAccount(config(true), "xai")).toBe(spare);
  });

  test("unknown selected quota is not permission to replace the account", async () => {
    const [selected, spare] = await seed(2);
    await setActiveAccount("xai", selected!);
    setCachedProviderAccountQuotaForTests("xai", spare!, { weeklyPercent: 11, updatedAt: Date.now() });
    expect(preferredInitialAccount(config(true), "xai")).toBeNull();
  });

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
    setCachedProviderAccountQuotaForTests("xai", ids[0]!, { fiveHourPercent: 100 });
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

  test("pausing an account invalidates the cached failover quorum immediately", async () => {
    const ids = await seed(2);
    expect(hasFailoverAccountQuorum("xai")).toBe(true);

    await setAccountPaused("xai", ids[1]!, true);

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
    // The durable roster quorum remains active, but the only alternate is cooled. A denied
    // request budget must not describe this state as an otherwise available rotation.
    expect(isGenericOAuthFailoverEnabled(cfg, "xai")).toBe(true);
    expect(hasEligibleGenericOAuthFailoverTarget("xai", ids[1]!)).toBe(false);
    expect(rotateGenericOAuthAccountOn429(cfg, "xai", ids[1]!, "30")).toBeNull();
    const retryAfter = genericFailoverRetryAfterSeconds("xai");
    // The earliest window wins: a client must not be told to wait for the longest cooldown.
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter!).toBeLessThanOrEqual(30);
  });

  test("an uncooled alternate reports an eligible target", async () => {
    const ids = await seed(2);
    // The negative case above proves cooled accounts are excluded; without this positive
    // side an always-false implementation would also pass, silently deleting the
    // rotation-send-budget attribution for the normal case it exists to describe.
    expect(hasEligibleGenericOAuthFailoverTarget("xai", ids[0]!)).toBe(true);
    expect(hasEligibleGenericOAuthFailoverTarget("xai", ids[1]!)).toBe(true);
  });

  test("a one-account roster reports no eligible target even for a stale failed id", async () => {
    const [solo] = await seed(1);
    // The failed account can be removed after the request was sent, leaving one stored account
    // whose id differs from the failed one. Rotation refuses a roster under two accounts, so the
    // probe must not describe that state as a rotation the send budget withheld.
    expect(hasEligibleGenericOAuthFailoverTarget("xai", "removed-account")).toBe(false);
    expect(hasEligibleGenericOAuthFailoverTarget("xai", solo!)).toBe(false);
    expect(rotateGenericOAuthAccountOn429(config(true), "xai", "removed-account", null)).toBeNull();
  });

  test("Retry-After drives the cooldown length", async () => {
    const ids = await seed(2);
    rotateGenericOAuthAccountOn429(config(), "xai", ids[0]!, "600");
    expect(genericFailoverRetryAfterSeconds("xai")).toBeGreaterThan(500);
  });

  test("a stated Retry-After past the local cap is honoured, not truncated", async () => {
    const ids = await seed(2);
    const now = Date.now();
    // One hour. Retrying before it elapses buys a second 429 on an account upstream already
    // told us to leave alone — the exact wasted send this pool exists to avoid.
    expect(rotateGenericOAuthAccountOn429(config(), "xai", ids[0]!, "3600", now)).toBe(ids[1]);
    expect(genericFailoverRetryAfterSeconds("xai", now)).toBe(3600);
    // Still cooled long after any local truncation would have released it.
    expect(eligibleFailoverAccounts("xai", now + 20 * 60_000)).toEqual([ids[1]!]);
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
  const coreSource = readResponsesCoreSource();

  test("budget-withheld attribution proves a cooldown-eligible generic OAuth target", () => {
    // Kiro and non-Kiro continuation, native passthrough and run-turn have budget-denial branches.
    // A durable two-account quorum is insufficient because it intentionally ignores cooldowns.
    expect(coreSource.match(/hasEligibleGenericOAuthFailoverTarget\(/g)).toHaveLength(4);
    // The check must GATE the log, not merely run beside it: every call site wraps
    // noteAttemptRecoveryWithheld in the eligibility condition.
    expect(coreSource.match(/hasEligibleGenericOAuthFailoverTarget\([\s\S]*?\)\s*\)\s*noteAttemptRecoveryWithheld/g)).toHaveLength(4);
  });

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
    expect(body).toContain("genericFailovers < transportState.genericFailoverLimit");
    expect(body).toContain("isGenericOAuthFailoverEnabled(config, route.providerName)");

    // Anthropic's pool is excluded from generic failover, so it needs its own arm here or a 429
    // inside a web-search/image turn is terminal while the same 429 on the main path rotates.
    const anthropic = body.indexOf("rotateAnthropicAccountOnResponse(");
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
    // The helper must also receive the iteration-local request the loop retries with — a bare
    // `snapshot` call rebinds only the outer parsed, and the rotated Kiro context dies there.
    expect(body).toContain("applyFailoverSnapshot(snapshot, retryParsed)");
    expect(body).not.toContain("apiKey: snapshot.accessToken");
  });

  test("the shared hook rebinds the exact sidecar retry request", () => {
    const start = coreSource.indexOf("const rotateSidecarProviderOn429 =");
    expect(start).toBeGreaterThan(-1);
    const body = coreSource.slice(start, coreSource.indexOf("\n  };", start));

    // Both loops send the retry from an iteration-local shallow copy (iterParsed), so the hook
    // must receive and rebind THAT request: the Kiro auth context through the shared snapshot
    // helper, and the reasoning-replay/continuation scope through a second bind. Rebinding only
    // the outer parsed leaves the rotated bearer paired with the failed account's metadata.
    expect(body).toContain("retryParsed?: OcxParsedRequest");
    expect(body).toContain("applyFailoverSnapshot(snapshot, retryParsed)");
    expect(body).toContain("parsed: retryParsed");
  });

  test("every rotation site applies the credential through the one shared helper", () => {
    // The pairing rules (Copilot's account-scoped origin, Antigravity's account-matched project,
    // Kiro's routing metadata) live in exactly one place. A fourth rotation site that swaps the
    // bearer by hand would reintroduce the mixed-identity bug this helper exists to prevent.
    const snapshotUses = coreSource.match(/failoverAccountSnapshot\(/g) ?? [];
    const helperUses = coreSource.match(/applyFailoverSnapshot\(snapshot(?:, (?:next|retry)Parsed)?\)/g) ?? [];
    // Eight includes Antigravity auth rotation, Kiro branches and native passthrough.
    // The explicit count keeps a newly added rotation site from skipping identity pairing.
    expect(snapshotUses.length).toBe(8);
    expect(helperUses.length).toBe(snapshotUses.length);
    // The bearer is written in exactly one place — inside the helper. Any other occurrence is a
    // rotation site that skipped the pairing rules.
    const bearerWrites = coreSource.match(/apiKey: snapshot\.accessToken/g) ?? [];
    expect(bearerWrites.length).toBe(1);
    const helperStart = coreSource.indexOf("const applyFailoverSnapshot =");
    expect(coreSource.indexOf("apiKey: snapshot.accessToken")).toBeGreaterThan(helperStart);
  });

  test("terminal continuation rotation rebinds both OAuth replay owners", () => {
    // The continuation loop's generic OAuth arm rotates the credential through
    // applyFailoverSnapshot, but until now it never rebound the reasoning replay scope. The
    // terminal-guard clone (nextParsed) and the outer request (parsed) kept the FAILED
    // account's replay identity, so the replayed turn could disclose or cache reasoning under
    // the previous account's scope. The key-pool arm right above rebinds both owners; this
    // arm must do the same.
    const armStart = coreSource.indexOf("// Generic OAuth rotation for the continuation loop.");
    expect(armStart).toBeGreaterThan(-1);
    const armEnd = coreSource.indexOf("if (shouldAttemptImageTierRetry", armStart);
    const arm = coreSource.slice(armStart, armEnd);

    expect(arm).toContain("applyFailoverSnapshot(snapshot, nextParsed)");
    expect(arm.match(/bindRouteReasoningReplayScope\(\{/g)).toHaveLength(4);
    expect(arm).toContain("parsed: nextParsed");
    expect(arm).toMatch(/bindRouteReasoningReplayScope\(\{\s*parsed,/);
    expect(arm.match(/oauthCredentialSnapshot: transportState\.replayOAuthCredentialSnapshot/g)).toHaveLength(4);
  });

  test("Kiro refusal rotation rebinds continuation ownership before replay", () => {
    const refusalStart = coreSource.indexOf("// Generic OAuth account failover (#2568)");
    const armStart = coreSource.indexOf('if (route.providerName === "kiro")', refusalStart);
    const armEnd = coreSource.indexOf("} else {", armStart);
    const arm = coreSource.slice(armStart, armEnd);
    const applied = arm.indexOf("applyFailoverSnapshot(snapshot)");
    const rebound = arm.indexOf("bindRouteReasoningReplayScope({", applied);
    const replayed = arm.indexOf('rebuildAndRefetch("oauth-account-429"', rebound);

    expect(applied).toBeGreaterThan(-1);
    expect(rebound).toBeGreaterThan(applied);
    expect(replayed).toBeGreaterThan(rebound);
    expect(arm.slice(rebound, replayed)).toContain(
      "oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot",
    );
  });

  test("generic OAuth 429 rotation rebinds continuation ownership before replay", () => {
    // The non-Kiro arm rotates through the same applyFailoverSnapshot; without a rebind the
    // replay would carry the 429'd account's continuation and encrypted reasoning.
    const refusalStart = coreSource.indexOf("// Generic OAuth account failover (#2568)");
    const kiroArm = coreSource.indexOf('if (route.providerName === "kiro")', refusalStart);
    const armStart = coreSource.indexOf("} else {", kiroArm);
    const armEnd = coreSource.indexOf('rebuildAndRefetch("oauth-account-429"', armStart);
    const arm = coreSource.slice(armStart, armEnd);
    const applied = arm.indexOf("applyFailoverSnapshot(snapshot)");
    const rebound = arm.indexOf("bindRouteReasoningReplayScope({", applied);

    expect(armStart).toBeGreaterThan(kiroArm);
    expect(armEnd).toBeGreaterThan(armStart);
    expect(applied).toBeGreaterThan(-1);
    expect(rebound).toBeGreaterThan(applied);
    expect(arm.slice(rebound)).toContain(
      "oauthCredentialSnapshot: transportState.replayOAuthCredentialSnapshot",
    );
  });

  test("a failover rebind discards the previous account's continuation scope", () => {
    // The source-order test above proves the arm binds before replay; this one proves the bind
    // itself retires the old account's replay state. The arm hands the NEW snapshot to
    // bindRouteReasoningReplayScope, so a continuation served under account-old and retried under
    // account-new must strip the old store's encrypted blobs and foreign reasoning item ids.
    clearReasoningReplayCacheForTests();
    const parsed = {
      modelId: "claude-sonnet-4.5",
      context: { messages: [] },
      stream: false,
      options: {},
      _reasoningReplayScope: { clientThreadId: "thread-failover-rebind" },
    } as unknown as OcxParsedRequest;
    const provider = {
      adapter: "kiro",
      baseUrl: "https://q.us-east-1.amazonaws.com",
      authMode: "oauth",
    } as unknown as OcxProviderConfig;
    const bind = (accountId: string) =>
      bindRouteReasoningReplayScope({
        parsed,
        providerName: "kiro",
        provider,
        adapterName: "kiro",
        oauthCredentialSnapshot: { accountId, generation: "1" },
      });

    bind("account-old");
    commitReasoningReplayServingIdentity(parsed._reasoningReplayScope);
    const servedIdentity = parsed._reasoningReplayScope?.current?.credentialIdentity;
    expect(servedIdentity).toBeTruthy();
    expect(parsed._stripReasoningEncryptedContent).toBeUndefined();

    bind("account-new");

    expect(parsed._reasoningReplayScope?.current?.credentialIdentity).not.toBe(servedIdentity);
    expect(parsed._stripReasoningEncryptedContent).toBe(true);
    expect(parsed._dropForeignReasoningItemIds).toBe(true);
    clearReasoningReplayCacheForTests();
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
      anthropic: /rotateAnthropicAccountOnResponse\(/g,
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
    const end = coreSource.indexOf("\n  route.provider = resolveProviderTransport(", start);
    expect(end).toBeGreaterThan(start);
    const region = coreSource.slice(start, end);
    expect(region).toContain("project: resolved.projectId");
    expect(region).not.toContain("!route.provider.project");
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

describe("#695 the generic pool consumes its persisted strategy behind pool.kernel", () => {
  /** Proactive preference on, plus whichever strategy this case is about. */
  function kernelConfig(strategy?: "quota" | "round-robin" | "fill-first", extra: Record<string, unknown> = {}): OcxConfig {
    return {
      pool: { kernel: true },
      providers: {
        xai: {
          ...OAUTH_PROVIDER,
          oauthAccountFailover: { enabled: true, ...(strategy ? { strategy } : {}), ...extra },
        },
      },
    } as unknown as OcxConfig;
  }

  test("round-robin rotates a provider with no quota data at all", async () => {
    const ids = await seed(3);
    await setActiveAccount("xai", ids[0]!);
    // Deliberately NO quota is cached. This is the case the evidence guard refuses outright,
    // and it is exactly where round-robin is the point: with nothing measured there is no
    // ranking to make, only a turn to take.
    const cfg = kernelConfig("round-robin");

    const served: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const preferred = preferredInitialAccount(cfg, "xai");
      const account = preferred ?? getAccountSet("xai")!.activeAccountId!;
      served.push(account);
      // Admission is what advances the ring; the proposal above only peeks.
      noteGenericPoolSelection(cfg, "xai", account);
    }
    expect(new Set(served).size).toBeGreaterThan(1);
  });

  test("paused generic OAuth accounts are excluded from failover and cannot resolve directly", async () => {
    const provider = "google-antigravity";
    const ids = await seedProvider(provider, 3);
    await setAccountPaused(provider, ids[1]!, true);

    expect(eligibleFailoverAccounts(provider)).toEqual([ids[0]!, ids[2]!]);
    await expect(getValidAccessSnapshotForAccount(provider, ids[1]!)).rejects.toBeInstanceOf(OAuthAccountPausedError);
  });

  test("quota-based proactive preference never selects a paused account", async () => {
    const provider = "google-antigravity";
    const model = "gemini-3.8-flash";
    const ids = await seedProvider(provider, 3);
    await setActiveAccount(provider, ids[0]!);
    await setAccountPaused(provider, ids[1]!, true);
    const cfg = {
      pool: { kernel: true },
      providers: {
        [provider]: {
          ...OAUTH_PROVIDER,
          oauthAccountFailover: { enabled: true },
        },
      },
    } as unknown as OcxConfig;
    const now = Date.now();
    setCachedProviderAccountQuotaForTests(provider, ids[0]!, {
      customWindows: [{ label: "Gem", percent: 100 }], updatedAt: now,
    });
    setCachedProviderAccountQuotaForTests(provider, ids[1]!, {
      customWindows: [{ label: "Gem", percent: 10 }], updatedAt: now,
    });
    setCachedProviderAccountQuotaForTests(provider, ids[2]!, {
      customWindows: [{ label: "Gem", percent: 20 }], updatedAt: now,
    });

    expect(preferredInitialAccount(cfg, provider, now, model)).toBe(ids[2]!);
  });

  test("an active paused OAuth account is replaced even when quota preference is disabled", async () => {
    const provider = "google-antigravity";
    const ids = await seedProvider(provider, 2);
    await setActiveAccount(provider, ids[0]!);
    await setAccountPaused(provider, ids[0]!, true);

    // Pausing the active credential atomically commits the next usable account.
    expect(getAccountSet(provider)?.activeAccountId).toBe(ids[1]!);
  });

  test("resuming an account restores it as active when the current account remains paused", async () => {
    const provider = "google-antigravity";
    const ids = await seedProvider(provider, 2);
    await setActiveAccount(provider, ids[0]!);
    await setAccountPaused(provider, ids[0]!, true);
    await setAccountPaused(provider, ids[1]!, true);

    await setAccountPaused(provider, ids[0]!, false);

    expect(getAccountSet(provider)?.activeAccountId).toBe(ids[0]!);
    expect(eligibleFailoverAccounts(provider)).toEqual([ids[0]!]);
  });

  test("provider account-set replacement preserves operator pause state", async () => {
    const provider = "google-antigravity";
    const ids = await seedProvider(provider, 2);
    await setAccountPaused(provider, ids[1]!, true);
    const accountSet = getAccountSet(provider)!;

    await replaceProviderAccountSet(provider, accountSet);

    expect(getAccountSet(provider)?.accounts.find(account => account.id === ids[1]!)?.paused).toBe(true);
    expect(eligibleFailoverAccounts(provider)).not.toContain(ids[1]!);
  });

  test("pausing a non-active OAuth account publishes a roster invalidation after persistence", async () => {
    const provider = "google-antigravity";
    const ids = await seedProvider(provider, 2);
    await setActiveAccount(provider, ids[0]!);
    const events: Array<{ provider: string; kind: string }> = [];
    const unsubscribe = subscribeAccountSelections(event => events.push(event));
    try {
      await setAccountPaused(provider, ids[1]!, true);
    } finally {
      unsubscribe();
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ provider, kind: "oauth" });
    expect(getAccountSet(provider)?.accounts.find(account => account.id === ids[1]!)?.paused).toBe(true);
  });

  test("round-robin is a no-op while pool.kernel is off", async () => {
    const ids = await seed(3);
    await setActiveAccount("xai", ids[0]!);
    const off = {
      providers: { xai: { ...OAUTH_PROVIDER, oauthAccountFailover: { enabled: true, strategy: "round-robin" } } },
    } as unknown as OcxConfig;

    for (let i = 0; i < 4; i += 1) {
      // Same roster, same strategy, flag off: the pre-kernel answer is null every time,
      // because no quota was ever measured. Reversibility is the whole point of the flag.
      expect(preferredInitialAccount(off, "xai")).toBeNull();
      noteGenericPoolSelection(off, "xai", ids[0]!);
    }
  });

  test("fill-first holds the active account under its threshold and advances over it", async () => {
    const ids = await seed(3);
    const sorted = [...ids].sort((left, right) => left.localeCompare(right));
    const active = sorted[0]!;
    await setActiveAccount("xai", active);
    const cfg = kernelConfig("fill-first", { autoSwitchThreshold: 80 });

    setCachedProviderAccountQuotaForTests("xai", active, { weeklyPercent: 40, updatedAt: Date.now() });
    // Under threshold: fill-first is supposed to keep filling this one.
    expect(preferredInitialAccount(cfg, "xai")).toBeNull();

    setCachedProviderAccountQuotaForTests("xai", active, { weeklyPercent: 90, updatedAt: Date.now() });
    // Over threshold: it advances, and to the NEXT account in the sorted roster rather than
    // to whichever id the login order happened to put first.
    expect(preferredInitialAccount(cfg, "xai")).toBe(sorted[1]!);
  });

  test("fill-first treats a zero threshold as disabling proactive switching", async () => {
    const ids = await seed(2);
    const active = [...ids].sort((left, right) => left.localeCompare(right))[0]!;
    await setActiveAccount("xai", active);
    const cfg = kernelConfig("fill-first", { autoSwitchThreshold: 0 });

    setCachedProviderAccountQuotaForTests("xai", active, { weeklyPercent: 100, updatedAt: Date.now() });
    expect(preferredInitialAccount(cfg, "xai")).toBeNull();
  });

  test("fill-first advances through the sorted roster, not the eligible subset", async () => {
    const ids = await seed(3);
    const sorted = [...ids].sort((left, right) => left.localeCompare(right));
    const active = sorted[0]!;
    await setActiveAccount("xai", active);
    const cfg = kernelConfig("fill-first", { autoSwitchThreshold: 80 });
    setCachedProviderAccountQuotaForTests("xai", active, { weeklyPercent: 95, updatedAt: Date.now() });

    // The successor is out of service, so the walk has to step OVER it and land on the third
    // account. Walking the eligible subset instead would wrap from a shorter list and pick a
    // different account -- the bug the shared kernel carries a stableAll argument to avoid.
    await markAccountNeedsReauth("xai", sorted[1]!, true);
    expect(preferredInitialAccount(cfg, "xai")).toBe(sorted[2]!);
  });

  test("quota keeps its pre-kernel answer with the flag on", async () => {
    const ids = await seed(2);
    await setActiveAccount("xai", ids[0]!);
    // 100, not 99: the quota path only leaves an active account once it is exhausted or
    // cooled. A merely busy account keeps serving, and that is the pre-kernel rule this case
    // is here to pin.
    setCachedProviderAccountQuotaForTests("xai", ids[0]!, { weeklyPercent: 100, updatedAt: Date.now() });
    setCachedProviderAccountQuotaForTests("xai", ids[1]!, { weeklyPercent: 10, updatedAt: Date.now() });

    // An explicit "quota" and no strategy at all must answer identically: quota IS the
    // pre-kernel path, so the flag must not change it.
    expect(preferredInitialAccount(kernelConfig("quota"), "xai")).toBe(ids[1]!);
    expect(preferredInitialAccount(kernelConfig(), "xai")).toBe(ids[1]!);
  });

  test("a 429 under round-robin rotates instead of ranking", async () => {
    const ids = await seed(3);
    await setActiveAccount("xai", ids[0]!);
    // Quota evidence pointing SOMEWHERE ELSE is what makes this case mean anything. With no
    // evidence the pre-kernel path hands the ring back untouched and lands on the same
    // account round-robin would, so the test would pass whether or not the branch exists.
    setCachedProviderAccountQuotaForTests("xai", ids[1]!, { weeklyPercent: 80, updatedAt: Date.now() });
    setCachedProviderAccountQuotaForTests("xai", ids[2]!, { weeklyPercent: 5, updatedAt: Date.now() });
    const next = rotateGenericOAuthAccountOn429(kernelConfig("round-robin"), "xai", ids[0]!, null);
    expect(next).not.toBeNull();
    expect(next).not.toBe(ids[0]!);
    // Round-robin takes its turn. Quota would have chased the roomier third account.
    expect(next).toBe(ids[1]!);
  });

  test("a 429 under fill-first leaves the cooled account rather than holding it", async () => {
    const ids = await seed(3);
    const sorted = [...ids].sort((left, right) => left.localeCompare(right));
    await setActiveAccount("xai", sorted[0]!);
    const cfg = kernelConfig("fill-first", { autoSwitchThreshold: 80 });
    // Well under threshold: the initial-preference rule would keep this account. The 429 path
    // must not, because the account it would hold is the one that just failed.
    setCachedProviderAccountQuotaForTests("xai", sorted[0]!, { weeklyPercent: 10, updatedAt: Date.now() });
    // The successor is the BUSIER of the two survivors, so quota ranking would skip past it.
    // Fill-first still takes it: filling one account before opening the next is the point.
    setCachedProviderAccountQuotaForTests("xai", sorted[1]!, { weeklyPercent: 70, updatedAt: Date.now() });
    setCachedProviderAccountQuotaForTests("xai", sorted[2]!, { weeklyPercent: 5, updatedAt: Date.now() });

    const next = rotateGenericOAuthAccountOn429(cfg, "xai", sorted[0]!, null);
    expect(next).toBe(sorted[1]!);
  });
});

describe("Antigravity authentication refusal selection", () => {
  test("captured activation survives a failed row becoming needsReauth", async () => {
    const [a, b] = await seedProvider("google-antigravity", 2);
    const generation = credentialGeneration(getAccountSet("google-antigravity")!.accounts[0]!.credential);
    await markAccountNeedsReauth("google-antigravity", a!, true);
    expect(rotateAntigravityAccountOnAuthRefusal(true, a!, generation, "gemini-3.8-flash")).toBe(b);
    expect(eligibleFailoverAccounts("google-antigravity")).toEqual([b!]);
  });

  test("one account and uncaptured activation cannot rotate", async () => {
    const [a] = await seedProvider("google-antigravity", 1);
    const generation = credentialGeneration(getAccountSet("google-antigravity")!.accounts[0]!.credential);
    expect(rotateAntigravityAccountOnAuthRefusal(true, a!, generation, null)).toBeNull();
    await seedProvider("google-antigravity", 1, 1);
    expect(rotateAntigravityAccountOnAuthRefusal(false, a!, generation, null)).toBeNull();
  });

  test("another OAuth provider's roster cannot activate Antigravity auth rotation", async () => {
    const [a] = await seedProvider("xai", 2);
    expect(rotateAntigravityAccountOnAuthRefusal(true, a!, "sent-generation", null)).toBeNull();
    expect(eligibleFailoverAccounts("xai")).toHaveLength(2);
  });

  test("paused and cooled siblings are skipped in stable roster order", async () => {
    const [a, b, c] = await seedProvider("google-antigravity", 3);
    const generation = credentialGeneration(getAccountSet("google-antigravity")!.accounts[0]!.credential);
    await setAccountPaused("google-antigravity", b!, true);
    expect(rotateAntigravityAccountOnAuthRefusal(true, a!, generation, null)).toBe(c);
    expect(rotateAntigravityAccountOnAuthRefusal(true, c!,
      credentialGeneration(getAccountSet("google-antigravity")!.accounts[2]!.credential), null)).toBeNull();
  });

  test("a replaced failed credential is not cooled by stale evidence", async () => {
    const [a, b] = await seedProvider("google-antigravity", 2);
    const old = credentialGeneration(getAccountSet("google-antigravity")!.accounts[0]!.credential);
    await saveCredential("google-antigravity", {
      access: "new-access", refresh: "new-refresh", expires: Date.now() + 3_600_000,
      accountId: "uuid-0",
    } as never);
    expect(rotateAntigravityAccountOnAuthRefusal(true, a!, old, null)).toBe(b);
    expect(eligibleFailoverAccounts("google-antigravity")).toContain(a!);
  });
});
