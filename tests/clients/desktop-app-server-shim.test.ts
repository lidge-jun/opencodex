import { describe, expect, test } from "bun:test";
import { rewriteAppServerLine } from "../../src/chatgpt/app-server-shim/app-server-rewrite";
import { unlockRateLimitGate } from "../../src/chatgpt/app-server-shim/gate-rewrite";
import { createRpcLineFilter, runStdoutFilter, runChatgptAppServerFilter } from "../../src/chatgpt/app-server-shim/filter";

/**
 * The desktop app reads the composer's send gate from the bundled app-server over JSON-RPC, not
 * from Chromium (#6196). The shim sits on that one stdio pipe and opens the plain-quota gate.
 */

const rpcResult = (result: unknown) => JSON.stringify({ id: 2, result });

const EXHAUSTED_RATE_LIMITS = {
  ordinaryUsageAllowed: false,
  rateLimits: {
    limitId: "codex",
    primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1790000000 },
    planType: "pro",
    rateLimitReachedType: "rate_limit_reached",
  },
  rateLimitsByLimitId: { codex: { limitId: "codex", rateLimitReachedType: "rate_limit_reached" } },
};

describe("app-server line rewrite", () => {
  test("a plain-quota reached type is cleared and ordinary usage is allowed again", () => {
    const out = JSON.parse(rewriteAppServerLine(rpcResult(EXHAUSTED_RATE_LIMITS))!);
    expect(out.result.ordinaryUsageAllowed).toBe(true);
    expect(out.result.rateLimits.rateLimitReachedType).toBeNull();
    expect(out.result.rateLimitsByLimitId.codex.rateLimitReachedType).toBeNull();
    // Displayed usage is never changed.
    expect(out.result.rateLimits.primary).toEqual(EXHAUSTED_RATE_LIMITS.rateLimits.primary);
    expect(out.result.rateLimits.planType).toBe("pro");
  });

  test("a workspace or credit reached type is left as the server sent it", () => {
    for (const type of ["workspace_owner_usage_limit_reached", "workspace_member_credits_depleted"]) {
      const line = rpcResult({ ...EXHAUSTED_RATE_LIMITS, rateLimits: { ...EXHAUSTED_RATE_LIMITS.rateLimits, rateLimitReachedType: type }, rateLimitsByLimitId: {} });
      expect(rewriteAppServerLine(line)).toBeNull();
    }
  });

  test("a plain quota next to a workspace block keeps ordinary usage closed", () => {
    const line = rpcResult({
      ordinaryUsageAllowed: false,
      rateLimits: { rateLimitReachedType: "rate_limit_reached" },
      rateLimitsByLimitId: { other: { rateLimitReachedType: "workspace_owner_credits_depleted" } },
    });
    const out = JSON.parse(rewriteAppServerLine(line)!);
    expect(out.result.rateLimits.rateLimitReachedType).toBeNull();
    expect(out.result.rateLimitsByLimitId.other.rateLimitReachedType).toBe("workspace_owner_credits_depleted");
    expect(out.result.ordinaryUsageAllowed).toBe(false);
  });

  test("a Plus account with only the 5-hour window exhausted is opened and both windows are kept (#6196)", () => {
    // The reported state: 5-hour window at 100 %, weekly window at 32 %, Send disabled.
    const line = rpcResult({
      ordinaryUsageAllowed: false,
      rateLimits: {
        limitId: "codex",
        primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: 1790000000 },
        secondary: { usedPercent: 32, windowDurationMins: 10080, resetsAt: 1790500000 },
        planType: "plus",
        rateLimitReachedType: "rate_limit_reached",
      },
    });
    const out = JSON.parse(rewriteAppServerLine(line)!);
    expect(out.result.ordinaryUsageAllowed).toBe(true);
    expect(out.result.rateLimits.rateLimitReachedType).toBeNull();
    expect(out.result.rateLimits.primary).toEqual({ usedPercent: 100, windowDurationMins: 300, resetsAt: 1790000000 });
    expect(out.result.rateLimits.secondary).toEqual({ usedPercent: 32, windowDurationMins: 10080, resetsAt: 1790500000 });
  });

  test("a quota window at 100% opens ordinary usage even when no reached type is sent", () => {
    const line = rpcResult({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100, windowDurationMins: 10080 }, rateLimitReachedType: null } });
    const out = JSON.parse(rewriteAppServerLine(line)!);
    expect(out.result.ordinaryUsageAllowed).toBe(true);
    expect(out.result.rateLimits.primary.usedPercent).toBe(100);
  });

  test("ordinary usage stays closed without quota evidence, or when spend control also blocks", () => {
    // Closed for a reason the payload does not show: not ours to argue with.
    expect(rewriteAppServerLine(rpcResult({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 12 } } }))).toBeNull();
    // Quota is exhausted but a spend control also stands.
    expect(rewriteAppServerLine(rpcResult({ ordinaryUsageAllowed: false, rateLimits: { primary: { usedPercent: 100 }, spendControlReached: { used: 5, limit: 5 } } }))).toBeNull();
  });

  test("rate-limit flags closed without plain-quota evidence stay closed", () => {
    expect(rewriteAppServerLine(rpcResult({ rateLimits: { rateLimit: { allowed: false }, primary: { usedPercent: 12 } } }))).toBeNull();
    const notification = JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: { rateLimit: { allowed: false, limitReached: true } } } });
    expect(rewriteAppServerLine(notification)).toBeNull();
  });

  test("rate-limit flags open when the plain quota is the visible reason", () => {
    const out = JSON.parse(rewriteAppServerLine(rpcResult({ rateLimits: { rateLimit: { allowed: false, limitReached: true }, primary: { usedPercent: 100 } } }))!);
    expect(out.result.rateLimits.rateLimit).toEqual({ allowed: true, limitReached: false });
    expect(out.result.rateLimits.primary.usedPercent).toBe(100);
  });

  test("notifications carrying the same fields are rewritten too", () => {
    const line = JSON.stringify({ method: "account/rateLimits/updated", params: { rateLimits: { rateLimitReachedType: "rate_limit_reached" } } });
    expect(JSON.parse(rewriteAppServerLine(line)!).params.rateLimits.rateLimitReachedType).toBeNull();
  });

  test("only rate-limit messages are rewritten; tool results and other results that nest gate fields are left alone", () => {
    const toolResult = JSON.stringify({
      method: "item/completed",
      params: { item: { type: "commandExecution", output: { rate_limit: { allowed: false, limit_reached: true }, rateLimitReachedType: "rate_limit_reached" } } },
    });
    expect(rewriteAppServerLine(toolResult)).toBeNull();

    const otherResult = JSON.stringify({ id: 9, result: { data: { rate_limit: { allowed: false }, rateLimits: { rateLimitReachedType: "rate_limit_reached" } } } });
    expect(rewriteAppServerLine(otherResult)).toBeNull();

    const blocks = JSON.stringify({ id: 10, result: { blockedFeatures: [{ name: "send", blockReason: "usage_limit" }] } });
    expect(rewriteAppServerLine(blocks)).toBeNull();
  });

  test("lines without gate fields, unparseable lines and already-open gates are not touched", () => {
    expect(rewriteAppServerLine(JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "hello" } }))).toBeNull();
    expect(rewriteAppServerLine('{"rateLimits": broken')).toBeNull();
    expect(rewriteAppServerLine(rpcResult({ ordinaryUsageAllowed: true, rateLimits: { rateLimitReachedType: null } }))).toBeNull();
  });

  test("a message that only quotes a field name inside text is not modified", () => {
    const line = JSON.stringify({ method: "item/completed", params: { text: "the rateLimitReachedType field is rate_limit_reached" } });
    expect(rewriteAppServerLine(line)).toBeNull();
  });
});

