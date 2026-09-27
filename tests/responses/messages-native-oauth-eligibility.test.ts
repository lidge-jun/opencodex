/**
 * Which Anthropic OAuth routes take the managed native Messages lane (PF-10): the
 * `managedMessagesNativeOAuth` switch and its dependency on `managedMessagesNative`, the
 * `anthropic` provider on `api.anthropic.com` only, a pooled account set declining with
 * `oauth-account-pool`, and a planner that judges all of it from config without touching the
 * OAuth store or the network.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAuthStorePath } from "../../src/oauth/store";
import { buildProtocolPlanSnapshot } from "../../src/protocols/plan-snapshot";
import { resolveProtocolSettings } from "../../src/protocols/settings";
import type { RouteResult } from "../../src/router";
import { nativeMessagesDeclineReason } from "../../src/server/messages-native-eligibility";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let originalFetch: typeof globalThis.fetch;
let fetches = 0;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-messages-native-oauth-eligibility-"));
  process.env.OPENCODEX_HOME = testDir;
  originalFetch = globalThis.fetch;
  fetches = 0;
  // Planning must never refresh a token: any network call fails the case.
  globalThis.fetch = (async () => {
    fetches += 1;
    throw new Error("unexpected fetch while judging eligibility");
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  expect(fetches).toBe(0);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (testDir) removeTreeWithRetry(testDir);
});

const BOTH = { protocols: { rollout: { managedMessagesNative: true, managedMessagesNativeOAuth: true } } } as Partial<OcxConfig>;
const KEY_ONLY = { protocols: { rollout: { managedMessagesNative: true } } } as Partial<OcxConfig>;
const OAUTH_ONLY = { protocols: { rollout: { managedMessagesNativeOAuth: true } } } as Partial<OcxConfig>;

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "anthropic",
    providers: {
      anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth", models: ["claude-o"] },
    },
    ...overrides,
  } as OcxConfig;
}

function route(overrides: { providerName?: string; baseUrl?: string } = {}): RouteResult {
  return {
    providerName: overrides.providerName ?? "anthropic",
    modelId: "claude-o",
    routeKind: "direct",
    routeReason: "test",
    provider: { adapter: "anthropic", baseUrl: overrides.baseUrl ?? "https://api.anthropic.com", authMode: "oauth" },
  } as unknown as RouteResult;
}

const BODY = { messages: [{ role: "user", content: "fixture" }] };

describe("OAuth native Messages eligibility", () => {
  test("the OAuth switch means nothing without managedMessagesNative", () => {
    expect(resolveProtocolSettings(config(OAUTH_ONLY)).rollout.managedMessagesNativeOAuth).toBe(false);
    expect(nativeMessagesDeclineReason(route(), BODY, config(OAUTH_ONLY))).toBe("rollout-disabled");
  });

  test("with only the key switch, OAuth stays on the bridge", () => {
    expect(nativeMessagesDeclineReason(route(), BODY, config(KEY_ONLY))).toBe("auth-mode-not-native");
  });

  test("with both switches, the unpooled anthropic OAuth route is native", () => {
    expect(nativeMessagesDeclineReason(route(), BODY, config(BOTH))).toBeUndefined();
  });

  test("only the anthropic provider on api.anthropic.com qualifies", () => {
    expect(nativeMessagesDeclineReason(route({ providerName: "other-oauth" }), BODY, config(BOTH))).toBe("auth-mode-not-native");
    for (const baseUrl of ["https://compatible.example", "http://api.anthropic.com", "https://api.anthropic.com:8443"]) {
      expect(nativeMessagesDeclineReason(route({ baseUrl }), BODY, config(BOTH))).toBe("auth-mode-not-native");
    }
  });

  test("a pooled account set declines: the opt-in pool from config, the quorum from the sender", () => {
    const pooled = config({ ...BOTH, anthropicAccountPool: { enabled: true } } as Partial<OcxConfig>);
    expect(nativeMessagesDeclineReason(route(), BODY, pooled)).toBe("oauth-account-pool");
    expect(nativeMessagesDeclineReason(route(), BODY, config(BOTH), { oauthFailoverQuorum: true })).toBe("oauth-account-pool");
    expect(nativeMessagesDeclineReason(route(), BODY, config(BOTH), { oauthFailoverQuorum: false })).toBeUndefined();
  });
});

describe("the planner judges OAuth from config alone", () => {
  test("an OAuth route previews as native without reading or creating the OAuth store", () => {
    const plan = buildProtocolPlanSnapshot(config(BOTH), { model: "anthropic/claude-o", inbound: "messages", features: [] });
    expect(plan.candidates[0]).toMatchObject({ nativeEligible: true, declineReasons: [] });
    expect(existsSync(getAuthStorePath())).toBe(false);
  });

  test("a configured pool previews as oauth-account-pool", () => {
    const pooled = config({ ...BOTH, anthropicAccountPool: { enabled: true } } as Partial<OcxConfig>);
    const plan = buildProtocolPlanSnapshot(pooled, { model: "anthropic/claude-o", inbound: "messages", features: [] });
    expect(plan.candidates[0]).toMatchObject({ nativeEligible: false, declineReasons: ["oauth-account-pool"] });
  });
});
