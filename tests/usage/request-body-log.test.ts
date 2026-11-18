import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { startServer } from "../../src/server";
import { observeRequestLogsForTests, requestLogEntryFromPersistedUsage, type RequestLogEntry } from "../../src/server/request-log";
import { normalizePersistedUsageRow, readRecentUsageEntries } from "../../src/usage/log";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { relayLinkDataRequest, HOME_INITIATED_LINK_TUNNEL } from "../../src/client/link-relay";
import { compressLinkBody } from "../../src/client/link-request-compression";
import { forgetLinkHomeFeaturesForTests } from "../../src/client/link-home-features";
import { createLinkRelaySessions } from "../../src/server/index/link-relay-sessions";
import { LINK_REQUEST_ZSTD_FEATURE } from "../../src/link/request-compression";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";

const TEST_DIR = join(import.meta.dir, ".tmp-request-body-log-test");
let isolatedCodexHome: IsolatedCodexHome | null = null;
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
  mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolatedCodexHome = installIsolatedCodexHome("ocx-request-body-log-codex-");
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (existsSync(TEST_DIR)) removeTreeWithRetry(TEST_DIR);
});

const body = JSON.stringify({ model: "no-such-provider/no-such-model", input: "hello ".repeat(400), stream: false });
const plain = new TextEncoder().encode(body);

describe("request log rows carry the request body as received (#3023)", () => {
  test("a body a Child compressed for its Home is logged with its wire size, zstd, and its decoded size", async () => {
    const key = `ocx_data_${"a".repeat(40)}`, keyId = "test-link-key", linkId = "lnk_0123456789abcdef";
    const rows: RequestLogEntry[] = [];
    const stop = observeRequestLogsForTests(row => { rows.push(row); });
    const server = startServer(0);
    // The Home's hub-link session hands each verified request, bytes and headers as sent, to the real data plane.
    const sessions = createLinkRelaySessions({ fingerprints: () => [serviceApiTokenFingerprint(key)], homeFeatures: () => [LINK_REQUEST_ZSTD_FEATURE] });
    const link = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (req, s) => sessions.dispatch(req, s, async inner =>
      fetch(`http://127.0.0.1:${server.port}${new URL(inner.url).pathname}`, { method: "POST", headers: inner.headers, body: await inner.arrayBuffer() })) });
    forgetLinkHomeFeaturesForTests();
    try {
      for (let i = 0; i < 2; i++) {
        const response = await relayLinkDataRequest(new Request("http://127.0.0.1/v1/responses", { method: "POST", body: plain,
          headers: { "content-type": "application/json", "content-length": String(plain.byteLength) } }),
        { tunnelPort: link.port!, admissionKey: key, apiKeyId: keyId, linkId }, { tunnel: HOME_INITIATED_LINK_TUNNEL });
        await response.text();
      }
    } finally {
      await link.stop(true);
      await server.stop(true);
      stop();
      forgetLinkHomeFeaturesForTests();
    }
    const compressed = await compressLinkBody(plain);
    expect(compressed).not.toBeNull();
    // The first body goes before the Child has heard its Home; the second is compressed.
    expect(rows.map(row => row.requestBody)).toEqual([
      { wireBytes: plain.byteLength, encoding: "identity", decodedBytes: plain.byteLength },
      { wireBytes: compressed!.byteLength, encoding: "zstd", decodedBytes: plain.byteLength },
    ]);
  });

  test("identity, zstd and gzip bodies through the real data plane", async () => {
    const rows: RequestLogEntry[] = [];
    const stop = observeRequestLogsForTests(row => { rows.push(row); });
    const server = startServer(0);
    try {
      const cases = [
        { encoding: "identity", wire: plain, header: undefined },
        { encoding: "zstd", wire: zstdCompressSync(plain), header: "zstd" },
        { encoding: "gzip", wire: gzipSync(plain), header: "gzip" },
      ] as const;
      for (const item of cases) {
        const response = await fetch(`http://127.0.0.1:${server.port}/v1/responses`, {
          method: "POST", body: item.wire,
          headers: { "content-type": "application/json", ...(item.header ? { "content-encoding": item.header } : {}) },
        });
        await response.text();
      }
    } finally {
      await server.stop(true);
      stop();
    }
    const logged = rows.filter(row => row.requestBody !== undefined).map(row => row.requestBody);
    expect(logged).toEqual([
      { wireBytes: plain.byteLength, encoding: "identity", decodedBytes: plain.byteLength },
      { wireBytes: zstdCompressSync(plain).byteLength, encoding: "zstd", decodedBytes: plain.byteLength },
      { wireBytes: gzipSync(plain).byteLength, encoding: "gzip", decodedBytes: plain.byteLength },
    ]);
    expect(rows).toHaveLength(3);
    // The same facts reach usage.jsonl and come back on hydration.
    const persisted = readRecentUsageEntries(10).map(entry => entry.requestBody);
    expect(persisted).toEqual(logged);
    expect(requestLogEntryFromPersistedUsage(readRecentUsageEntries(10)[1]!).requestBody).toEqual(logged[1]);
    const line = readFileSync(join(TEST_DIR, "usage.jsonl"), "utf8").trim().split("\n")[2]!;
    expect(JSON.parse(line).requestBody).toEqual(logged[2]);
  });

  test("Chat Completions and Messages rows carry it too", async () => {
    const rows: RequestLogEntry[] = [];
    const stop = observeRequestLogsForTests(row => { rows.push(row); });
    const server = startServer(0);
    const wire = zstdCompressSync(plain);
    try {
      for (const path of ["/v1/chat/completions", "/v1/messages"]) {
        const response = await fetch(`http://127.0.0.1:${server.port}${path}`, {
          method: "POST", body: wire,
          headers: { "content-type": "application/json", "content-encoding": "zstd", "session_id": "conversation-1" },
        });
        await response.text();
      }
    } finally {
      await server.stop(true);
      stop();
    }
    expect(rows.map(row => [row.inboundProtocol, row.requestBody])).toEqual([
      ["chat", { wireBytes: wire.byteLength, encoding: "zstd", decodedBytes: plain.byteLength }],
      ["messages", { wireBytes: wire.byteLength, encoding: "zstd", decodedBytes: plain.byteLength }],
    ]);
  });

  test("a reader drops what it does not know and keeps the row", () => {
    const row = { requestId: "ocx-1", timestamp: 1_762_000_000_000, provider: "p", model: "m", status: 200, durationMs: 5, usageStatus: "missing" };
    // An older reader rebuilds rows from the fields it knows, so a new field cannot cost it the row.
    const future = normalizePersistedUsageRow({ ...row, requestBody: { wireBytes: 10, encoding: "zstd", decodedBytes: 30 }, fieldFromTheFuture: { x: 1 } });
    expect(future).toMatchObject(row);
    expect(future).not.toHaveProperty("fieldFromTheFuture");
    expect(future?.requestBody).toEqual({ wireBytes: 10, encoding: "zstd", decodedBytes: 30 });
    for (const bad of [{ wireBytes: -1, encoding: "zstd", decodedBytes: 1 }, { wireBytes: 1, encoding: "br", decodedBytes: 1 }, "10 bytes", { wireBytes: 1.5, encoding: "identity", decodedBytes: 1 }]) {
      const parsed = normalizePersistedUsageRow({ ...row, requestBody: bad });
      expect(parsed).toMatchObject(row);
      expect(parsed).not.toHaveProperty("requestBody");
    }
  });
});
