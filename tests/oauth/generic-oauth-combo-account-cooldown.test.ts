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
import { clearGenericFailoverHealth, eligibleFailoverAccounts } from "../../src/oauth/generic-account-failover";
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
function upstream(spentThrough: number): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://fallback.test/")) {
      sends.push("B");
      return chatSuccess("fallback answer", "m2");
    }
    const index = Number(new Headers(init?.headers).get("authorization")?.split("-").pop());
    sends.push(String(index));
    return index <= spentThrough
      ? Response.json({ error: { message: "synthetic rate limit" } }, { status: 429, headers: { "retry-after": "3600" } })
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
