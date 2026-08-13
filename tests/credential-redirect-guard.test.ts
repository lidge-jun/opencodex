/**
 * Cross-origin redirect guard for credential-bearing sidecars (#1471 review).
 *
 * Bun follows 3xx by default. It drops `Authorization` when the redirect crosses origins, but
 * it forwards NONSTANDARD headers unchanged — which is exactly where the Codex identity lives:
 * `chatgpt-account-id`, `session_id`, `x-codex-turn-metadata`. So a canonical ChatGPT endpoint
 * answering 302 would hand those to the redirect target while `Authorization` looked safely
 * stripped. The first test proves that runtime behavior rather than asserting it from memory;
 * the second pins the fix at every credential-bearing call site.
 */
import { describe, expect, test } from "bun:test";

describe("Bun forwards nonstandard headers across a redirect", () => {
  test("Authorization is dropped but Codex identity headers are not", async () => {
    const captured: Record<string, string | null> = {};
    const target = Bun.serve({
      port: 0,
      fetch(req) {
        captured.authorization = req.headers.get("authorization");
        captured.account = req.headers.get("chatgpt-account-id");
        captured.session = req.headers.get("session_id");
        captured.turn = req.headers.get("x-codex-turn-metadata");
        return new Response("ok");
      },
    });
    const origin = Bun.serve({
      port: 0,
      fetch: () => new Response(null, {
        status: 302,
        headers: { location: `http://127.0.0.1:${target.port}/landed` },
      }),
    });

    try {
      await fetch(`http://127.0.0.1:${origin.port}/start`, {
        headers: {
          authorization: "Bearer secret-token",
          "chatgpt-account-id": "acct-123",
          session_id: "sess-456",
          "x-codex-turn-metadata": "turn-789",
        },
      });
    } finally {
      origin.stop(true);
      target.stop(true);
    }

    // The half that looks safe...
    expect(captured.authorization).toBeNull();
    // ...and the half that is not. This is why `redirect: "manual"` is required and why
    // relying on Authorization stripping alone would be a false sense of safety.
    expect(captured.account).toBe("acct-123");
    expect(captured.session).toBe("sess-456");
    expect(captured.turn).toBe("turn-789");
  });
});

describe("credential-bearing sidecars refuse to follow redirects", () => {
  const sites: Array<{ file: string; label: string }> = [
    { file: "../src/server/images.ts", label: "images relay" },
    { file: "../src/server/live.ts", label: "live relay" },
    { file: "../src/server/search.ts", label: "search relay" },
    { file: "../src/web-search/executor.ts", label: "web-search sidecar" },
    { file: "../src/vision/describe.ts", label: "vision sidecar" },
  ];

  for (const { file, label } of sites) {
    test(`${label} sets redirect: "manual"`, async () => {
      const source = await Bun.file(new URL(file, import.meta.url)).text();
      expect(source).toContain('redirect: "manual"');
    });
  }

  // The Responses and compact paths reach the same policy through a different mechanism:
  // `fetchWithHeaderTimeout` takes a `manualRedirect` flag and applies `redirect: "manual"`
  // centrally (#914). Assert the shared helper still does that, so the two families cannot
  // drift apart silently.
  test("the shared credential-bearing fetch helper still applies manual redirects", async () => {
    const helper = await Bun.file(new URL("../src/server/responses/fetch-helpers.ts", import.meta.url)).text();
    expect(helper).toContain('redirect: "manual" as const');

    // And the callers still opt in for forward auth rather than dropping the flag.
    const compact = await Bun.file(new URL("../src/server/responses/compact.ts", import.meta.url)).text();
    expect(compact).toContain('sendProvider.authMode === "forward"');
  });
});
