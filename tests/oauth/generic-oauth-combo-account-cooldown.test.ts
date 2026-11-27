/**
 * A generic OAuth pool's spent account must not park the whole combo target.
 *
 * The per-request account budget stops the pool's own rotation before it reaches every stored
 * account, so a 429 can reach the combo layer while a sibling is still healthy. Cooling the target
 * for that account's `Retry-After` (up to the 24h server-delay ceiling) would answer zero-attempt
 * 503s, or pay for a fallback target, while the pool still has an account that answers.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState, clearComboTargetCooldowns, isComboTargetInCooldown } from "../../src/combos";
import { clearGenericFailoverHealth, eligibleFailoverAccounts, rotateGenericOAuthAccountOn429 } from "../../src/oauth/generic-account-failover";
import {
  clearGenericAccountQuotaVerdictsForTests, comboAccountExhaustionCanAdvance, recordGenericAccountRefusal,
} from "../../src/server/responses/core-combo-failure";
import { oauthAccountLogLabel } from "../../src/codex/account-label";
import { baseProviderLabel } from "../../src/providers/label";
import { routeConcreteModel } from "../../src/router";
import { clearAntigravityAccountRosters, recordAntigravityAccountRoster } from "../../src/providers/antigravity-account-roster";
import { genericPoolKey, peekRoundRobinAccount } from "../../src/oauth/pool-kernel";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { clearAccountQuotaCache } from "../../src/providers/quota";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { chatSuccess } from "../helpers/combo-failover-upstream";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const TARGET = { provider: "xai", model: "m1" };
const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let home = "";
let releaseSpendHome: (() => void) | undefined;
/** Account index per upstream send (`B` for the fallback target). */
let sends: string[] = [];

async function seed(count: number): Promise<void> {
  for (let index = 1; index <= count; index++) {
    await saveCredential("xai", {
      access: `synthetic-xai-access-${index}`, refresh: `synthetic-xai-refresh-${index}`,
      expires: Date.now() + 3_600_000, accountId: `synthetic-xai-${index}`,
    } as never, { addAccount: true });
  }
  await setActiveAccount("xai", getAccountSet("xai")!.accounts[0]!.id);
}

/** Accounts at or below `spentThrough` answer a one-hour 429; the rest answer 200. */
function upstream(
  spentThrough: number, error: Record<string, string> = { message: "synthetic rate limit" }, firstAccountError = error,
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://fallback.test/")) {
      sends.push("B");
      return chatSuccess("fallback answer", "m2");
    }
    const index = Number(new Headers(init?.headers).get("authorization")?.split("-").pop());
    sends.push(String(index));
    return index <= spentThrough
      ? Response.json({ error: index === 1 ? firstAccountError : error }, { status: 429, headers: { "retry-after": "3600" } })
      : chatSuccess("pool answer", "m1");
  }) as typeof fetch;
}

const config: OcxConfig = {
  port: 0, defaultProvider: "xai",
  providers: {
    xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1", authMode: "oauth", models: ["m1"] },
    fallback: { adapter: "openai-chat", baseUrl: "https://fallback.test/v1", authMode: "key", apiKey: "synthetic-fallback-key", models: ["m2"] },
  },
  combos: { pooled: { strategy: "failover", targets: [TARGET, { provider: "fallback", model: "m2" }] } },
};

async function post(): Promise<string> {
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/pooled", input: "Answer briefly", stream: false }),
  }), config, { model: "", provider: "" });
  expect(response.status).toBe(200);
  return response.text();
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-generic-combo-cooldown-"));
  process.env.OPENCODEX_HOME = home;
  sends = [];
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearGenericFailoverHealth();
  clearGenericAccountQuotaVerdictsForTests();
  clearAccountQuotaCache();
  clearResponseStateForTests();
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(async () => {
  await flushResponseState();
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  globalThis.fetch = originalFetch;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
  clearResponseStateForTests();
  clearAntigravityAccountRosters();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  if (home) removeTreeWithRetry(home);
});

