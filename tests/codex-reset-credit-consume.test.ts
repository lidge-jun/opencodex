import { describe, expect, test } from "bun:test";
import {
  CodexResetCreditConsumeError,
  consumeCodexResetCredit,
} from "../src/codex/reset-credit-consume";

const OPERATION_ID = "00000000-0000-4000-8000-000000000657";

function input(signal = new AbortController().signal) {
  return {
    accessToken: "test-access-token",
    chatgptAccountId: "test-chatgpt-account",
    operationId: OPERATION_ID,
    signal,
  };
}

describe("Codex reset-credit consume transport", () => {
  for (const code of ["reset", "already_redeemed", "nothing_to_reset", "no_credit"] as const) {
    test(`sends and echoes one stable operation id for ${code}`, async () => {
      let seenUrl = "";
      let seenBody: unknown;
      const result = await consumeCodexResetCredit(input(), {
        fetchImpl: async (url, init) => {
          seenUrl = String(url);
          seenBody = JSON.parse(String(init?.body));
          const headers = new Headers(init?.headers);
          expect(headers.get("authorization")).toBe("Bearer test-access-token");
          expect(headers.get("chatgpt-account-id")).toBe("test-chatgpt-account");
          return Response.json({ code, operationId: "attacker-controlled" });
        },
      });
      expect(seenUrl).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
      expect(seenBody).toEqual({ redeem_request_id: OPERATION_ID });
      expect(result).toEqual({ code, operationId: OPERATION_ID });
      expect(Object.isFrozen(result)).toBe(true);
    });
  }

  test("rejects invalid operation ids before dispatch", async () => {
    let calls = 0;
    await expect(consumeCodexResetCredit({ ...input(), operationId: "not-a-uuid" }, {
      fetchImpl: async () => { calls += 1; return Response.json({ code: "reset" }); },
    })).rejects.toMatchObject({ name: "CodexResetCreditConsumeError", reason: "invalid-input" });
    expect(calls).toBe(0);
  });

  test.each([
    ["unknown code", { code: "unknown" }],
    ["inherited code", Object.create({ code: "reset" })],
    ["array", [{ code: "reset" }]],
    ["malformed JSON", "{"],
  ])("fails closed for %s", async (_label, body) => {
    await expect(consumeCodexResetCredit(input(), {
      fetchImpl: async () => typeof body === "string" ? new Response(body) : Response.json(body),
    })).rejects.toMatchObject({ name: "CodexResetCreditConsumeError", reason: "invalid-response" });
  });

  test("rejects a declared oversized body and cancels it", async () => {
    let cancelled = false;
    await expect(consumeCodexResetCredit(input(), {
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() { cancelled = true; },
      }), { headers: { "content-length": "65537" } }),
    })).rejects.toMatchObject({ reason: "invalid-response" });
    expect(cancelled).toBe(true);
  });

  test("propagates an already-aborted caller without dispatch", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));
    let calls = 0;
    await expect(consumeCodexResetCredit(input(controller.signal), {
      fetchImpl: async () => { calls += 1; return Response.json({ code: "reset" }); },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(0);
  });

  test("classifies a post-dispatch abort as an ambiguous transport failure", async () => {
    const controller = new AbortController();
    let started!: () => void;
    const dispatched = new Promise<void>(resolve => { started = resolve; });
    const pending = consumeCodexResetCredit(input(controller.signal), {
      fetchImpl: async (_url, init) => {
        started();
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      },
    });
    await dispatched;
    controller.abort(new DOMException("client disconnected", "AbortError"));
    await expect(pending).rejects.toMatchObject({
      name: "CodexResetCreditConsumeError",
      reason: "transport",
    });
  });

  test("preserves non-2xx status without reflecting the body", async () => {
    await expect(consumeCodexResetCredit(input(), {
      fetchImpl: async () => new Response("private upstream text", { status: 429 }),
    })).rejects.toEqual(expect.objectContaining({
      name: "CodexResetCreditConsumeError",
      reason: "upstream",
      upstreamStatus: 429,
    }));
  });
});
