import { afterEach, describe, expect, test } from "bun:test";
import { loginKimi } from "../src/oauth/kimi";
import type { OAuthController } from "../src/oauth/types";

/**
 * Every device-flow provider must report the human-typed user code in the
 * structured `deviceCode` field, not only inside prose `instructions`.
 *
 * Two things depend on it, and neither is visible from the provider file:
 * the GUI renders a copyable code widget from that field, and the management
 * login route uses its presence to decide that a flow is a device flow and
 * therefore must NOT be handed to a local browser spawn. A provider that
 * omits it silently loses both.
 */

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function deviceAuthorizationResponder(): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/api/oauth/device_authorization")) {
      return new Response(JSON.stringify({
        user_code: "WDJB-MJHT",
        device_code: "device-code-opaque",
        verification_uri: "https://auth.kimi.com/device",
        verification_uri_complete: "https://auth.kimi.com/device?user_code=WDJB-MJHT",
        expires_in: 900,
        interval: 5,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    // Any token poll: keep the flow pending so the test only observes onAuth.
    return new Response(JSON.stringify({ error: "authorization_pending" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("device-flow onAuth contract", () => {
  test("Kimi reports the user code in deviceCode, not only in instructions", async () => {
    deviceAuthorizationResponder();
    const abort = new AbortController();
    let seen: { url?: string; instructions?: string; deviceCode?: string } | undefined;
    const ctrl: OAuthController = {
      onAuth: (info) => {
        seen = info;
        // The credential never arrives in this test; stop the poll loop here.
        abort.abort("observed");
      },
      signal: abort.signal,
    };

    await loginKimi(ctrl).catch(() => {});

    expect(seen?.deviceCode).toBe("WDJB-MJHT");
    // The prose is unchanged, so the CLI keeps printing what it printed.
    expect(seen?.instructions).toContain("WDJB-MJHT");
    expect(seen?.url).toBe("https://auth.kimi.com/device?user_code=WDJB-MJHT");
  });
});
