/**
 * #6991: a pool whose every held account is out on spent quota answers a usage limit, which the
 * Codex client stops on and renders with its reset time. Codex retries `rate_limit_exceeded`
 * through its whole budget and ends on "exceeded retry limit, last status: 429", so that answer is
 * kept only where a retry can succeed: a transient throttle, an entitlement refusal, a family
 * revalidation in flight, or a combo child whose combo owns the next hop.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { acquireOwnedSpendHome } from "../../helpers/owned-spend-home";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnthropicAccountCooldownError, anthropicPoolCooldownError, clearAnthropicAccountPoolState, forgetAnthropicFailoverQuorum,
  getAnthropicAccountHealthSnapshot, recordAnthropicAccount429, recordAnthropicAccountRefusal,
} from "../../../src/oauth/anthropic-routing";
import { claimAnthropicFamilyRevalidation, clearAllAnthropicFamilyQuota, observeAnthropicFamilyQuota } from "../../../src/oauth/anthropic-model-quota";
import { clearGenericFailoverHealth } from "../../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../../src/oauth/store";
import { clearAccountQuotaCache, resetProviderQuotaReconcileStateForTests } from "../../../src/providers/quota";
import { clearResponseStateForTests } from "../../../src/responses/state";
import { handleResponses } from "../../../src/server/responses";
import { anthropicPoolCooldownResponse } from "../../../src/server/responses/core-errors";
import type { OcxConfig, OcxProviderConfig } from "../../../src/types";
import { removeTreeWithRetry } from "../../helpers/remove-tree";

const originalHome = process.env.OPENCODEX_HOME;
let originalFetch: typeof globalThis.fetch;
let home: string;
let releaseSpendHome: (() => void) | undefined;
let sent: string[];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { throw new Error("Unexpected global fetch in pool usage-limit test"); }) as typeof fetch;
  home = mkdtempSync(join(tmpdir(), "ocx-anthropic-pool-usage-limit-"));
  process.env.OPENCODEX_HOME = home;
  sent = [];
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  clearAllAnthropicFamilyQuota();
  clearGenericFailoverHealth();
  clearAccountQuotaCache();
  resetProviderQuotaReconcileStateForTests();
  clearResponseStateForTests();
  releaseSpendHome = acquireOwnedSpendHome();
});

afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearAccountQuotaCache();
  clearAnthropicAccountPoolState();
  forgetAnthropicFailoverQuorum();
  clearAllAnthropicFamilyQuota();
  clearGenericFailoverHealth();
  resetProviderQuotaReconcileStateForTests();
  clearResponseStateForTests();
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  removeTreeWithRetry(home);
});

const MINUTE = 60_000;

function credential(index: number) {
  return {
    access: `synthetic-anthropic-access-${index}`,
    refresh: `synthetic-anthropic-refresh-${index}`,
    expires: Date.now() + 3_600_000,
    accountId: `synthetic-account-${index}`,
  };
}

async function seed(count = 2): Promise<string[]> {
  for (let index = 0; index < count; index++) await saveCredential("anthropic", credential(index));
  const ids = getAccountSet("anthropic")!.accounts.map(account => account.id);
  await setActiveAccount("anthropic", ids[0]!);
  return ids;
}

function spent(window: "5h" | "7d", retryAfterSeconds: number): Response {
  return Response.json({ type: "error", error: { type: "rate_limit_error", message: "synthetic window spent" } }, {
    status: 429,
    headers: {
      [`anthropic-ratelimit-unified-${window}-status`]: "rejected",
      [`anthropic-ratelimit-unified-${window}-reset`]: String(Math.floor(Date.now() / 1000) + retryAfterSeconds),
      "retry-after": String(retryAfterSeconds),
    },
  });
}

function configFor(poolEnabled: boolean, reply: () => Response = () => { throw new Error("no send expected"); }): OcxConfig {
  const transport = (async (_input, init) => {
    sent.push(new Headers(init?.headers).get("authorization") ?? "");
    return reply();
  }) as typeof fetch;
  const provider: OcxProviderConfig & { fetch: typeof fetch } = {
    adapter: "anthropic", baseUrl: "https://anthropic-usage-limit.test", authMode: "oauth",
    models: ["claude-sonnet-4-5", "claude-fable-5"], fetch: transport,
  };
  return { port: 0, defaultProvider: "anthropic", anthropicAccountPool: { enabled: poolEnabled }, providers: { anthropic: provider } };
}

function post(config: OcxConfig, body: Record<string, unknown> = {}) {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "anthropic/claude-sonnet-4-5", input: "Answer briefly", stream: false, ...body }),
  }), config, { model: "", provider: "" });
}

/**
 * Quota refusal recorded the way the dispatch path records it: a rejected window with its reset
 * and a Retry-After. Anthropic usually sets both to the same instant; `resetSeconds` lets a case
 * separate them or drop the reset header.
 */
