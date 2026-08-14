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
let requestHeaders: Headers;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  consumeBody = null;
  loadCalls = 0;
  requestBody = null;
  requestHeaders = new Headers();
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body));
      requestHeaders = new Headers(init?.headers);
      return Response.json(consumeBody ?? { code: "error" });
    },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

test("reset success refreshes account data and ignores an untrusted remaining field", async () => {
  consumeBody = { code: "reset", remaining: 1 };
  const operationId = crypto.randomUUID();
  const result = await redeemResetCredit("", "acct-1", operationId, t, async () => {
    loadCalls += 1;
    return true;
  }, "owner-proof");

  expect(loadCalls).toBe(1);
  expect(result.ok).toBe(true);
  expect(result.outcome).toBe("terminal");
  expect(result.toast).toBe("codexAuth.resetSuccessGeneric");
  expect(requestBody).toMatchObject({
    accountId: "acct-1",
    operationId,
  });
  expect(requestHeaders.get("x-opencodex-reset-credit-owner-token")).toBe("owner-proof");
});

test("already_redeemed reports an idempotent terminal outcome without inventing a count", async () => {
  consumeBody = { code: "already_redeemed", remaining: 3 };
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => {
    loadCalls += 1;
    return true;
  }, "owner-proof");

  expect(loadCalls).toBe(1);
  expect(result.ok).toBe(true);
  expect(result.outcome).toBe("terminal");
  expect(result.toast).toBe("codexAuth.resetAlreadyRedeemed");
});

test("missing refreshed count uses the generic success toast", async () => {
  consumeBody = { code: "reset" };
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => true, "owner-proof");

  expect(result.ok).toBe(true);
  expect(result.toast).toBe("codexAuth.resetSuccessGeneric");
});

test("already_redeemed without remaining still uses the idempotent terminal toast", async () => {
  consumeBody = { code: "already_redeemed" };
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => true, "owner-proof");

  expect(result.ok).toBe(true);
  expect(result.toast).toBe("codexAuth.resetAlreadyRedeemed");
});

test("an account identity conflict is terminal for the stale client id and requires a fresh intent", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => Response.json({
      error: "The Codex account identity changed. Confirm a new reset-credit request.",
      code: "reset_credit_operation_identity_changed",
    }, { status: 409 }),
  });
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => {
    loadCalls += 1;
    return true;
  }, "owner-proof");
  expect(result).toEqual({
    ok: false,
    outcome: "terminal",
    toast: "codexAuth.resetIdentityChanged",
  });
  expect(loadCalls).toBe(0);
});

test("history saturation is terminal for the rejected id and gives maintainer guidance", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => Response.json({
      error: "Reset-credit operation history is full.",
      code: "reset_credit_operation_history_full",
    }, { status: 507 }),
  });
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => {
    loadCalls += 1;
    return true;
  }, "owner-proof");
  expect(result).toEqual({
    ok: false,
    outcome: "terminal",
    toast: "codexAuth.resetHistoryFull",
  });
  expect(loadCalls).toBe(0);
});

test("failure paths return ok:false so callers can set toastError from result.ok", async () => {
  consumeBody = { code: "no_credit" };
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => true, "owner-proof");

  expect(result.ok).toBe(false);
  expect(result.outcome).toBe("terminal");
  expect(result.toast).toBe("codexAuth.resetNoCredit");
});

test("transport and malformed outcomes remain ambiguous for same-id retry", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => { throw new Error("response lost"); },
  });
  const result = await redeemResetCredit("", "acct-1", crypto.randomUUID(), t, async () => true, "owner-proof");
  expect(result).toEqual({
    ok: false,
    outcome: "ambiguous",
    toast: "codexAuth.resetError",
  });
});

test("a stalled reset request aborts to an ambiguous retry after the GUI budget", async () => {
  const timeoutDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "timeout");
  const anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, "any");
  const timeoutController = new AbortController();
  let timeoutMs = 0;
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: (ms: number) => {
      timeoutMs = ms;
      queueMicrotask(() => timeoutController.abort(new DOMException("timed out", "TimeoutError")));
      return timeoutController.signal;
    },
  });
  Object.defineProperty(AbortSignal, "any", {
    configurable: true,
    value: (signals: AbortSignal[]) => signals[1],
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);
      return await new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
        if (signal?.aborted) rejectAbort();
        else signal?.addEventListener("abort", rejectAbort, { once: true });
      });
    },
  });
  try {
    const result = await redeemResetCredit(
      "",
      "acct-1",
      crypto.randomUUID(),
      t,
      async () => true,
      "owner-proof",
    );
    expect(timeoutMs).toBe(15_000);
    expect(result).toEqual({
      ok: false,
      outcome: "ambiguous",
      toast: "codexAuth.resetError",
    });
  } finally {
    if (timeoutDescriptor) Object.defineProperty(AbortSignal, "timeout", timeoutDescriptor);
    if (anyDescriptor) Object.defineProperty(AbortSignal, "any", anyDescriptor);
  }
});