describe("gate rewrite on the web usage snapshot's spelling", () => {
  // The rewrite reads every gate field in both spellings (rate_limit/rateLimit,
  // limit_reached/limitReached, spend_control/spendControlReached, ...). The usage window must be
  // read in both too, or a snake_case snapshot never shows the plain quota as the reason.
  const snapshot = (usedPercent: number, spendReached = false) => ({
    usage: {
      plan_type: "pro",
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { used_percent: usedPercent, limit_window_seconds: 604800, reset_after_seconds: 205162 },
      },
      spend_control: { reached: spendReached },
    },
  });

  test("a window at used_percent 100 is plain-quota evidence: the flags open, the window stays as sent", () => {
    const value = snapshot(100);
    expect(unlockRateLimitGate(value)).toBe(true);
    expect(value.usage.rate_limit.allowed).toBe(true);
    expect(value.usage.rate_limit.limit_reached).toBe(false);
    expect(value.usage.rate_limit.primary_window).toEqual(snapshot(100).usage.rate_limit.primary_window);
  });

  test("below 100% the payload shows no quota reason, so the flags stay closed", () => {
    const value = snapshot(42);
    expect(unlockRateLimitGate(value)).toBe(false);
    expect(value).toEqual(snapshot(42));
  });

  test("a reached spend control keeps the flags closed even with the window at 100%", () => {
    const value = snapshot(100, true);
    expect(unlockRateLimitGate(value)).toBe(false);
    expect(value).toEqual(snapshot(100, true));
  });
});