function holdOnQuota(config: OcxConfig, id: string, retryAfterSeconds: number, now: number,
  resetSeconds: number | null = retryAfterSeconds): void {
  const headers = new Headers({ "anthropic-ratelimit-unified-7d-status": "rejected" });
  if (resetSeconds !== null) headers.set("anthropic-ratelimit-unified-7d-reset", String(Math.ceil(now / 1000) + resetSeconds));
  expect(recordAnthropicAccount429(config, id, String(retryAfterSeconds), now, headers)).toBe(true);
}

async function errorOf(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json()) as { error: Record<string, unknown> }).error;
}

function expectNoAccountMaterial(text: string, ids: readonly string[]): void {
  for (const id of ids) expect(text).not.toContain(id);
  for (const index of [0, 1]) {
    expect(text).not.toContain(credential(index).access);
    expect(text).not.toContain(credential(index).accountId);
  }
}

test.each([true, false])("every account held on quota answers usage_limit_reached with resets_at (pool enabled: %p)", async poolEnabled => {
  const ids = await seed(2);
  const config = configFor(poolEnabled);
  const now = Date.now();
  holdOnQuota(config, ids[0]!, 40 * 60, now);
  holdOnQuota(config, ids[1]!, 20 * 60, now);

  const response = await post(config);
  const text = await response.clone().text();
  const error = await errorOf(response);
  expect(response.status).toBe(429);
  expect(error).toMatchObject({ type: "usage_limit_reached", code: "usage_limit_reached" });
  // The earliest reopening: the account held for twenty minutes.
  expect(error.resets_at).toBe(Math.ceil(now / 1000) + 20 * 60);
  expect(Number.isInteger(error.resets_at)).toBe(true);
  expect(error).not.toHaveProperty("plan_type");
  expect(String(error.message)).toContain("usage limit");
  expect(Number(response.headers.get("retry-after"))).toBeGreaterThan(19 * 60);
  expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(20 * 60);
  expect(sent).toHaveLength(0);
  expectNoAccountMaterial(text, ids);
});

test("resets_at is the upstream window reset, and is omitted when any held account's reset is unknown", async () => {
  const ids = await seed(2);
  const config = configFor(true);
  const now = Date.now();
  // Retry-After (one minute) and the window reset (three hours) disagree: the reset is reported,
  // the admission deadline stays Retry-After.
  holdOnQuota(config, ids[0]!, 60, now, 3 * 3600);
  holdOnQuota(config, ids[1]!, 120, now, 5 * 3600);
  let response = await post(config);
  let error = await errorOf(response);
  expect(error).toMatchObject({ type: "usage_limit_reached", resets_at: Math.ceil(now / 1000) + 3 * 3600 });
  expect(Number(response.headers.get("retry-after"))).toBeLessThanOrEqual(60);

  // A refusal with no reset header could reopen at any time, so no reset is claimed for the pool.
  holdOnQuota(config, ids[1]!, 120, now, null);
  response = await post(config);
  error = await errorOf(response);
  expect(response.status).toBe(429);
  expect(error).toMatchObject({ type: "usage_limit_reached", code: "usage_limit_reached" });
  expect(error).not.toHaveProperty("resets_at");
  expect(String(error.message)).not.toContain("resets at");
  expect(response.headers.get("retry-after")).not.toBeNull();
});

