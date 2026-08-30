import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { AUTH_MATRIX } from "../src/server/auth-cors";
import { clearApiKeyUsageCacheForTests, rollupApiKeyUsage } from "../src/server/management/api-key-usage";
import { normalizeUsageEntryForTest, usageLogPath, type PersistedUsageEntry } from "../src/usage/log";
import type { OcxConfig } from "../src/types";

const ADMIN_TOKEN = "admin-secret-for-attribution";
const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";

function remoteConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: { adapter: "openai-chat", baseUrl: "https://example.test/v1", disabled: true, models: ["gpt-test"] },
    },
    apiKeys: [
      { id: "key-one", name: "one", key: "ocx_data_attributionone", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "key-two", name: "two", key: "ocx_data_attributiontwo", createdAt: "2026-07-31T00:00:00.000Z" },
    ],
  };
}

function usageRows(): PersistedUsageEntry[] {
  if (!existsSync(usageLogPath())) return [];
  return readFileSync(usageLogPath(), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line) as PersistedUsageEntry);
}

async function keysGet(server: { url: URL }): Promise<Record<string, unknown>> {
  const res = await fetch(new URL("/api/keys", server.url), {
    headers: { "x-opencodex-api-key": ADMIN_TOKEN },
  });
  return await res.json() as Record<string, unknown>;
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-attribution-"));
  process.env.OPENCODEX_HOME = testHome;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
  clearApiKeyUsageCacheForTests();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("attribution reaches usage.jsonl", () => {
  test("an authed request is attributed to the key that opened it, all the way to disk", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "ocx_data_attributiontwo" },
        body: JSON.stringify({ model: "test/gpt-test", messages: [{ role: "user", content: "hi" }] }),
      });

      // The round trip is the point. addRequestLog REBUILDS the persisted row
      // field by field, so a field that only reaches /api/logs would look correct
      // in memory and never land here — which is where the rollup reads from.
      const rows = usageRows();
      expect(rows.length).toBeGreaterThan(0);
      const row = rows.at(-1)!;
      expect(row.apiKeyId).toBe("key-two");
      expect(row.admissionKind).toBe("configured");
      expect(row.inboundProtocol).toBe("chat");
    } finally {
      await server.stop(true);
    }
  });

  test("the same request appears in the GET /api/keys rollup", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "ocx_data_attributionone" },
        body: JSON.stringify({ model: "test/gpt-test", messages: [{ role: "user", content: "hi" }] }),
      });

      const payload = await keysGet(server);
      const rows = payload.keys as Array<Record<string, unknown>>;
      const one = rows.find(r => r.id === "key-one")!;
      const two = rows.find(r => r.id === "key-two")!;
      expect((one.usage as Record<string, number>).totalRequests).toBeGreaterThan(0);
      expect((two.usage as Record<string, number>).totalRequests).toBe(0);
      expect(typeof payload.attributionSince).toBe("string");
    } finally {
      await server.stop(true);
    }
  });

  test("/v1/messages is attributed too", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      await fetch(new URL("/v1/messages", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "ocx_data_attributionone" },
        body: JSON.stringify({ model: "test/gpt-test", max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
      });
      const row = usageRows().at(-1);
      expect(row?.apiKeyId).toBe("key-one");
      expect(row?.inboundProtocol).toBe("messages");
    } finally {
      await server.stop(true);
    }
  });

  test("routes beyond the protocol trio are attributed as well", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      // Compact and images emit request logs too. Attribution that covers only
      // the three obvious protocols undercounts, and an undercount is worse than
      // no count when the number is used to decide whether a key is safe to delete.
      await fetch(new URL("/v1/responses/compact", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "ocx_data_attributionone" },
        body: JSON.stringify({ model: "test/gpt-test", input: "hi" }),
      });
      await fetch(new URL("/v1/images/generations", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "ocx_data_attributionone" },
        body: JSON.stringify({ model: "test/gpt-test", prompt: "hi" }),
      });
      const attributed = usageRows().filter(r => r.apiKeyId === "key-one");
      expect(attributed.length).toBeGreaterThanOrEqual(2);
      expect(attributed.every(r => r.admissionKind === "configured")).toBe(true);
      // Images carry no protocol from the closed set, and inventing one would
      // repeat the mistake `surface` already made.
      expect(attributed.some(r => r.inboundProtocol === undefined)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });

  test("a loopback bind records the admission kind and no key id", async () => {
    const config = remoteConfig();
    config.hostname = "127.0.0.1";
    saveConfig(config);
    const server = startServer(0);
    try {
      await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "test/gpt-test", messages: [{ role: "user", content: "hi" }] }),
      });
      const row = usageRows().at(-1);
      expect(row?.admissionKind).toBe("loopback");
      // Never a sentinel in the id field: a hand-edited entry named `loopback`
      // would otherwise absorb every unauthenticated request.
      expect(row?.apiKeyId).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("the environment token records its own kind", async () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "env-data-secret";
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "env-data-secret" },
        body: JSON.stringify({ model: "test/gpt-test", messages: [{ role: "user", content: "hi" }] }),
      });
      const row = usageRows().at(-1);
      expect(row?.admissionKind).toBe("environment");
      expect(row?.apiKeyId).toBeUndefined();
    } finally {
      await server.stop(true);
      delete process.env.OPENCODEX_API_AUTH_TOKEN;
    }
  });

  test("search and realtime call-create each add an attributed row", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      // The route is /v1/alpha/search — an invented path produces no row at all,
      // and an `every(...)` assertion over zero new rows passes vacuously. So
      // each request must be shown to ADD a row, and that row must carry the id.
      for (const path of ["/v1/alpha/search", "/v1/realtime/calls"]) {
        const before = usageRows().length;
        await fetch(new URL(path, server.url), {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencodex-api-key": "ocx_data_attributionone" },
          body: JSON.stringify({ model: "test/gpt-test", input: "hi", query: "hi" }),
        }).catch(() => undefined);
        const rows = usageRows();
        expect(rows.length).toBeGreaterThan(before);
        const added = rows.at(-1)!;
        expect(added.apiKeyId).toBe("key-one");
        expect(added.admissionKind).toBe("configured");
      }
    } finally {
      await server.stop(true);
    }
  });

  test("a Responses WS frame is attributed to the key that opened the socket", async () => {
    const config = remoteConfig();
    config.websockets = true;
    saveConfig(config);
    const server = startServer(0);
    try {
      const target = new URL("/v1/responses", server.url);
      target.protocol = "ws:";
      const before = usageRows().length;
      const settled = await new Promise<boolean>(resolve => {
        const socket = new WebSocket(target, {
          headers: { "X-OpenCodex-API-Key": "ocx_data_attributiontwo" },
        } as unknown as string[]);
        const done = (v: boolean) => { clearTimeout(timer); try { socket.close(); } catch { /* gone */ } resolve(v); };
        socket.addEventListener("open", () => {
          // Auth happened at the handshake; the frame path has no headers left,
          // so this is the only way to prove the admission survived into ws.data.
          socket.send(JSON.stringify({ type: "response.create", model: "test/gpt-test", input: "hi" }));
          setTimeout(() => done(true), 1500);
        });
        socket.addEventListener("error", () => done(false));
        const timer = setTimeout(() => done(false), 5_000);
      });
      expect(settled).toBe(true);
      const rows = usageRows();
      expect(rows.length).toBeGreaterThan(before);
      const added = rows.at(-1)!;
      expect(added.apiKeyId).toBe("key-two");
      expect(added.inboundProtocol).toBe("responses");
    } finally {
      await server.stop(true);
    }
  });

  test("the rollup cache cannot serve one config's numbers to another", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "ocx_data_attributionone" },
        body: JSON.stringify({ model: "test/gpt-test", messages: [{ role: "user", content: "hi" }] }),
      });
      const before = await keysGet(server);
      expect(((before.keys as Array<Record<string, unknown>>)[0]!.usage as Record<string, number>).totalRequests).toBeGreaterThan(0);

      // Deleting a key changes the configured-id set. A cache keyed only on the
      // usage-log revision would hand back the previous shape.
      const created = (before.keys as Array<Record<string, unknown>>)[1]!;
      await fetch(new URL("/api/keys", server.url), {
        method: "DELETE",
        headers: { "content-type": "application/json", "x-opencodex-api-key": ADMIN_TOKEN },
        body: JSON.stringify({ id: created.id }),
      });
      const after = await keysGet(server);
      const rows = after.keys as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows.map(r => r.id)).not.toContain(created.id);
    } finally {
      await server.stop(true);
    }
  });

  test("an unreadable usage snapshot degrades to zeroes, not a failed route", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      // A directory where the log should be: the read throws, and key management
      // must still answer. Usage numbers are worth less than the ability to
      // revoke a key.
      mkdirSync(usageLogPath(), { recursive: true });
      const payload = await keysGet(server);
      const rows = payload.keys as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);
      expect((rows[0]!.usage as Record<string, number>).totalRequests).toBe(0);
      expect(payload.attributionSince).toBeUndefined();
    } finally {
      await server.stop(true);
    }
  });

  test("a long key id survives the round trip intact", async () => {
    const config = remoteConfig();
    const longId = "k".repeat(80);
    config.apiKeys = [{ id: longId, name: "long", key: "ocx_data_longid", createdAt: "2026-07-31T00:00:00.000Z" }];
    saveConfig(config);
    const server = startServer(0);
    try {
      await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: { "content-type": "application/json", "x-opencodex-api-key": "ocx_data_longid" },
        body: JSON.stringify({ model: "test/gpt-test", messages: [{ role: "user", content: "hi" }] }),
      });
      // The metadata cap would truncate this to 64 characters, and the rollup
      // looks up the configured id — so a live key would report zero usage.
      expect(usageRows().at(-1)?.apiKeyId).toBe(longId);
      const payload = await keysGet(server);
      const rows = payload.keys as Array<Record<string, unknown>>;
      expect((rows[0]!.usage as Record<string, number>).totalRequests).toBeGreaterThan(0);
    } finally {
      await server.stop(true);
    }
  });

  test("Responses and Chat Completions are distinguishable where surface is not", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      for (const [path, body] of [
        ["/v1/responses", { model: "test/gpt-test", input: "hi" }],
        ["/v1/chat/completions", { model: "test/gpt-test", messages: [{ role: "user", content: "hi" }] }],
      ] as const) {
        await fetch(new URL(path, server.url), {
          method: "POST",
          headers: { "content-type": "application/json", "x-opencodex-api-key": "ocx_data_attributionone" },
          body: JSON.stringify(body),
        });
      }
      const protocols = usageRows().map(r => r.inboundProtocol);
      expect(protocols).toContain("responses");
      expect(protocols).toContain("chat");
      // Both leave `surface` unset, which is exactly why widening that enum
      // could not have separated them.
      expect(usageRows().every(r => r.surface === undefined)).toBe(true);
    } finally {
      await server.stop(true);
    }
  });
});

