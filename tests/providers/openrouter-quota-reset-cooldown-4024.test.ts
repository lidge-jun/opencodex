import { describe, expect, test } from "bun:test";
import { parseQuotaResetAt, readQuotaResetAt } from "../../src/providers/key-failover";

/**
 * #4024 — a free-tier quota exhaustion is dated by the upstream, and OpenRouter
 * sends it in the 429 body rather than in `Retry-After`. Without reading it the
 * key is parked for the undated-429 cap (10 min), comes back, takes another 429,
 * and repeats for the rest of the quota window.
 */
describe("parseQuotaResetAt", () => {
  const now = Date.parse("2026-09-01T00:00:00Z");
  const quotaBody = (message: string, code: string | number = "rate_limit_error") => JSON.stringify({
    error: { code, message },
  });

  test("reads the OpenRouter wording, treating a bare timestamp as UTC", () => {
    const body = quotaBody("Weekly Limit Exhausted. Your limit will reset at 2026-09-09 03:30:06");
    expect(parseQuotaResetAt(body, now)).toBe(Date.parse("2026-09-09T03:30:06Z"));
  });

  test("honours an explicit zone rather than re-stamping it as UTC", () => {
    const at = parseQuotaResetAt(quotaBody("Monthly Limit Exhausted. Your limit will reset at 2026-09-09T03:30:06+05:30", 429), now);
    expect(at).toBe(Date.parse("2026-09-09T03:30:06+05:30"));
    expect(at).not.toBe(Date.parse("2026-09-09T03:30:06Z"));
  });

  test("accepts the 'resets at' spelling and a date with no clock time", () => {
    expect(parseQuotaResetAt(quotaBody("Weekly Limit Exhausted. Quota resets at 2026-09-09"), now))
      .toBe(Date.parse("2026-09-09T00:00:00Z"));
  });

  test("a body it cannot read yields undefined, so today's behaviour is unchanged", () => {
    for (const body of [
      null,
      undefined,
      "",
      "429 Too Many Requests",
      JSON.stringify({ error: { message: "rate limited, try later" } }),
      quotaBody("Weekly Limit Exhausted. Your limit will reset at soon"),
      quotaBody("Weekly Limit Exhausted. Your limit will reset at 2026-13-45 99:99:99"),
    ]) {
      expect(parseQuotaResetAt(body as string | null | undefined, now)).toBeUndefined();
    }
  });

  test("a reset already in the past is not a park-until instant", () => {
    expect(parseQuotaResetAt(quotaBody("Weekly Limit Exhausted. Will reset at 2026-08-01 00:00:00"), now)).toBeUndefined();
  });

  test("a monthly window is honoured in full, not clamped", () => {
    // `Weekly/Monthly Limit Exhausted` is the wording upstream sends, so a reset
    // up to ~31 days out is legitimate. Clamping it would resume the 429 loop
    // weeks early — the failure this feature exists to prevent.
    const monthly = quotaBody("Monthly Limit Exhausted. Will reset at 2026-10-01 00:00:00");
    expect(parseQuotaResetAt(monthly, now)).toBe(Date.parse("2026-10-01T00:00:00Z"));
  });

  test("an absurd or hostile date is capped rather than parking the key forever", () => {
    const at = parseQuotaResetAt(quotaBody("Monthly Limit Exhausted. Will reset at 2999-01-01 00:00:00"), now);
    expect(at).toBe(now + 32 * 24 * 60 * 60_000);
  });

  test("a day the calendar does not have is refused, not rolled forward", () => {
    // `Date.parse` does not reject an out-of-range DAY — measured on Bun,
    // `2026-02-30T00:00:00Z` yields March 2 — so without this the key parks
    // past the instant the upstream actually named. Only the month is caught
    // by the parser itself.
    const feb = Date.parse("2026-02-25T00:00:00Z");
    expect(parseQuotaResetAt(quotaBody("Weekly Limit Exhausted. Resets at 2026-02-30T00:00:00Z"), feb)).toBeUndefined();
    expect(parseQuotaResetAt(quotaBody("Weekly Limit Exhausted. Resets at 2026-02-29T00:00:00Z"), feb)).toBeUndefined();
    expect(parseQuotaResetAt(quotaBody("Weekly Limit Exhausted. Resets at 2026-04-31T00:00:00Z"), Date.parse("2026-04-25T00:00:00Z"))).toBeUndefined();
    expect(parseQuotaResetAt(quotaBody("Weekly Limit Exhausted. Resets at 2026-13-01T00:00:00Z"), feb)).toBeUndefined();
  });

  test("real leap days still park the key, including the century rule", () => {
    // The guard above must not cost a legitimate Feb 29. 2024 is a leap year,
    // 2000 is one (divisible by 400) and 2100 is not (divisible by 100).
    expect(parseQuotaResetAt(quotaBody("Weekly Limit Exhausted. Resets at 2024-02-29T00:00:00Z"), Date.parse("2024-02-25T00:00:00Z")))
      .toBe(Date.parse("2024-02-29T00:00:00Z"));
    expect(parseQuotaResetAt(quotaBody("Weekly Limit Exhausted. Resets at 2000-02-29T00:00:00Z"), Date.parse("2000-02-25T00:00:00Z")))
      .toBe(Date.parse("2000-02-29T00:00:00Z"));
    expect(parseQuotaResetAt(quotaBody("Weekly Limit Exhausted. Resets at 2100-02-29T00:00:00Z"), Date.parse("2100-02-25T00:00:00Z")))
      .toBeUndefined();
  });

  test("rejects unrelated 429 prose and lookalike JSON from other providers", () => {
    const date = "2026-09-09 03:30:06";
    expect(parseQuotaResetAt(`service resets at ${date}`, now)).toBeUndefined();
    expect(parseQuotaResetAt(JSON.stringify({ error: { code: "rate_limit_error", message: `service resets at ${date}` } }), now))
      .toBeUndefined();
    expect(parseQuotaResetAt(JSON.stringify({ error: { code: "other_provider", message: `Weekly Limit Exhausted. Resets at ${date}` } }), now))
      .toBeUndefined();
  });

  test("only the first 4KB is scanned, so a huge body cannot stall the rotation path", () => {
    const padded = "x".repeat(8_000) + " will reset at 2026-09-09 03:30:06";
    expect(parseQuotaResetAt(padded, now)).toBeUndefined();
  });
});

