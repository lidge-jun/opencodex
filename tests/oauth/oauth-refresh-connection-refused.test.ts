import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OAuthLoginRequiredError, OAUTH_PROVIDERS, refreshAnthropicAccountWithLock } from "../../src/oauth";
import { credentialGeneration, getAccountCredential, getAccountSet, readOAuthRefreshIntent, saveCredential } from "../../src/oauth/store";
import { socks5Fetch } from "../../src/lib/socks5-fetch";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * #8577: a refresh whose very first connection was refused (the configured local proxy was not up
 * yet at startup) never sent the refresh token, so it must stay retryable. Before the fix the
 * durable refresh intent outlived the refusal and the next attempt demanded a new login without
 * another token request.
 */
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
const savedEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;
let tmp = "";

beforeEach(() => {
  tmp = join(tmpdir(), `oauth-refused-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  for (const key of ["HOME", "USERPROFILE", "OPENCODEX_HOME", "CLAUDE_CONFIG_DIR", ...PROXY_KEYS]) savedEnv.set(key, process.env[key]);
  for (const key of PROXY_KEYS) delete process.env[key];
  process.env.HOME = tmp;
  process.env.USERPROFILE = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
  process.env.CLAUDE_CONFIG_DIR = join(tmp, ".claude");
  mkdirSync(process.env.CLAUDE_CONFIG_DIR);
  writeFileSync(join(process.env.CLAUDE_CONFIG_DIR, ".credentials.json"), "{}");
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  savedEnv.clear();
  removeTreeWithRetry(tmp);
});

async function closedLoopbackPort(): Promise<number> {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("unused") });
  const port = listener.port!;
  await listener.stop(true);
  return port;
}

/** Runs two refreshes; the first token request fails with whatever `first` produces. */
async function twoRefreshes(first: (init: RequestInit) => Promise<Response>) {
  await saveCredential("anthropic", { access: "old", refresh: "rt-old", expires: 1, accountId: "acct" });
  const id = getAccountSet("anthropic")!.activeAccountId;
  const credential = getAccountCredential("anthropic", id)!;
  let tokenRequests = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) === "https://api.anthropic.com/api/oauth/profile") return Response.json({ account: { uuid: "synthetic-account-a" } });
    expect(String(input)).toBe(TOKEN_URL);
    tokenRequests += 1;
    if (tokenRequests === 1) return first(init!);
    return Response.json({ access_token: "fresh", refresh_token: "rt-fresh", expires_in: 3600 });
  }) as typeof fetch;
  const refresh = () => refreshAnthropicAccountWithLock("anthropic", id, OAUTH_PROVIDERS.anthropic!, credential);
  const firstError = await refresh().then(() => undefined, error => error as Record<string, unknown>);
  const pendingAfterFirst = readOAuthRefreshIntent("anthropic", id);
  const second = await refresh().then(token => ({ token }), error => ({ error }));
  return { id, credential, firstError, pendingAfterFirst, second, tokenRequests: () => tokenRequests };
}

describe("a refused first connection stays retryable (#8577)", () => {
  test("Bun fetch through an HTTP proxy that is not listening", async () => {
    const proxy = `http://127.0.0.1:${await closedLoopbackPort()}`;
    // Real Bun transport; the destination is loopback too, so nothing can reach Anthropic.
    const run = await twoRefreshes(init => originalFetch(TOKEN_URL, { ...init, proxy } as RequestInit));
    expect(run.firstError).toMatchObject({ name: "AnthropicTokenError", requestNotSent: true });
    expect(run.pendingAfterFirst).toBeUndefined();
    expect(run.second).toEqual({ token: "fresh" });
    expect(run.tokenRequests()).toBe(2);
    expect(getAccountSet("anthropic")!.accounts[0]!.needsReauth).toBeUndefined();
  });

  test("the SOCKS5 transport when its proxy is not listening", async () => {
    const proxy = `socks5://127.0.0.1:${await closedLoopbackPort()}`;
    const run = await twoRefreshes(init => socks5Fetch(TOKEN_URL, init, proxy));
    expect(run.firstError).toMatchObject({ name: "AnthropicTokenError", requestNotSent: true });
    expect(run.pendingAfterFirst).toBeUndefined();
    expect(run.second).toEqual({ token: "fresh" });
  });

  const ambiguous: Array<[string, () => Promise<Response>]> = [
    ["a refusal reported for another URL", async () => { throw Object.assign(new TypeError("ECONNREFUSED"), { code: "ECONNREFUSED", path: "https://other.invalid/token", errno: 0 }); }],
    ["unstructured ECONNREFUSED text", async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:7892"); }],
    ["a node refusal outside connect", async () => { throw Object.assign(new Error("read ECONNREFUSED"), { code: "ECONNREFUSED", syscall: "read" }); }],
    ["a connection reset after dispatch", async () => { throw Object.assign(new TypeError("ECONNRESET"), { code: "ECONNRESET", path: TOKEN_URL, errno: 0 }); }],
  ];
  for (const [name, first] of ambiguous) test(`${name} keeps the replay guard`, async () => {
    const run = await twoRefreshes(first);
    expect(run.pendingAfterFirst).toMatchObject({ generation: credentialGeneration(run.credential) });
    expect((run.second as { error?: unknown }).error).toBeInstanceOf(OAuthLoginRequiredError);
    expect(run.tokenRequests()).toBe(1);
  });
});