describe("rollupApiKeyUsage", () => {
  const at = (iso: string): number => new Date(iso).getTime();
  const now = at("2026-07-31T00:00:00.000Z");

  function row(over: Partial<PersistedUsageEntry>): PersistedUsageEntry {
    return {
      requestId: "r", timestamp: now, provider: "p", model: "m",
      status: 200, durationMs: 1, usageStatus: "exact",
      ...over,
    } as PersistedUsageEntry;
  }

  test("counts the seven-day window at exactly its cutoff", () => {
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    const { rollup } = rollupApiKeyUsage([
      row({ timestamp: now - 1000, admissionKind: "configured", apiKeyId: "k" }),
      // Exactly the cutoff, not cutoff+1s: the boundary is where an off-by-one lives.
      row({ timestamp: cutoff, admissionKind: "configured", apiKeyId: "k" }),
      row({ timestamp: cutoff - 1, admissionKind: "configured", apiKeyId: "k" }),
    ], ["k"], now);
    const usage = rollup.get("k") as { requests7d: number; totalRequests: number; lastUsedAt: string };
    expect(usage.requests7d).toBe(2);
    expect(usage.totalRequests).toBe(3);
    expect(usage.lastUsedAt).toBe(new Date(now - 1000).toISOString());
  });

  test("one unusable timestamp cannot void the whole rollup", () => {
    // usage.jsonl is hand-editable and JSON allows numbers outside the Date
    // range. `new Date(1e309).toISOString()` throws, and the caller catches to
    // protect key management — so this used to report every key as unused.
    const { rollup, attributionSince } = rollupApiKeyUsage([
      row({ timestamp: 1e309 as number, admissionKind: "configured", apiKeyId: "k" }),
      row({ timestamp: now - 1000, admissionKind: "configured", apiKeyId: "k" }),
    ], ["k"], now);
    const usage = rollup.get("k") as { requests7d: number; totalRequests: number; lastUsedAt: string };
    // The request still happened; only its time-based fields are unusable.
    expect(usage.totalRequests).toBe(2);
    expect(usage.requests7d).toBe(1);
    expect(usage.lastUsedAt).toBe(new Date(now - 1000).toISOString());
    expect(attributionSince).toBe(new Date(now - 1000).toISOString());
  });

  test("a colliding id cannot absorb loopback traffic", () => {
    // A hand-edited entry literally named `loopback`. Keying on apiKeyId alone
    // would hand it every unauthenticated loopback request.
    const { rollup } = rollupApiKeyUsage([
      row({ admissionKind: "loopback" }),
      row({ admissionKind: "environment" }),
    ], ["loopback"], now);
    expect(rollup.get("loopback")).toEqual({ requests7d: 0, totalRequests: 0 });
  });

  test("duplicate configured ids report ambiguity instead of a shared total", () => {
    const { rollup } = rollupApiKeyUsage([
      row({ admissionKind: "configured", apiKeyId: "same" }),
    ], ["same", "same"], now);
    expect(rollup.get("same")).toEqual({ ambiguous: true });
  });

  test("attributionSince is the earliest recognized admission, not the earliest configured key", () => {
    const { attributionSince } = rollupApiKeyUsage([
      row({ timestamp: at("2026-07-20T00:00:00.000Z"), admissionKind: "environment" }),
      row({ timestamp: at("2026-07-25T00:00:00.000Z"), admissionKind: "configured", apiKeyId: "k" }),
      row({ timestamp: at("2026-07-01T00:00:00.000Z") }), // pre-attribution row
    ], ["k"], now);
    expect(attributionSince).toBe("2026-07-20T00:00:00.000Z");
  });

  test("no attributable row means no attributionSince at all", () => {
    const { attributionSince } = rollupApiKeyUsage([row({})], ["k"], now);
    expect(attributionSince).toBeUndefined();
  });
});

