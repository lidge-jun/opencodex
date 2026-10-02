/**
 * A pooled Anthropic provider must survive one spent account.
 *
 * 2026-09-28, 01:17-05:18 WITA: one account answered `Retry-After: 318747` (88.5 hours, its
 * weekly window gone). The combo layer cooled `anthropic/<model>` itself, so the gateway
 * answered 503 with ZERO upstream sends for four hours while a direct probe showed four of five
 * accounts returning 200. The pool had already cooled the one spent account and would have
 * routed past it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState } from "../../../src/combos/resolve";
import { clearComboTargetCooldowns, isComboTargetInCooldown } from "../../../src/combos/failover";
import {
  clearAnthropicAccountPoolState,
  forgetAnthropicFailoverQuorum,
  getAnthropicAccountHealthSnapshot,
} from "../../../src/oauth/anthropic-routing";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { clearAccountQuotaCache, resetProviderQuotaReconcileStateForTests } from "../../../src/providers/quota";
import { clearResponseStateForTests, flushResponseState } from "../../../src/responses/state";
import { handleResponses } from "../../../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const MODEL = "claude-sonnet-4-5";
const TARGET = { provider: "anthropic", model: MODEL };
/** The outage's own header: 88.5 hours, far past every local cooldown ceiling. */
const SPENT_WEEK_RETRY_AFTER = "318747";

const originalHome = process.env.OPENCODEX_HOME;
let home = "";
let releaseSpendHome: (() => void) | undefined;
let sentTokens: string[] = [];

function credential(index: number) {
  return {
    access: `synthetic-anthropic-access-${index}`,
    refresh: `synthetic-anthropic-refresh-${index}`,
    expires: Date.now() + 3_600_000,
    accountId: `synthetic-account-${index}`,
  };
}

async function seed(count: number): Promise<string[]> {
  for (let index = 0; index < count; index++) await saveCredential("anthropic", credential(index));
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  return ids;
}

function spent(): Response {
  return Response.json(
    { type: "error", error: { type: "rate_limit_error", message: "synthetic weekly quota exhausted" } },
    { status: 429, headers: { "anthropic-ratelimit-unified-5h-status": "rejected", "retry-after": SPENT_WEEK_RETRY_AFTER } },
  );
}

function answered(): Response {
  return Response.json({
    id: "msg_synthetic", type: "message", role: "assistant", model: MODEL,
    content: [{ type: "text", text: "The answer is complete." }],
    stop_reason: "end_turn", usage: { input_tokens: 8, output_tokens: 6 },
  });
}

function configFor(reply: () => Response, poolEnabled = true): OcxConfig {
  const transport = (async (_input, init) => {
    sentTokens.push(String(new Headers(init?.headers).get("authorization")));
    return reply();
  }) as typeof fetch;
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic", baseUrl: "https://anthropic-combo.test", authMode: "oauth",
    models: [MODEL], fetch: transport,
  };
  return {
    port: 0, defaultProvider: "anthropic",
    anthropicAccountPool: { enabled: poolEnabled, strategy: "round-robin" },
    providers: { anthropic: provider },
    combos: { pooled: { strategy: "failover", targets: [TARGET] } },
  };
}

async function post(config: OcxConfig): Promise<Response> {
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/pooled", input: "Answer briefly", stream: false }),
  }), config, { model: "", provider: "" });
  await response.text();
  return response;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-combo-cooldown-"));
  process.env.OPENCODEX_HOME = home;
  sentTokens = [];
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  clearResponseStateForTests();
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(async () => {
  await flushResponseState();
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearAccountQuotaCache();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  clearGenericFailoverHealth();
  resetProviderQuotaReconcileStateForTests();
  clearResponseStateForTests();
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  if (home) removeTreeWithRetry(home);
});

test("a spent pool account does not cool the combo target for the accounts that still answer", async () => {
  const ids = await seed(5);
  let refuse = true;
  const config = configFor(() => refuse ? spent() : answered());

  const refused = await post(config);
  expect(refused.status).toBe(429);
  // Only the accounts this request actually reached are cooled, and the pool -- not the combo
  // layer -- is what cooled them.
  const cooled = ids.filter(id => getAnthropicAccountHealthSnapshot(id) !== null);
  expect(cooled.length).toBeGreaterThan(0);
  expect(cooled.length).toBeLessThan(ids.length);
  // The last refused account must be recorded even though the request spent its retry budget.
  expect(cooled).toHaveLength(4);
  expect(isComboTargetInCooldown("pooled", TARGET)).toBe(false);

  refuse = false;
  sentTokens = [];
  const served = await post(config);
  expect(served.status).toBe(200);
  // The retry left through an account the first request had not spent.
  expect(sentTokens.length).toBeGreaterThan(0);
  // Map each COOLED id back to its own token. `cooled` is a filtered subset of `ids`, so its
  // positions are not account indexes: with accounts 0 and 2 cooled, indexing by position would
  // check tokens 0 and 1 and let a retry through cooled account 2 unnoticed.
  const cooledTokens = cooled.map(id => `Bearer ${credential(ids.indexOf(id)).access}`);
  expect(cooledTokens).not.toContain(sentTokens[0]!);
  // Stated the other way round, from the token actually sent: resolve it back to its account and
  // assert that account is one the first request never cooled.
  const servedIndex = ids.findIndex((_, index) => sentTokens[0] === `Bearer ${credential(index).access}`);
  expect(servedIndex).toBeGreaterThanOrEqual(0);
  expect(cooled).not.toContain(ids[servedIndex]!);
}, 20_000);

test("every pool account spent still cools the combo target", async () => {
  await seed(2);
  const config = configFor(spent);
  // Drive requests until the pool itself refuses locally: with no account resolved the failure
  // names none, and an unidentified account must still cool the target rather than hammer.
  for (let attempt = 0; attempt < 4 && !isComboTargetInCooldown("pooled", TARGET); attempt++) {
    expect((await post(config)).status).toBe(429);
  }
  expect(isComboTargetInCooldown("pooled", TARGET)).toBe(true);
  const sendsBefore = sentTokens.length;
  // Cooled target, single-target combo: the next request is refused without an upstream send.
  expect((await post(config)).status).toBe(503);
  expect(sentTokens.length).toBe(sendsBefore);
}, 20_000);

test("a lone OAuth account without pool cooldown still cools the combo target", async () => {
  await seed(1);
  const config = configFor(spent, false);
  expect((await post(config)).status).toBe(429);
  expect(isComboTargetInCooldown("pooled", TARGET)).toBe(true);
  expect(sentTokens).toHaveLength(1);
});
