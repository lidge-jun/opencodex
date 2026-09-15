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

  test("pulls the reset from a 429 body without consuming it for the caller", async () => {
    const body = JSON.stringify({
      error: { code: "rate_limit_error", message: "Weekly Limit Exhausted. Your limit will reset at 2026-09-05 12:00:00" },
    });
    const response = new Response(body, { status: 429 });

    expect(await readQuotaResetAt(response, now)).toBe(Date.parse("2026-09-05T12:00:00Z"));
    // The caller still cancels the original to release the socket — it must not
    // already be disturbed by the read above.
    expect(response.bodyUsed).toBe(false);
    await response.body?.cancel();
  });

  test("a bodyless or unreadable response leaves the Retry-After path in charge", async () => {
    expect(await readQuotaResetAt(new Response(null, { status: 429 }), now)).toBeUndefined();
    const consumed = new Response("x", { status: 429 });
    await consumed.text();
    expect(await readQuotaResetAt(consumed, now)).toBeUndefined();
  });
});