test("a spent generic OAuth account cools the account, not the combo target", async () => {
  await seed(5);
  upstream(4);

  expect(await post()).toContain("fallback answer");
  // Precondition: the request budget ended the pool's rotation before the healthy fifth account.
  expect(sends).not.toContain("5");
  expect(sends.at(-1)).toBe("B");
  expect(isComboTargetInCooldown("pooled", TARGET)).toBe(false);
  // Every account this request reached is cooled by the pool, the last one included.
  expect(eligibleFailoverAccounts("xai")).toEqual([getAccountSet("xai")!.accounts[4]!.id]);

  // The pool, not the fallback target, serves the next request. Without proactive preference the
  // pool may still open on its cooled active account once before rotating; that is the pool's own
  // contract and stays bounded by its rotation.
  sends = [];
  expect(await post()).toContain("pool answer");
  expect(sends).not.toContain("B");
  expect(sends.at(-1)).toBe("5");
}, 20_000);

test("every generic OAuth account spent still cools the combo target", async () => {
  await seed(2);
  upstream(2);

  expect(await post()).toContain("fallback answer");
  expect(sends).toEqual(["1", "2", "B"]);
  expect(isComboTargetInCooldown("pooled", TARGET)).toBe(true);
}, 20_000);

for (const accounts of [5, 2]) {
  test(`quota-only failover leaves a generic OAuth pool only when no sibling remains (${accounts} accounts)`, async () => {
    await seed(accounts);
    upstream(4, { code: "insufficient_quota", message: "Account quota exhausted" });
    const quotaOnly: OcxConfig = { ...config, combos: { pooled: { strategy: "failover", quotaOnlyFallback: true,
      allowMeteredTargets: true, targets: [TARGET, { provider: "fallback", model: "m2" }] } } };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/pooled", input: "Answer briefly", stream: false }),
    }), quotaOnly, { model: "", provider: "" }, { admission: { kind: "loopback", source: "loopback" } });
    const text = await response.text();
    if (accounts === 5) {
      // The request budget ended rotation before the healthy fifth account, which still serves.
      expect(response.status).toBe(429);
      expect(sends).not.toContain("B");
    } else {
      expect(text).toContain("fallback answer");
      expect(sends).toEqual(["1", "2", "B"]);
    }
  }, 20_000);
}

test("quota-only failover stays on a generic OAuth pool while a sibling is only rate-limited", async () => {
  await seed(2);
  upstream(2, { code: "insufficient_quota", message: "Account quota exhausted" },
    { message: "Rate limit reached for requests per minute" });
  const quotaOnly: OcxConfig = { ...config, combos: { pooled: { strategy: "failover", quotaOnlyFallback: true,
    allowMeteredTargets: true, targets: [TARGET, { provider: "fallback", model: "m2" }] } } };
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/pooled", input: "Answer briefly", stream: false }),
  }), quotaOnly, { model: "", provider: "" }, { admission: { kind: "loopback", source: "loopback" } });
  await response.text();
  // The first account serves again once its rate-limit window passes, so the paid target waits.
  expect(response.status).toBe(429);
  expect(sends).toEqual(["1", "2"]);
}, 20_000);

/** Whether a quota-only Combo may leave `provider` after `refused` answered a confirmed exhaustion. */
function canAdvance(cfg: OcxConfig, provider: string, model: string, refused: string, at: number): boolean {
  return comboAccountExhaustionCanAdvance(cfg, routeConcreteModel(cfg, `${provider}/${model}`), new Response(null, { status: 429 }),
    oauthAccountLogLabel(refused, baseProviderLabel(provider)), at, undefined);
}

test("a later rate limit leaves a generic OAuth account's spent-quota verdict to its own deadline", async () => {
  await seed(2);
  const [spent, refused] = getAccountSet("xai")!.accounts.map(account => account.id);
  const now = Date.now();
  // A quota refusal dated one minute, then an ordinary rate limit that cools the account for an hour.
  recordGenericAccountRefusal("xai", spent!, "m1", "60", true, now);
  rotateGenericOAuthAccountOn429(config, "xai", spent!, "60", now, "m1", false);
  recordGenericAccountRefusal("xai", spent!, "m1", "3600", false, now + 1);
  rotateGenericOAuthAccountOn429(config, "xai", spent!, "3600", now + 1, "m1", false);
  expect(canAdvance(config, "xai", "m1", refused!, now + 2)).toBe(true);
  // The verdict ends with its own minute while the later rate limit still cools the account.
  expect(canAdvance(config, "xai", "m1", refused!, now + 61_000)).toBe(false);
});