test("a rejected window without its own reset leaves the pool reset unknown", async () => {
  const ids = await seed(2);
  const config = configFor(true);
  const now = Date.now();
  // Both windows rejected, only the five-hour one dated: the weekly window could hold far longer.
  for (const id of ids) {
    expect(recordAnthropicAccount429(config, id, "600", now, new Headers({
      "anthropic-ratelimit-unified-5h-status": "rejected",
      "anthropic-ratelimit-unified-5h-reset": String(Math.ceil(now / 1000) + 600),
      "anthropic-ratelimit-unified-7d-status": "rejected",
    }))).toBe(true);
  }
  const error = await errorOf(await post(config));
  expect(error).toMatchObject({ type: "usage_limit_reached" });
  expect(error).not.toHaveProperty("resets_at");
});

test("the reported reset is the last quota window to reopen, not the admission deadline that wins", async () => {
  const ids = await seed(2);
  const config = configFor(true);
  const now = Date.now();
  const second = Math.ceil(now / 1000) * 1000;
  // Shared quota: Retry-After ten minutes, window reset three hours. Family evidence expires for
  // admission in thirty minutes, its window resets in one hour. Admission waits on the family;
  // usage reopens only when the shared window does.
  holdOnQuota(config, ids[0]!, 600, now, 3 * 3600);
  observeAnthropicFamilyQuota(ids[0]!, [{ label: "Fable", scope: "model", percent: 100, rejected: true, resetAt: second + 60 * MINUTE }], now, true);
  holdOnQuota(config, ids[1]!, 600, now, 4 * 3600);
  const refusal = anthropicPoolCooldownError(now, null, "claude-fable-5");
  expect(refusal.usageLimit).toEqual({ resetsAt: second + 3 * 60 * MINUTE });
  expect(refusal.retryAfterSeconds).toBe(600);
});

test("a routed web-search turn whose last account refuses on spent quota answers the usage limit", async () => {
  const ids = await seed(2);
  const config = configFor(true, () => spent("5h", 1800));
  config.webSearchSidecar = { backend: "anthropic", enabled: true };
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const response = await post(config, { tools: [{ type: "web_search" }] });
    const text = await response.clone().text();
    const error = await errorOf(response);
    expect(sent).toHaveLength(2);
    expect(response.status).toBe(429);
    expect(error).toMatchObject({ type: "usage_limit_reached", code: "usage_limit_reached" });
    expect(Math.abs(Number(error.resets_at) - (Math.floor(Date.now() / 1000) + 1800))).toBeLessThanOrEqual(2);
    expectNoAccountMaterial(text, ids);
  } finally {
    warn.mockRestore();
  }
});

test.each(["transient throttle", "entitlement 403"] as const)("one %s among quota holds keeps the retryable rate limit", async kind => {
  const ids = await seed(2);
  const config = configFor(true);
  const now = Date.now();
  holdOnQuota(config, ids[0]!, 20 * 60, now);
  if (kind === "entitlement 403") {
    expect(recordAnthropicAccountRefusal(config, ids[1]!, 403, "600", now)).toBe(true);
  } else {
    // A Retry-After with no rejected window is an admission pause, not spent quota.
    expect(recordAnthropicAccount429(config, ids[1]!, "30", now, new Headers())).toBe(false);
    expect(getAnthropicAccountHealthSnapshot(ids[1]!)).toBeNull();
  }

  const response = await post(config);
  const error = await errorOf(response);
  expect(response.status).toBe(429);
  expect(error).toMatchObject({ type: "rate_limit_error", code: "rate_limit_exceeded" });
  expect(error).not.toHaveProperty("resets_at");
  expect(response.headers.get("retry-after")).not.toBeNull();
  expect(sent).toHaveLength(0);
});