describe("app-server line filter", () => {
  const collect = (chunks: Uint8Array[], filter = createRpcLineFilter()) => {
    const parts: Uint8Array[] = [];
    for (const chunk of chunks) parts.push(...filter.push(chunk));
    parts.push(...filter.flush());
    return new TextDecoder().decode(Buffer.concat(parts));
  };
  const enc = (s: string) => new TextEncoder().encode(s);

  test("untouched lines come back byte for byte, including multibyte text and odd line endings", () => {
    const text = `${JSON.stringify({ method: "x", params: { t: "你好 🌏 é" } })}\n\r\n${JSON.stringify({ a: 1 })}\r\n`;
    expect(collect([enc(text)])).toBe(text);
  });

  test("a gate line is rewritten wherever the chunk boundaries fall", () => {
    const gate = rpcResult(EXHAUSTED_RATE_LIMITS);
    const stream = `${JSON.stringify({ method: "a", params: { t: "你好" } })}\n${gate}\n${JSON.stringify({ method: "b" })}\n`;
    const bytes = enc(stream);
    for (const size of [1, 2, 3, 7, 64, bytes.length]) {
      const chunks: Uint8Array[] = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
      const out = collect(chunks).split("\n");
      expect(out[0]).toBe(JSON.stringify({ method: "a", params: { t: "你好" } }));
      expect(JSON.parse(out[1]!).result.rateLimits.rateLimitReachedType).toBeNull();
      expect(out[2]).toBe(JSON.stringify({ method: "b" }));
      expect(out[3]).toBe("");
    }
  });

  test("a final line without a newline is flushed, and rewritten when it needs it", () => {
    expect(collect([enc('{"method":"tail"}')])).toBe('{"method":"tail"}');
    const out = collect([enc(rpcResult(EXHAUSTED_RATE_LIMITS))]);
    expect(out.endsWith("\n")).toBe(false);
    expect(JSON.parse(out).result.ordinaryUsageAllowed).toBe(true);
  });

  test("a long line spread over many chunks comes back whole, and a gate line after it is still rewritten", () => {
    const long = JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "x".repeat(200_000) } });
    const bytes = enc(`${long}\n${rpcResult(EXHAUSTED_RATE_LIMITS)}\n`);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 1024) chunks.push(bytes.slice(i, i + 1024));
    const out = collect(chunks).split("\n");
    expect(out[0]).toBe(long);
    expect(JSON.parse(out[1]!).result.ordinaryUsageAllowed).toBe(true);
  });

  // The cap sits between the ordinary gate line (~320 bytes) and the padded one (~2.3 KB).
  test("a line over the cap streams through raw, never parsed, and filtering resumes after its newline", () => {
    const seen: string[] = [];
    const rewrite = (line: string) => {
      seen.push(line);
      return rewriteAppServerLine(line);
    };
    const oversized = rpcResult({ ...EXHAUSTED_RATE_LIMITS, padding: "y".repeat(2000) });
    const bytes = enc(`${oversized}\n${rpcResult(EXHAUSTED_RATE_LIMITS)}\n`);
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += 64) chunks.push(bytes.slice(i, i + 64));
    const out = collect(chunks, createRpcLineFilter(rewrite, 1024)).split("\n");
    expect(out[0]).toBe(oversized);
    expect(JSON.parse(out[1]!).result.ordinaryUsageAllowed).toBe(true);
    expect(seen.some(line => line.includes("padding"))).toBe(false);

    // The same oversized line arriving whole, newline included, in one chunk is not parsed either.
    seen.length = 0;
    const single = collect([enc(`${oversized}\n${rpcResult(EXHAUSTED_RATE_LIMITS)}\n`)], createRpcLineFilter(rewrite, 1024)).split("\n");
    expect(single[0]).toBe(oversized);
    expect(JSON.parse(single[1]!).result.ordinaryUsageAllowed).toBe(true);
    expect(seen.some(line => line.includes("padding"))).toBe(false);
  });
});

describe("app-server stdout filter", () => {
  const chunksOf = async function* (parts: string[]) {
    for (const part of parts) yield new TextEncoder().encode(part);
  };
  const run = async (parts: string[], rewrite?: (line: string) => string | null) => {
    const written: Uint8Array[] = [];
    await runStdoutFilter(chunksOf(parts), bytes => void written.push(bytes), rewrite);
    return new TextDecoder().decode(Buffer.concat(written));
  };

  test("copies the server's stdout through, rewriting only the gate lines", async () => {
    const out = await run([`${JSON.stringify({ method: "a" })}\n${rpcResult(EXHAUSTED_RATE_LIMITS)}\n`, '{"method":"done"}']);
    const lines = out.split("\n");
    expect(lines[0]).toBe('{"method":"a"}');
    expect(JSON.parse(lines[1]!).result.rateLimits.rateLimitReachedType).toBeNull();
    expect(lines[2]).toBe('{"method":"done"}');
  });

  test("a rewrite that throws passes its line through unchanged instead of breaking the stream", async () => {
    const text = `${rpcResult(EXHAUSTED_RATE_LIMITS)}\n{"method":"after"}\n`;
    const out = await run([text], () => {
      throw new Error("boom");
    });
    expect(out).toBe(text);
  });
});


test("hidden filter self-test succeeds without streaming stdin", async () => {
  expect(await runChatgptAppServerFilter({ selfTest: true })).toBe(0);
});

test("machinery failure preserves buffered bytes and switches the remainder to raw passthrough", () => {
  const enc = new TextEncoder();
  const filter = createRpcLineFilter(() => Symbol("encoding failure") as unknown as string);
  expect(filter.push(enc.encode("partial"))).toEqual([]);
  const out = [...filter.push(enc.encode(" tail\nnext\n")), ...filter.push(enc.encode("raw tail")), ...filter.flush()];
  expect(Buffer.concat(out).toString()).toBe("partial tail\nnext\nraw tail");
});
