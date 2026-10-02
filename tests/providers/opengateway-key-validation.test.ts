import { afterEach, expect, test } from "bun:test";
import { KEY_LOGIN_PROVIDERS, validateApiKey } from "../../src/oauth/key-providers";
import { deriveKeyLoginMap } from "../../src/providers/derive";

// OpenGateway's public GET /v1/models answers 200 for any Bearer value, so a key can never be
// validated against it; the derived login entry must carry that policy into the login flow.
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("derived OpenGateway login preserves unknown validation", () => {
  expect(deriveKeyLoginMap().opengateway?.apiKeyValidation).toBe("unknown");
  expect(KEY_LOGIN_PROVIDERS.opengateway?.apiKeyValidation).toBe("unknown");
});

test("the public catalog is never probed to validate a key", async () => {
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return Response.json({ object: "list", data: [] }); }) as unknown as typeof fetch;
  expect(await validateApiKey("opengateway", KEY_LOGIN_PROVIDERS.opengateway!, "any-key")).toBe("unknown");
  expect(calls).toBe(0);
});
