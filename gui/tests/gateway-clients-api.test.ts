import { afterEach, expect, test } from "bun:test";
import { runGatewayClientAction } from "../src/pages/integrations/gateway-clients-api";

/** The action client reads a refusal's code but never parses a body it has no contract for. */
const previousFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = previousFetch; });

function answer(response: Response): void {
  globalThis.fetch = (async () => response) as unknown as typeof fetch;
}

test("a 409 refusal is reached and carries its code", async () => {
  answer(new Response(JSON.stringify({ ok: false, code: "io-error", message: "Could not update the client files." }), { status: 409 }));
  expect(await runGatewayClientAction("", "antigravity", "connect")).toEqual({
    reached: true, ok: false, code: "io-error", message: "Could not update the client files.", profilePath: null, changed: false, restore: null,
  });
});

test("a 5xx answer is reached but not parsed", async () => {
  answer(new Response("<html>bad gateway</html>", { status: 502 }));
  expect(await runGatewayClientAction("", "antigravity", "connect")).toEqual({
    reached: true, ok: false, code: null, message: null, profilePath: null, changed: false, restore: null,
  });
});