test("the last account refusing on spent quota answers the usage limit at once", async () => {
  const ids = await seed(2);
  const config = configFor(true, () => spent("5h", 1800));
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const lines: string[] = [];
  warn.mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(" ")); });
  try {
    const response = await post(config);
    const text = await response.clone().text();
    const error = await errorOf(response);
    expect(sent).toEqual([`Bearer ${credential(0).access}`, `Bearer ${credential(1).access}`]);
    expect(response.status).toBe(429);
    expect(error).toMatchObject({ type: "usage_limit_reached", code: "usage_limit_reached" });
    expect(Math.abs(Number(error.resets_at) - (Math.floor(Date.now() / 1000) + 1800))).toBeLessThanOrEqual(2);
    expect(response.headers.get("retry-after")).not.toBeNull();
    expectNoAccountMaterial(text, ids);
    expect(lines.some(line => line.includes("no eligible replacement"))).toBe(true);
    expectNoAccountMaterial(lines.join("\n"), ids);
  } finally {
    warn.mockRestore();
  }
});

test("an upstream refusal while a sibling is only throttled keeps the provider's rate limit", async () => {
  const ids = await seed(2);
  const config = configFor(true, () => spent("5h", 1800));
  // The second account is held by a transient pause only, so the pool is not exhausted.
  expect(recordAnthropicAccount429(config, ids[1]!, "30", Date.now(), new Headers())).toBe(false);
  const response = await post(config);
  const error = await errorOf(response);
  expect(sent).toHaveLength(1);
  expect(response.status).toBe(429);
  expect(error.code).toBe("rate_limit_exceeded");
  expect(error).not.toHaveProperty("resets_at");
});

test("a spent model family is quota, but a family revalidation in flight is not", async () => {
  const ids = await seed(2);
  const config = configFor(true);
  const now = Date.now();
  holdOnQuota(config, ids[0]!, 20 * 60, now);
  const fable = [{ label: "Fable", scope: "model" as const, percent: 100, rejected: true, resetAt: now + 90 * MINUTE }];

  observeAnthropicFamilyQuota(ids[1]!, fable, now, true);
  const spentFamily = anthropicPoolCooldownError(now, null, "claude-fable-5");
  // Both resets are known (the shared window's header and the family window's), so the earlier one.
  expect(spentFamily.usageLimit).toEqual({ resetsAt: Math.ceil(now / 1000) * 1000 + 20 * MINUTE });
  // The family does not hold other models, so the pool is not exhausted for Sonnet at all.
  expect(anthropicPoolCooldownError(now, null, "claude-sonnet-4-5").usageLimit).toBeNull();

  // Passive evidence older than thirty minutes admits one revalidation send; while it is in
  // flight the family may reopen within the second, so a retry is the right answer.
  observeAnthropicFamilyQuota(ids[1]!, fable, now - 31 * MINUTE, true);
  expect(claimAnthropicFamilyRevalidation(ids[1]!, "claude-fable-5", now)).not.toBeNull();
  const revalidating = anthropicPoolCooldownError(now, null, "claude-fable-5");
  expect(revalidating.usageLimit).toBeNull();
  expect(revalidating.retryAfterSeconds).toBe(1);
});

test("a combo child keeps the retryable form and wording so its combo still owns the hop and target cooldown", async () => {
  const now = Date.now();
  const refusal = new AnthropicAccountCooldownError(60, undefined, { resetsAt: now + MINUTE });
  const logCtx: { errorCode?: string } = {};
  const combo = anthropicPoolCooldownResponse(refusal, { comboAttempt: true, logCtx });
  // Byte-for-byte what a combo child answered before: combo exhaustion also matches usage-limit prose.
  expect(await errorOf(combo)).toEqual({
    type: "rate_limit_error", code: "rate_limit_exceeded", message: "All Anthropic OAuth accounts are temporarily rate-limited",
  });
  expect(combo.headers.get("retry-after")).toBe("60");
  expect(logCtx.errorCode).toBeUndefined();

  const direct = anthropicPoolCooldownResponse(refusal, { logCtx });
  expect(await errorOf(direct)).toMatchObject({ type: "usage_limit_reached", resets_at: Math.ceil((now + MINUTE) / 1000) });
  expect(logCtx.errorCode).toBe("usage_limit_reached");
});
