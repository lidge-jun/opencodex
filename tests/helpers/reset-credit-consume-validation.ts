import { expect, test } from "bun:test";
import { handleCodexAuthAPI } from "../../src/codex/auth-api";
import { BOUNDED_BODY_MAX_BYTES } from "../../src/lib/bounded-body";
import type { OcxConfig } from "../../src/types";

export function registerResetCreditConsumeValidationTests(
  makeConfig: () => OcxConfig,
  seedPoolAccount: (config: OcxConfig, options: { id: string; email: string }) => unknown,
): void {
  test("reset-credit consume rejects invalid account ids before credential lookup", async () => {
    const req = new Request("http://localhost/api/codex-auth/reset-credits/consume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accountId: "../bad" }),
    });
    const resp = await handleCodexAuthAPI(req, new URL(req.url), makeConfig());
    expect(resp!.status).toBe(400);
    expect(await resp!.json()).toMatchObject({ error: "Invalid account id format" });
  });

  test("reset-credit consume refuses an upstream body past the shared bound instead of buffering it", async () => {
    const config = makeConfig();
    seedPoolAccount(config, { id: "pool-oversized", email: "oversized@example.test" });
    const originalFetch = globalThis.fetch;
    let usageCalls = 0;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/backend-api/wham/rate-limit-reset-credits/consume")) {
          // A 200 with an unbounded body was read whole by resp.json() before anything
          // looked at its size, unlike every other reset-credit read on this path.
          const padding = "x".repeat(BOUNDED_BODY_MAX_BYTES * 2);
          return new Response(`{"code":"reset","padding":"${padding}"}`, {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/backend-api/wham/usage")) {
          usageCalls += 1;
          return Response.json({
            rate_limit: { primary_window: { used_percent: 10, reset_at: 1782000000 } },
            rate_limit_reset_credits: { available_count: 2 },
          });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      const req = new Request("http://localhost/api/codex-auth/reset-credits/consume", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId: "pool-oversized" }),
      });
      const resp = await handleCodexAuthAPI(req, new URL(req.url), config);
      expect(resp!.status).toBe(502);
      expect(await resp!.json()).toEqual({ error: "Invalid upstream reset-credit consume response" });
      // The outcome is unconfirmed, so nothing downstream may treat the redeem as observed.
      expect(usageCalls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

}