test("an Antigravity sibling whose roster omits the model does not hold a quota-only Combo", async () => {
  const provider = "google-antigravity";
  const model = "gemini-3.8-flash";
  const cfg = { port: 0, defaultProvider: provider, providers: { [provider]: {
    adapter: "google", authMode: "oauth", baseUrl: "https://daily-cloudcode-pa.googleapis.com",
    googleMode: "cloud-code-assist", models: [model], oauthAccountFailover: { enabled: true },
  } } } as unknown as OcxConfig;
  for (const index of [1, 2]) {
    await saveCredential(provider, {
      access: `synthetic-antigravity-access-${index}`, refresh: `synthetic-antigravity-refresh-${index}`,
      expires: Date.now() + 3_600_000, accountId: `synthetic-antigravity-${index}`,
    } as never, { addAccount: true });
  }
  const [other, refused] = getAccountSet(provider)!.accounts.map(account => account.id);
  recordAntigravityAccountRoster(provider, other!, [{ id: "gemini-other", wireModelId: "gemini-other" } as never]);
  recordAntigravityAccountRoster(provider, refused!, [{ id: model, wireModelId: model } as never]);
  const now = Date.now();
  // The sibling is only rate-limited, but it cannot serve this model at all.
  rotateGenericOAuthAccountOn429(cfg, provider, other!, "3600", now, model, false);
  expect(canAdvance(cfg, provider, model, refused!, now + 1)).toBe(true);
});

test("a pinned quota-only continuation leaves the target usable while its pool still has an account", async () => {
  await seed(5);
  upstream(0);
  const quotaOnly: OcxConfig = { ...config, combos: { pooled: { strategy: "failover", quotaOnlyFallback: true,
    allowMeteredTargets: true, targets: [TARGET, { provider: "fallback", model: "m2" }] } } };
  const send = (input: unknown) => handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", "thread-id": "pinned-pool" },
    body: JSON.stringify({ model: "combo/pooled", input, stream: false }),
  }), quotaOnly, { model: "", provider: "" }, { admission: { kind: "loopback", source: "loopback" } });
  expect(await (await send("Answer briefly")).text()).toContain("pool answer");
  upstream(4, { code: "insufficient_quota", message: "Account quota exhausted" });
  sends = [];
  const continuation = await send([
    { type: "message", role: "user", content: [{ type: "input_text", text: "Answer briefly" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "done" },
  ]);
  await continuation.text();
  // The request budget ended rotation before the fifth account, which still serves new turns.
  expect(continuation.status).toBe(429);
  expect(sends).not.toContain("B");
  expect(isComboTargetInCooldown("pooled", TARGET)).toBe(false);
}, 20_000);

test("the combo's sibling check does not advance a round-robin pool onto an unsent account", async () => {
  await seed(5);
  upstream(4);
  const roundRobin: OcxConfig = { ...config, pool: { kernel: true }, providers: { ...config.providers,
    xai: { ...config.providers.xai!, oauthAccountFailover: { strategy: "round-robin", stickyLimit: 3 } } } };
  const ids = getAccountSet("xai")!.accounts.map(account => account.id);
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/pooled", input: "Answer briefly", stream: false }),
  }), roundRobin, { model: "", provider: "" });
  expect(await response.text()).toContain("fallback answer");
  expect(sends).not.toContain("5");
  expect(isComboTargetInCooldown("pooled", TARGET)).toBe(false);
  // Account 5 was only probed for eligibility, never sent; the ring must not stick to it.
  expect(peekRoundRobinAccount(genericPoolKey("xai"), ids, 3)).not.toBe(ids[4]);
}, 20_000);
