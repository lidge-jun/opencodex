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

  test("reads the OpenRouter wording, treating a bare timestamp as UTC", () => {
    const body = JSON.stringify({
      error: { code: "rate_limit_error", message: "Weekly Limit Exhausted. Your limit will reset at 2026-09-09 03:30:06" },
    });
    expect(parseQuotaResetAt(body, now)).toBe(Date.parse("2026-09-09T03:30:06Z"));
  });

  test("honours an explicit zone rather than re-stamping it as UTC", () => {
    const at = parseQuotaResetAt("limit will reset at 2026-09-09T03:30:06+05:30", now);
    expect(at).toBe(Date.parse("2026-09-09T03:30:06+05:30"));
    expect(at).not.toBe(Date.parse("2026-09-09T03:30:06Z"));
  });

  test("accepts the 'resets at' spelling and a date with no clock time", () => {
    expect(parseQuotaResetAt("quota resets at 2026-09-09", now)).toBe(Date.parse("2026-09-09T00:00:00Z"));
  });

  test("a body it cannot read yields undefined, so today's behaviour is unchanged", () => {
    for (const body of [
      null,
      undefined,
      "",
      "429 Too Many Requests",
      JSON.stringify({ error: { message: "rate limited, try later" } }),
      "will reset at soon",
      "will reset at 2026-13-45 99:99:99",
    ]) {
      expect(parseQuotaResetAt(body as string | null | undefined, now)).toBeUndefined();
    }
  });

  test("a reset already in the past is not a park-until instant", () => {
    expect(parseQuotaResetAt("will reset at 2026-08-01 00:00:00", now)).toBeUndefined();
  });

  test("a monthly window is honoured in full, not clamped", () => {
    // `Weekly/Monthly Limit Exhausted` is the wording upstream sends, so a reset
    // up to ~31 days out is legitimate. Clamping it would resume the 429 loop
    // weeks early — the failure this feature exists to prevent.
    const monthly = "will reset at 2026-10-01 00:00:00";
    expect(parseQuotaResetAt(monthly, now)).toBe(Date.parse("2026-10-01T00:00:00Z"));
  });

  test("an absurd or hostile date is capped rather than parking the key forever", () => {
    const at = parseQuotaResetAt("will reset at 2999-01-01 00:00:00", now);
    expect(at).toBe(now + 32 * 24 * 60 * 60_000);
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

  test("stops pulling after the cap instead of buffering the whole body", async () => {
    // A chatty upstream must not make the rotation path read megabytes. This counts
    // what the reader actually PULLED, not what the parser looked at — the two were
    // different before this was fixed (`.text()` read it all, then sliced 4KB).
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(64 * 1_024));
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
    });

    const { at } = await readQuotaResetAt(new Response(body, { status: 429 }), now);

    expect(at).toBeUndefined();
    expect(pulled).toBeLessThan(total / 4);
  });

  test("still finds a reset that sits inside the cap", async () => {
    const body = `{"error":{"message":"Weekly Limit Exhausted. Your limit will reset at 2026-09-05 12:00:00"}}`;
    expect((await readQuotaResetAt(new Response(body, { status: 429 }), now)).at)
      .toBe(Date.parse("2026-09-05T12:00:00Z"));
  });
});
