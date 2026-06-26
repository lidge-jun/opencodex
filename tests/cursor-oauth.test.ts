import { afterEach, describe, expect, test } from "bun:test";
import {
  generateCursorAuthParams,
  getTokenExpiry,
  loginCursor,
  pollCursorAuth,
  refreshCursorToken,
} from "../src/oauth/cursor";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString("base64url");
  return `${header}.${payload}.sig`;
}

describe("Cursor OAuth core flow", () => {
  test("generateCursorAuthParams builds a PKCE login URL with the challenge but never the verifier", async () => {
    const p = await generateCursorAuthParams();
    expect(p.verifier).toBeTruthy();
    expect(p.challenge).toBeTruthy();
    const url = new URL(p.loginUrl);
    expect(url.host).toBe("cursor.com");
    expect(url.pathname).toBe("/loginDeepControl");
    expect(url.searchParams.get("challenge")).toBe(p.challenge);
    expect(url.searchParams.get("mode")).toBe("login");
    expect(url.searchParams.get("redirectTarget")).toBe("cli");
    expect(url.searchParams.has("verifier")).toBe(false);
    expect(p.loginUrl).not.toContain(p.verifier);
  });

  test("pollCursorAuth returns tokens after a 404 (pending) then 200", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 404 });
      return new Response(JSON.stringify({ accessToken: "acc", refreshToken: "ref" }), { status: 200 });
    }) as typeof fetch;
    const out = await pollCursorAuth("uuid", "ver", undefined, 1);
    expect(out).toEqual({ accessToken: "acc", refreshToken: "ref" });
    expect(calls).toBe(2);
  });

  test("pollCursorAuth throws when the success payload is missing tokens", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({}), { status: 200 })) as typeof fetch;
    await expect(pollCursorAuth("uuid", "ver", undefined, 1)).rejects.toThrow();
  });

  test("pollCursorAuth aborts promptly on a pre-aborted signal", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(pollCursorAuth("uuid", "ver", ctrl.signal, 1)).rejects.toThrow(/cancel/i);
  });

  test("refreshCursorToken posts the refresh token as a Bearer and returns new creds", async () => {
    let seenAuth = "";
    globalThis.fetch = (async (_url: string | URL, init?: RequestInit) => {
      seenAuth = String((init?.headers as Record<string, string>)?.Authorization ?? "");
      return new Response(JSON.stringify({ accessToken: "newAcc", refreshToken: "newRef" }), { status: 200 });
    }) as typeof fetch;
    const out = await refreshCursorToken("rt");
    expect(seenAuth).toBe("Bearer rt");
    expect(out.access).toBe("newAcc");
    expect(out.refresh).toBe("newRef");
  });

  test("refreshCursorToken keeps the old refresh when the server omits it", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ accessToken: "a2" }), { status: 200 })) as typeof fetch;
    const out = await refreshCursorToken("keepme");
    expect(out.refresh).toBe("keepme");
  });

  test("refreshCursorToken throws on non-ok without leaking the token", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as typeof fetch;
    const err = await refreshCursorToken("secret-rt").catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).not.toContain("secret-rt");
  });

  test("getTokenExpiry parses JWT exp with a 5-minute skew", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(getTokenExpiry(jwtWithExp(exp))).toBe(exp * 1000 - 5 * 60 * 1000);
  });

  test("getTokenExpiry falls back ~1h for a malformed token", () => {
    const before = Date.now();
    const v = getTokenExpiry("not-a-jwt");
    expect(v).toBeGreaterThanOrEqual(before + 3600 * 1000 - 1000);
    expect(v).toBeLessThanOrEqual(Date.now() + 3600 * 1000 + 1000);
  });

  test("loginCursor surfaces the login URL via onAuth and returns parsed creds", async () => {
    let authedUrl = "";
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ accessToken: jwtWithExp(Math.floor(Date.now() / 1000) + 3600), refreshToken: "ref" }),
        { status: 200 },
      )) as typeof fetch;
    const creds = await loginCursor({ onAuth: ({ url }) => { authedUrl = url; }, onProgress: () => {} }, 1);
    expect(authedUrl).toContain("cursor.com/loginDeepControl");
    expect(creds.access).toBeTruthy();
    expect(creds.refresh).toBe("ref");
  });
});