describe("durable compatibility", () => {
  test("a pre-attribution row parses unchanged", () => {
    const before = {
      requestId: "r", timestamp: 1, provider: "p", model: "m",
      status: 200, durationMs: 1, usageStatus: "exact",
    } as PersistedUsageEntry;
    const after = normalizeUsageEntryForTest(before);
    expect(after.apiKeyId).toBeUndefined();
    expect(after.admissionKind).toBeUndefined();
    expect(after.inboundProtocol).toBeUndefined();
    expect(after.requestId).toBe("r");
  });

  test("an unknown enum value drops the field rather than poisoning it", () => {
    const after = normalizeUsageEntryForTest({
      requestId: "r", timestamp: 1, provider: "p", model: "m",
      status: 200, durationMs: 1, usageStatus: "exact",
      admissionKind: "garbage",
      inboundProtocol: "garbage",
      apiKeyId: "kept",
    } as unknown as PersistedUsageEntry);
    expect(after.admissionKind).toBeUndefined();
    expect(after.inboundProtocol).toBeUndefined();
    expect(after.apiKeyId).toBe("kept");
  });
});

describe("AUTH_MATRIX is true of the running server", () => {
  test("every cell matches a real request", async () => {
    saveConfig(remoteConfig());
    const server = startServer(0);
    const key = "ocx_data_attributionone";
    try {
      for (const row of AUTH_MATRIX) {
        const cases: Array<[string, Record<string, string>]> = [
          [row.bearer, { authorization: `Bearer ${key}` }],
          [row.dedicated, { "x-opencodex-api-key": key }],
          [row.xApiKey, { "x-api-key": key }],
        ];
        for (const [disposition, headers] of cases) {
          // Read-only endpoints must be exercised with GET: sending POST would draw a 405
          // from routing and the assertions below would be testing the method guard rather
          // than admission. /v1/catalog joined this set in #809.
          const isGet = row.endpoint === "/v1/models" || row.endpoint === "/v1/catalog";
          const res = await fetch(new URL(row.endpoint, server.url), {
            method: isGet ? "GET" : "POST",
            headers: { "content-type": "application/json", ...headers },
            ...(isGet ? {} : { body: JSON.stringify({ model: "test/gpt-test", input: "hi", messages: [{ role: "user", content: "hi" }] }) }),
          });
          // A 401 means the header was refused; anything else means it got past
          // admission (the upstream is disabled, so later failures are expected).
          // 401 means the header was refused at admission; anything else got
          // past it. A bare `!== 401` would also accept a route that no longer
          // exists, so pin the negative side too: a rejected cell must be a 401
          // specifically, not any old error, and an accepted cell must not be a
          // routing 405. (404 is NOT disqualifying here — the fixture provider is
          // disabled, so an admitted request legitimately fails downstream with
          // "no such model", which is proof admission let it through.)
          expect(res.status).not.toBe(405);
          if (disposition === "rejected") expect(res.status).toBe(401);
          if (res.status === 404) {
            // The fixture provider is disabled, so an ADMITTED request can still
            // 404 downstream on "no such model" — that is proof admission let it
            // through. A vanished ROUTE also 404s, and would let every accepted
            // cell pass vacuously, so the two are told apart by their code.
            const body = await res.clone().json().catch(() => ({})) as { error?: { code?: string } };
            expect(body.error?.code).not.toBe("not_found");
            // /v1/catalog has its own honest 404 (no materialized catalog in this fixture),
            // which is admission proof rather than a missing route. Pin the distinguishing
            // code so a deleted route still cannot pass here.
            if (row.endpoint === "/v1/catalog") expect(body.error?.code).toBe("catalog_not_found");
          }
          const admitted = res.status !== 401;
          expect({ endpoint: row.endpoint, headers: Object.keys(headers)[0], admitted })
            .toEqual({ endpoint: row.endpoint, headers: Object.keys(headers)[0], admitted: disposition !== "rejected" });
        }
      }
    } finally {
      await server.stop(true);
    }
  });
});