describe("readQuotaResetAt", () => {
  const now = Date.parse("2026-09-01T00:00:00Z");

  test("returns the reset AND a response whose body is still fully readable", async () => {
    // The caller still needs this response: on a failed rotation adapter-dispatch
    // breaks out of the loop with it, and on a successful one it cancels the body
    // to release the socket. Peeking must not cost it either.
    const body = JSON.stringify({
      error: { code: "rate_limit_error", message: "Weekly Limit Exhausted. Your limit will reset at 2026-09-05 12:00:00" },
    });
    const { at, response } = await readQuotaResetAt(new Response(body, { status: 429 }), now);

    expect(at).toBe(Date.parse("2026-09-05T12:00:00Z"));
    expect(response.status).toBe(429);
    // The bytes already pulled are replayed ahead of the remainder.
    expect(await response.text()).toBe(body);
  });

  test("the returned response can be cancelled instead of read", async () => {
    const { response } = await readQuotaResetAt(new Response("x".repeat(10_000), { status: 429 }), now);
    await response.body?.cancel();
    expect(response.bodyUsed).toBe(true);
  });

  test("a bodyless or unreadable response leaves the Retry-After path in charge", async () => {
    expect((await readQuotaResetAt(new Response(null, { status: 429 }), now)).at).toBeUndefined();
    const consumed = new Response("x", { status: 429 });
    await consumed.text();
    expect((await readQuotaResetAt(consumed, now)).at).toBeUndefined();
  });
});

describe("readQuotaResetAt — the read is bounded, not just the parse", () => {
  const now = Date.parse("2026-09-01T00:00:00Z");

  test("scans exactly the cap and replays overflow from a larger boundary chunk", async () => {
    // A stream read is chunk-atomic, so the first pull may exceed 4 KiB. The parser
    // receives exactly 4 KiB while the boundary overflow is replayed before later
    // chunks; reading the rebuilt response must reproduce every byte in order.
    let pulled = 0;
    const reset = JSON.stringify({
      error: { code: "rate_limit_error", message: "Weekly Limit Exhausted. Your limit will reset at 2026-09-05 12:00:00" },
    });
    const first = reset + " ".repeat(4_096 - reset.length) + "overflow-must-not-enter-the-parser";
    const chunk = new TextEncoder().encode(first.padEnd(64 * 1_024, "x"));
    const total = 5 * 1_024 * 1_024;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulled >= total) {
          controller.close();
          return;
        }
        pulled += chunk.byteLength;
        controller.enqueue(chunk);
      },
    }, { highWaterMark: 0 });

    const { at, response } = await readQuotaResetAt(new Response(body, { status: 429 }), now);

    expect(at).toBe(Date.parse("2026-09-05T12:00:00Z"));
    expect(pulled).toBe(chunk.byteLength);
    expect(await response.text()).toBe(new TextDecoder().decode(chunk).repeat(total / chunk.byteLength));
  });

  test("still finds a reset that sits inside the cap", async () => {
    const body = `{"error":{"code":"rate_limit_error","message":"Weekly Limit Exhausted. Your limit will reset at 2026-09-05 12:00:00"}}`;
    expect((await readQuotaResetAt(new Response(body, { status: 429 }), now)).at)
      .toBe(Date.parse("2026-09-05T12:00:00Z"));
  });

  test("a stalled peek times out, cancels its reader, and returns an unlocked response", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => {});
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await readQuotaResetAt(new Response(body, { status: 429 }), { now, timeoutMs: 1 });

    expect(result.at).toBeUndefined();
    expect(cancelled).toBe(true);
    expect(result.response.body?.locked).toBe(false);
    expect(await result.response.text()).toBe("");
  });

  test("client cancellation rejects instead of producing a cooldown candidate", async () => {
    const abort = new AbortController();
    const reason = new DOMException("client closed", "AbortError");
    const body = new ReadableStream<Uint8Array>({
      pull() {
        abort.abort(reason);
        return new Promise<void>(() => {});
      },
    });

    await expect(readQuotaResetAt(new Response(body, { status: 429 }), {
      now,
      signal: abort.signal,
      timeoutMs: 1_000,
    })).rejects.toMatchObject({ name: "AbortError", message: "client closed" });
    expect(body.locked).toBe(false);
  });
});
