import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidAccessToken } from "../src/oauth";
import { getCredential, saveCredential } from "../src/oauth/store";

const origHome = process.env.HOME;
const origOcxHome = process.env.OPENCODEX_HOME;
const origRegion = process.env.KIRO_REGION;
const origFetch = globalThis.fetch;
const origWarn = console.warn;
let tmp: string;

beforeEach(() => {
  tmp = join(tmpdir(), `oauth-refresh-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(tmp, { recursive: true });
  process.env.HOME = tmp;
  process.env.OPENCODEX_HOME = join(tmp, "ocx");
  process.env.KIRO_REGION = "us-east-1";
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  if (origOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = origOcxHome;
  if (origRegion === undefined) delete process.env.KIRO_REGION; else process.env.KIRO_REGION = origRegion;
  globalThis.fetch = origFetch;
  console.warn = origWarn;
  rmSync(tmp, { recursive: true, force: true });
});

function seedKiroCliDb(token: { access_token: string; refresh_token?: string; expires_at?: string }) {
  const dir = join(tmp, "Library", "Application Support", "kiro-cli");
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "data.sqlite3"));
  db.run("CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)");
  db.run("INSERT INTO auth_kv (key, value) VALUES (?, ?)", ["kirocli:social:token", JSON.stringify(token)]);
  db.close();
}

function seedGrokAuth(token: {
  key: string;
  refresh_token: string;
  expires_at: string;
  user_id?: string;
  email?: string;
}) {
  const dir = join(tmp, ".grok");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ "https://auth.x.ai::test": token }));
}

function xaiRefreshResponses(access = "xai-fresh", refresh = "rt-fresh"): Response[] {
  return [
    new Response(JSON.stringify({
      authorization_endpoint: "https://auth.x.ai/authorize",
      token_endpoint: "https://auth.x.ai/token",
    }), { status: 200 }),
    new Response(JSON.stringify({ access_token: access, refresh_token: refresh, expires_in: 3600 }), { status: 200 }),
  ];
}

function mockXaiRefreshFetch(access = "xai-fresh", refresh = "rt-fresh") {
  let discoveryCalls = 0;
  let tokenCalls = 0;
  const tokenBodies: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === "POST") {
      tokenCalls++;
      tokenBodies.push(String(init.body));
      return xaiRefreshResponses(access, refresh)[1]!;
    }
    discoveryCalls++;
    return xaiRefreshResponses(access, refresh)[0]!;
  }) as typeof fetch;
  return {
    discoveryCount: () => discoveryCalls,
    tokenCount: () => tokenCalls,
    tokenBodies,
  };
}

function mockRefreshFetch(responses: Array<Response | Error>): { count: () => number } {
  let calls = 0;
  let i = 0;
  globalThis.fetch = (async () => {
    calls++;
    const next = responses[i++] ?? responses[responses.length - 1];
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { count: () => calls };
}

describe("oauth refresh hardening", () => {
  test("valid stored credential returns without refresh", async () => {
    const mock = mockRefreshFetch([new Response("unexpected", { status: 500 })]);
    await saveCredential("kiro", { access: "aoa-valid", refresh: "rt", expires: Date.now() + 3600_000 });
    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-valid");
    expect(mock.count()).toBe(0);
  });

  test("concurrent expired Kiro refreshes share one request", async () => {
    const mock = mockRefreshFetch([
      new Response(JSON.stringify({ accessToken: "aoa-fresh", refreshToken: "rt-fresh", expiresIn: 3600 }), { status: 200 }),
    ]);
    await saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1 });
    const [a, b] = await Promise.all([getValidAccessToken("kiro"), getValidAccessToken("kiro")]);
    expect(a).toBe("aoa-fresh");
    expect(b).toBe("aoa-fresh");
    expect(mock.count()).toBe(1);
    expect(getCredential("kiro")?.refresh).toBe("rt-fresh");
  });

  test("fresh Kiro CLI SQLite token is imported before refresh endpoint", async () => {
    const mock = mockRefreshFetch([new Response("unexpected", { status: 500 })]);
    seedKiroCliDb({ access_token: "aoa-sqlite", refresh_token: "rt-sqlite", expires_at: "2099-01-01T00:00:00Z" });
    await saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1 });
    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-sqlite");
    expect(mock.count()).toBe(0);
    expect(getCredential("kiro")?.refresh).toBe("rt-sqlite");
    expect(getCredential("kiro")?.source).toBe("local-cli");
  });

  test("failed refresh recovers from a now-fresh Kiro CLI SQLite token", async () => {
    await saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1 });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      seedKiroCliDb({ access_token: "aoa-recovered", refresh_token: "rt-recovered", expires_at: "2099-01-01T00:00:00Z" });
      throw new Error("network down");
    }) as typeof fetch;

    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-recovered");
    expect(calls).toBe(1);
    expect(getCredential("kiro")?.refresh).toBe("rt-recovered");
    expect(getCredential("kiro")?.source).toBe("local-cli");
  });

  test("refresh preserves existing credential source metadata", async () => {
    mockRefreshFetch([
      new Response(JSON.stringify({ accessToken: "aoa-fresh", refreshToken: "rt-fresh", expiresIn: 3600 }), { status: 200 }),
    ]);
    await saveCredential("kiro", { access: "aoa-old", refresh: "rt-old", expires: Date.now() - 1, source: "manual" });

    await expect(getValidAccessToken("kiro")).resolves.toBe("aoa-fresh");
    expect(getCredential("kiro")?.source).toBe("manual");
  });

  test("newer Grok generation is adopted before xAI refresh with zero endpoint calls", async () => {
    const mock = mockRefreshFetch([new Response("unexpected", { status: 500 })]);
    await saveCredential("xai", {
      access: "xai-old", refresh: "rt-old", expires: Date.now() - 1, accountId: "user-1", source: "local-cli",
    });
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-new", expires_at: new Date(Date.now() + 3600_000).toISOString(), user_id: "user-1",
    });

    await expect(getValidAccessToken("xai")).resolves.toBe("xai-disk");
    expect(mock.count()).toBe(0);
    expect(getCredential("xai")?.refresh).toBe("rt-new");
    expect(getCredential("xai")?.source).toBe("local-cli");
  });

  test("newer-expiry Grok access token is adopted when refresh generation is unchanged", async () => {
    const mock = mockRefreshFetch([new Response("unexpected", { status: 500 })]);
    await saveCredential("xai", {
      access: "xai-old", refresh: "rt-same", expires: Date.now() - 1, accountId: "user-1", source: "local-cli",
    });
    const diskExpires = Date.now() + 3600_000;
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-same", expires_at: new Date(diskExpires).toISOString(), user_id: "user-1",
    });

    await expect(getValidAccessToken("xai")).resolves.toBe("xai-disk");
    expect(mock.count()).toBe(0);
    expect(getCredential("xai")?.expires).toBe(diskExpires);
  });

  test("stale Grok generation refreshes once and detaches to OpenCodex ownership", async () => {
    await saveCredential("xai", {
      access: "xai-old", refresh: "rt-old", expires: Date.now() - 1, accountId: "user-1", source: "local-cli",
    });
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-old", expires_at: new Date(Date.now() - 2_000).toISOString(), user_id: "user-1",
    });
    const grokPath = join(tmp, ".grok", "auth.json");
    const before = readFileSync(grokPath);
    const mock = mockXaiRefreshFetch();
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args); };
    try {
      await expect(getValidAccessToken("xai")).resolves.toBe("xai-fresh");
    } finally {
      console.warn = originalWarn;
    }

    expect(mock.discoveryCount()).toBe(1);
    expect(mock.tokenCount()).toBe(1);
    expect(warnings).toEqual([[
      "[oauth:xai] Grok CLI credential was stale; refreshed into OpenCodex ownership. Grok CLI may require login again.",
    ]]);
    expect(getCredential("xai")?.refresh).toBe("rt-fresh");
    expect(getCredential("xai")?.source).toBe("oauth");
    expect(readFileSync(grokPath)).toEqual(before);
  });

  test("stale different Grok generation with earlier expiry is not adopted", async () => {
    const storedExpiry = Date.now() - 1;
    await saveCredential("xai", {
      access: "xai-ours", refresh: "rt-ours", expires: storedExpiry, accountId: "user-1", source: "local-cli",
    });
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-disk", expires_at: new Date(storedExpiry - 10_000).toISOString(), user_id: "user-1",
    });
    const mock = mockXaiRefreshFetch();

    await expect(getValidAccessToken("xai")).resolves.toBe("xai-fresh");
    expect(mock.discoveryCount()).toBe(1);
    expect(mock.tokenCount()).toBe(1);
    expect(new URLSearchParams(mock.tokenBodies[0]).get("refresh_token")).toBe("rt-ours");
    expect(getCredential("xai")?.source).toBe("oauth");
  });

  test("mismatched Grok identity is not adopted into a local-cli account", async () => {
    await saveCredential("xai", {
      access: "xai-ours", refresh: "rt-ours", expires: Date.now() - 1, accountId: "user-1", source: "local-cli",
    });
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-disk", expires_at: new Date(Date.now() + 3600_000).toISOString(), user_id: "user-2",
    });
    const mock = mockXaiRefreshFetch();

    await expect(getValidAccessToken("xai")).resolves.toBe("xai-fresh");
    expect(mock.discoveryCount()).toBe(1);
    expect(mock.tokenCount()).toBe(1);
    expect(new URLSearchParams(mock.tokenBodies[0]).get("refresh_token")).toBe("rt-ours");
    expect(getCredential("xai")?.accountId).toBe("user-1");
    expect(getCredential("xai")?.source).toBe("oauth");
  });

  test("concurrent xAI local-cli refreshes share reconciliation and one detach exchange", async () => {
    await saveCredential("xai", {
      access: "xai-old", refresh: "rt-old", expires: Date.now() - 1, accountId: "user-1", source: "local-cli",
    });
    seedGrokAuth({
      key: "xai-disk", refresh_token: "rt-old", expires_at: new Date(Date.now() - 2_000).toISOString(), user_id: "user-1",
    });
    const mock = mockXaiRefreshFetch();

    const [a, b] = await Promise.all([getValidAccessToken("xai"), getValidAccessToken("xai")]);
    expect(a).toBe("xai-fresh");
    expect(b).toBe("xai-fresh");
    expect(mock.discoveryCount()).toBe(1);
    expect(mock.tokenCount()).toBe(1);
    expect(getCredential("xai")?.source).toBe("oauth");
  });
});
