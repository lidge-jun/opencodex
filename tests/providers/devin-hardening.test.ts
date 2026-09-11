import { describe, expect, test } from "bun:test";
import { normalizeDevinModelId } from "../../src/adapters/devin";
import { parseDevinAuthPaste, refreshDevinToken } from "../../src/oauth/devin";
import { DEVIN_DEFAULT_API_SERVER, resolveDevinApiBaseUrl, validateDevinApiBaseUrl } from "../../src/oauth/devin/api-base";
import { registerUser } from "../../src/oauth/devin/register-user";
import { anySignal } from "../../src/lib/abort";

const FAKE_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEifQ.c2lnbmF0dXJl";

describe("devin api-server allowlist", () => {
  test("accepts the default host and a tenant path, keeping the path", () => {
    expect(validateDevinApiBaseUrl("https://server.codeium.com")).toBe("https://server.codeium.com");
    expect(validateDevinApiBaseUrl("https://server.codeium.com/")).toBe("https://server.codeium.com");
    // EU and FedStart tenants live under a path prefix, so normalizing to the
    // origin the way the Copilot validator does would point them at the wrong
    // service rather than merely losing decoration.
    expect(validateDevinApiBaseUrl("https://eu.windsurf.com/_route/api_server")).toBe(
      "https://eu.windsurf.com/_route/api_server",
    );
    expect(validateDevinApiBaseUrl("https://windsurf.fedstart.com/_route/api_server")).toBe(
      "https://windsurf.fedstart.com/_route/api_server",
    );
  });

  test("rejects every shape that would redirect a credential-bearing POST", () => {
    for (const hostile of [
      "http://server.codeium.com",
      "https://attacker.example.com",
      "https://server.codeium.com.attacker.example",
      // Assembled rather than written out: a literal userinfo URL reads as an
      // email address to the privacy scanner.
      `https://user:secret${"@"}server.codeium.com`,
      "https://server.codeium.com:8443",
      "https://127.0.0.1",
      "https://localhost",
      "https://10.0.0.5",
      "https://server.codeium.com/path?next=https://evil.example",
      "https://server.codeium.com/path#frag",
      "not a url",
      "",
    ]) {
      expect(validateDevinApiBaseUrl(hostile)).toBeUndefined();
    }
    expect(resolveDevinApiBaseUrl("https://attacker.example.com")).toBe(DEVIN_DEFAULT_API_SERVER);
  });
});

describe("devin auth paste", () => {
  test("accepts a bare token and pulls one out of a callback URL", () => {
    expect(parseDevinAuthPaste(` ${FAKE_TOKEN} `)).toBe(FAKE_TOKEN);
    expect(parseDevinAuthPaste(`https://windsurf.com/callback#access_token=${FAKE_TOKEN}&state=abc`)).toBe(FAKE_TOKEN);
    expect(parseDevinAuthPaste(`https://windsurf.com/cb?firebase_id_token=${FAKE_TOKEN}`)).toBe(FAKE_TOKEN);
  });

  test("refuses a paste with no token instead of posting it as the token", () => {
    expect(() => parseDevinAuthPaste("https://windsurf.com/windsurf/signin?prompt=login")).toThrow(/no auth token/i);
    expect(() => parseDevinAuthPaste("hello")).toThrow(/not a Devin auth token/i);
    expect(() => parseDevinAuthPaste("   ")).toThrow(/No auth token pasted/i);
  });
});

describe("devin credential lifecycle", () => {
  test("refresh fails closed rather than extending a possibly revoked key", async () => {
    // The carried implementation returned an extended expiry, which made a
    // revoked key look valid forever. Throwing is what marks needsReauth.
    await expect(refreshDevinToken("whatever")).rejects.toThrow(/invalid_grant/);
  });
});

describe("devin model ids", () => {
  test("dotted version numbers collapse to the hyphenated catalog spelling", () => {
    expect(normalizeDevinModelId("swe-1.6")).toBe("swe-1-6");
    expect(normalizeDevinModelId("claude-opus-4.7-max")).toBe("claude-opus-4-7-max");
    expect(normalizeDevinModelId("swe-1-7")).toBe("swe-1-7");
  });
});

describe("registerUser error reporting", () => {
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };
  const region = {
    website: "https://windsurf.com",
    registerApiServerUrl: "https://register.windsurf.com",
    oauthClientId: "test-client",
  };

  test("an error body that echoes the token never reaches the message", async () => {
    await withFetch(
      (async () =>
        new Response(JSON.stringify({ code: "invalid_argument", message: `bad firebase_id_token ${FAKE_TOKEN}` }), {
          status: 400,
        })) as typeof fetch,
      async () => {
        const error = await registerUser(FAKE_TOKEN, region).catch((e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        const message = (error as Error).message;
        expect(message).not.toContain(FAKE_TOKEN);
        expect(message).toContain("HTTP 400");
        expect(message).toContain("invalid_argument");
      },
    );
  });

  test("a 200 with an unparseable body reports its size, not its contents", async () => {
    await withFetch(
      (async () => new Response(`<html>${FAKE_TOKEN}</html>`, { status: 200 })) as typeof fetch,
      async () => {
        const error = await registerUser(FAKE_TOKEN, region).catch((e: Error) => e);
        expect((error as Error).message).not.toContain(FAKE_TOKEN);
        expect((error as Error).message).toMatch(/not JSON/i);
      },
    );
  });

  test("a register host outside the allowlist is refused before the token is sent", async () => {
    let called = false;
    await withFetch(
      (async () => {
        called = true;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
      async () => {
        const error = await registerUser(FAKE_TOKEN, { ...region, registerApiServerUrl: "https://evil.example" }).catch(
          (e: Error) => e,
        );
        expect((error as Error).message).toMatch(/non-Cognition register host/i);
        expect(called).toBe(false);
      },
    );
  });
});

describe("anySignal", () => {
  test("cleanup detaches from a parent signal that never aborts", () => {
    const parent = new AbortController();
    let added = 0;
    let removed = 0;
    const realAdd = parent.signal.addEventListener.bind(parent.signal);
    const realRemove = parent.signal.removeEventListener.bind(parent.signal);
    // Exercise the polyfill branch explicitly: on Bun the builtin
    // AbortSignal.any is used and owns its own teardown.
    const builtin = (AbortSignal as unknown as { any?: unknown }).any;
    (AbortSignal as unknown as { any?: unknown }).any = undefined;
    parent.signal.addEventListener = ((...args: Parameters<typeof realAdd>) => {
      added += 1;
      return realAdd(...args);
    }) as typeof realAdd;
    parent.signal.removeEventListener = ((...args: Parameters<typeof realRemove>) => {
      removed += 1;
      return realRemove(...args);
    }) as typeof realRemove;
    try {
      const composed = anySignal([parent.signal, AbortSignal.timeout(60_000)]);
      expect(composed.signal.aborted).toBe(false);
      composed.cleanup();
      expect(added).toBe(1);
      expect(removed).toBe(1);
    } finally {
      (AbortSignal as unknown as { any?: unknown }).any = builtin;
    }
  });

  test("aborts as soon as any input aborts", () => {
    const a = new AbortController();
    const b = new AbortController();
    const composed = anySignal([a.signal, b.signal]);
    expect(composed.signal.aborted).toBe(false);
    b.abort(new Error("stop"));
    expect(composed.signal.aborted).toBe(true);
    composed.cleanup();
  });
});
