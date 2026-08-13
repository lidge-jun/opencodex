import { afterEach, beforeEach, expect, test } from "bun:test";
import { redeemResetCredit } from "../src/components/codex-account-pool-handlers";
import type { TFn } from "../src/i18n";

const t: TFn = ((key: string, vars?: Record<string, string | number>) => {
  if (!vars) return key;
  return `${key}:${Object.entries(vars).map(([k, v]) => `${k}=${v}`).join(",")}`;
}) as TFn;

let originalFetch: typeof globalThis.fetch;
let consumeBody: { code: string; remaining?: number } | null = null;
let loadCalls = 0;
let requestBody: unknown;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  consumeBody = null;
  loadCalls = 0;
  requestBody = null;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      return Response.json(consumeBody ?? { code: "error" });
    },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

test("balance changed after modal opened: toast uses authoritative remaining, not a stale snapshot", async () => {
  // Modal opened when balance was 3; concurrent activity left 1 — server reports 1.
  consumeBody = { code: "reset", remaining: 1 };
  const operationId = crypto.randomUUID();
  const result = await redeemResetCredit("", "acct-1", operationId, t, async () => {
    loadCalls += 1;
    return true;
  });

  expect(loadCalls).toBe(1);
  expect(result.ok).toBe(true);
  expect(result.outcome).toBe("terminal");
  expect(result.toast).toBe("codexAuth.resetSuccess:remaining=1");
  expect(result.toast).not.toContain("remaining=2");
  expect(result.toast).not.toContain("remaining=3");
  expect(requestBody).toMatchObject({
    accountId: "acct-1",
    operationId,
  });
});

test("already_redeemed does not decrement and uses the returned remaining count", async () => {
  consumeBody = { code: "already_redeemed", remaining: 3 };
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => {
    loadCalls += 1;
    return true;
  });

  expect(loadCalls).toBe(1);
  expect(result.ok).toBe(true);
  expect(result.outcome).toBe("terminal");
  expect(result.toast).toBe("codexAuth.resetSuccess:remaining=3");
  expect(result.toast).not.toContain("remaining=2");
});

test("missing refreshed count uses the generic success toast", async () => {
  consumeBody = { code: "reset" };
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => true);

  expect(result.ok).toBe(true);
  expect(result.toast).toBe("codexAuth.resetSuccessGeneric");
});

test("already_redeemed without remaining also uses the generic success toast", async () => {
  consumeBody = { code: "already_redeemed" };
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => true);

  expect(result.ok).toBe(true);
  expect(result.toast).toBe("codexAuth.resetSuccessGeneric");
  expect(result.toast).not.toBe("codexAuth.resetAlreadyRedeemed");
});

test("failure paths return ok:false so callers can set toastError from result.ok", async () => {
  consumeBody = { code: "no_credit" };
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => true);

  expect(result.ok).toBe(false);
  expect(result.outcome).toBe("terminal");
  expect(result.toast).toBe("codexAuth.resetNoCredit");
});

test("transport and malformed outcomes remain ambiguous for same-id retry", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => { throw new Error("response lost"); },
  });
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => true);
  expect(result).toEqual({
    ok: false,
    outcome: "ambiguous",
    toast: "codexAuth.resetError",
  });
});
