import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcxConfig } from "../../src/types";
import { setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import { observeRequestLogsForTests, type RequestLogContext, type RequestLogEntry } from "../../src/server/request-log";
import { handleResponses } from "../../src/server/responses";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { createTempHome } from "../helpers/temp-home";
import { runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import { linkLogField } from "../../src/usage/link-log-fields";
import { normalizeUsageEntryForTest, type PersistedUsageEntry } from "../../src/usage/log";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkStore } from "../../src/link/store";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { LinkWireClient, frameType } from "../helpers/link-ws-client";
import { failLinkTurnExpansion, markLinkTurnMissing, observeLinkTurnExpansion, type LinkTurnLogFields } from "../../src/server/link-turn";

// Lane T5e1: the request-log fields of design 9.1 (transport, continuation, threadRef, turnRef), written only for
// link traffic while the link WebSocket feature is on.

const HEX64 = /^[0-9a-f]{64}$/;

describe("linkLogField (persisted shape)", () => {
  test("keeps a valid object and drops anything else", () => {
    const ok = { transport: "websocket", continuation: "full", continuationReason: "first", threadRef: "a".repeat(64), turnRef: "b".repeat(64) };
    expect(linkLogField(ok)).toEqual({ link: ok });
    expect(linkLogField({ transport: "http", continuation: "chained" })).toEqual({ link: { transport: "http", continuation: "chained" } });
    for (const bad of [undefined, null, "x", { transport: "smoke", continuation: "full" }, { transport: "http", continuation: "later" },
      { transport: "http", continuation: "miss", continuationReason: "because" }, { transport: "http", continuation: "full", threadRef: "raw-thread-id" }]) {
      expect(linkLogField(bad)).toEqual({});
    }
    // Unknown keys are dropped, never persisted.
    expect(linkLogField({ transport: "http", continuation: "full", continuationReason: "client", extra: 1 })).toEqual({ link: { transport: "http", continuation: "full", continuationReason: "client" } });
  });

  test("survives usage-log normalization; a row without it stays without it", () => {
    const base = { requestId: "r1", timestamp: 1, provider: "p", model: "m", client: "codex", status: 200 } as unknown as PersistedUsageEntry;
    const link = { transport: "http" as const, continuation: "miss" as const, continuationReason: "missing" as const };
    expect(normalizeUsageEntryForTest({ ...base, link } as PersistedUsageEntry).link).toEqual(link);
    expect(normalizeUsageEntryForTest(base)).not.toHaveProperty("link");
  });
});

describe("through a real Home", () => {
  const KEY_ID = "lf-home"; const KEY = "lf-home-secret-0123456789"; const LINK = "lnk_3434343434343434";
  const identity = { keyId: KEY_ID, linkId: LINK, fingerprint: serviceApiTokenFingerprint(KEY) };
  const previous = { home: process.env.OPENCODEX_HOME };
  let dir = "";
  let codexHome: IsolatedCodexHome | null = null;
  let server: { stop(force?: boolean): Promise<void> } | null = null;
  let upstream: ReturnType<typeof Bun.serve> | null = null;
  let stopObserving: (() => void) | null = null;
  const clients: LinkWireClient[] = [];
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "ocx-link-logfields-")); });
  afterEach(async () => {
    setLinkWebsocketTransportReadyForTests(false);
    stopObserving?.(); stopObserving = null;
    for (const c of clients.splice(0)) c.destroy();
    if (server) await server.stop(true);
    server = null;
    if (upstream) await upstream.stop(true);
    upstream = null;
    codexHome?.restore(); codexHome = null;
    if (previous.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous.home;
    removeTreeWithRetry(dir);
  });

  async function home(options: { featureOn: boolean; stateless?: boolean }) {
    setLinkWebsocketTransportReadyForTests(options.featureOn);
    process.env.OPENCODEX_HOME = dir;
    codexHome = installIsolatedCodexHome("ocx-link-logfields-codex-");
    writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture/fixture" }] }));
    upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
      await req.text();
      return new Response('event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n', { headers: { "content-type": "text/event-stream" } });
    } });
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links: [{ id: LINK, alias: "lf", direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 2222, apiKeyId: KEY_ID, createdAt: "2026-11-12T00:00:00.000Z" }] as LinkStore["links"] });
    const { saveConfig } = await import("../../src/config");
    saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", websockets: true, linkResponsesWebsocket: options.featureOn, codexAutoStart: false, clientIntegrations: { codex: false },
      providers: { fixture: { adapter: "openai-responses", baseUrl: "http://127.0.0.1:" + upstream.port + "/v1", authMode: "key", apiKey: "fixture-upstream-key", allowPrivateNetwork: true, models: ["fixture"], ...(options.stateless ? { statelessResponses: true } : {}) } },
      apiKeys: [{ id: KEY_ID, name: KEY_ID, key: KEY, createdAt: "2026-11-12T00:00:00.000Z" }] } as OcxConfig);
    const { startServer } = await import("../../src/server");
    server = startServer(0);
    const rows: RequestLogEntry[] = [];
    const waiters: Array<() => void> = [];
    stopObserving = observeRequestLogsForTests(entry => { rows.push(entry); waiters.splice(0).forEach(wake => wake()); });
    const nextRow = (): Promise<RequestLogEntry> => new Promise(resolve => {
      const count = rows.length;
      const check = () => { if (rows.length > count) resolve(rows[count]!); else waiters.push(check); };
      check();
    });
    const port = JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
    return { port, rows, nextRow };
  }

  const request = (extra: Record<string, unknown> = {}) => ({ model: "fixture/fixture", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    client_metadata: { turn_id: "turn-1" }, stream: true, ...extra });

  async function relayHttp(port: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    const http = await LinkWireClient.open(port);
    clients.push(http);
    const session = await http.challenge(identity);
    http.sendRequest("POST /v1/responses HTTP/1.1", { host: "127.0.0.1", "content-type": "application/json", authorization: "Bearer " + KEY, "x-opencodex-link-session": session.nonce, "thread-id": "thread-lf", ...headers }, JSON.stringify(body));
    return (await http.readHead()).status;
  }

  test("a link WebSocket turn: websocket, full (first), then full (client), with HMAC refs that are not the raw ids", async () => {
    const h = await home({ featureOn: true });
    const ws = await LinkWireClient.open(h.port);
    clients.push(ws);
    const session = await ws.challenge(identity);
    expect((await ws.upgrade({ nonce: session.nonce, bearer: KEY, headers: { "thread-id": "thread-lf" } })).status).toBe(101);
    const first = h.nextRow();
    ws.sendJson({ type: "response.create", ...request() });
    expect(frameType(await ws.nextMessage())).toBe("response.completed");
    const row1 = await first;
    expect(row1.link).toMatchObject({ transport: "websocket", continuation: "full", continuationReason: "first" });
    expect(row1.link!.threadRef).toMatch(HEX64);
    expect(row1.link!.turnRef).toMatch(HEX64);
    expect(JSON.stringify(row1)).not.toContain("thread-lf");
    expect(JSON.stringify(row1)).not.toContain("turn-1");
    const second = h.nextRow();
    ws.sendJson({ type: "response.create", ...request({ client_metadata: { turn_id: "turn-2" } }) });
    expect(frameType(await ws.nextMessage())).toBe("response.completed");
    const row2 = await second;
    expect(row2.link).toMatchObject({ transport: "websocket", continuation: "full", continuationReason: "client", threadRef: row1.link!.threadRef });
    expect(row2.link!.turnRef).not.toBe(row1.link!.turnRef);
  });

  test("a relayed HTTP turn: http, full (client), refs from the thread-id header and turn id", async () => {
    const h = await home({ featureOn: true });
    const row = h.nextRow();
    expect(await relayHttp(h.port, request())).toBe(200);
    const entry = await row;
    expect(entry.link).toMatchObject({ transport: "http", continuation: "full", continuationReason: "client" });
    expect(entry.link!.threadRef).toMatch(HEX64);
    expect(entry.link!.turnRef).toMatch(HEX64);
  });

  test("an unexpanded continuation the Home refuses is a miss with reason missing", async () => {
    const h = await home({ featureOn: true, stateless: true });
    const row = h.nextRow();
    expect(await relayHttp(h.port, request({ previous_response_id: "resp_unknown" }))).toBe(400);
    expect((await row).link).toMatchObject({ transport: "http", continuation: "miss", continuationReason: "missing" });
  });

  test("with the feature off, a relayed HTTP row carries no link field", async () => {
    const h = await home({ featureOn: false });
    const row = h.nextRow();
    expect(await relayHttp(h.port, request())).toBe(200);
    expect(await row).not.toHaveProperty("link");
  });
});
describe("the seam (src/server/link-turn.ts)", () => {
  const observer = (fields: LinkTurnLogFields | null | undefined) => ({ expanded() {}, expansionFailed() {}, terminal() {},
    ...(fields === undefined ? {} : { logFields: () => fields }) });
  const req = () => new Request("http://127.0.0.1/v1/responses", { method: "POST" });
  const ws = { transport: "websocket" as const, first: true, threadRef: "a".repeat(64), turnRef: "b".repeat(64) };

  test.each([
    ["none, first turn", "none", true, { continuation: "full", continuationReason: "first" }],
    ["none, later turn", "none", false, { continuation: "full", continuationReason: "client" }],
    ["expanded locally", "chained", true, { continuation: "chained" }],
    ["left for the upstream", "unexpanded", true, { continuation: "chained" }],
  ] as const)("%s", (_label, chain, first, expected) => {
    const logCtx: { link?: unknown } = {};
    observeLinkTurnExpansion(observer({ ...ws, first }), req(), logCtx, {}, chain);
    expect(logCtx.link).toEqual({ transport: "websocket", threadRef: ws.threadRef, turnRef: ws.turnRef, ...expected });
  });

  test("a replay failure is a miss with its own reason; a refused unexpanded continuation becomes missing", () => {
    const failed: { link?: unknown } = {};
    failLinkTurnExpansion(observer(ws), req(), failed, {}, "scope_mismatch");
    expect(failed.link).toMatchObject({ continuation: "miss", continuationReason: "scope_mismatch" });
    const refused: { link?: unknown } = {};
    observeLinkTurnExpansion(observer(ws), req(), refused, {}, "unexpanded");
    markLinkTurnMissing(refused);
    expect(refused.link).toMatchObject({ continuation: "miss", continuationReason: "missing" });
  });

  test("nothing is written without log fields, and a forged turn header claims nothing", () => {
    for (const fields of [undefined, null]) {
      const logCtx: { link?: unknown } = {};
      observeLinkTurnExpansion(observer(fields), req(), logCtx, {}, "none");
      expect(logCtx).toEqual({});
    }
    const forged = new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "x-opencodex-link-turn": "f".repeat(32) } });
    const logCtx: { link?: unknown } = {};
    observeLinkTurnExpansion(undefined, forged, logCtx, {}, "none");
    markLinkTurnMissing(logCtx);
    expect(logCtx).toEqual({});
    expect(forged.headers.has("x-opencodex-link-turn")).toBe(false);
  });
});
describe("non-link requests are untouched (T5e1-R1-01)", () => {
  test("a JSON null body takes the invalid-request path, with the feature off and no link observer", async () => {
    const release = acquireOwnedSpendHome();
    try {
      const config = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-responses", baseUrl: "https://fixture.test/v1", authMode: "key", apiKey: "fixture-key" } } } as OcxConfig;
      const logCtx = { model: "unknown", provider: "unknown" } as RequestLogContext;
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json" }, body: "null" }), config, logCtx);
      expect(response.status).toBe(400);
      expect(logCtx).not.toHaveProperty("link");
    } finally { release(); }
  });
});
describe("T5g: a combo-routed link turn is observed once at the combo's own expansion (final review b3, c1)", () => {
  test("the parent observer sees the expanded input and the row carries its link fields", async () => {
    const temp = createTempHome("ocx-link-combo-");
    const release = acquireOwnedSpendHome();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"r1","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch;
    try {
      const config = { port: 0, defaultProvider: "fixture", providers: { fixture: { adapter: "openai-responses", upstreamWebsocket: false,
        baseUrl: "https://combo-fixture.invalid/v1", authMode: "key", apiKey: "synthetic-fixture" } },
        combos: { linked: { alias: "chain/linked", strategy: "failover", waitForCooldownMs: 0, targets: [{ provider: "fixture", model: "gpt-5.5" }] } } } as unknown as OcxConfig;
      const seen: Array<{ chain: string | undefined }> = [];
      const observer = { expanded(_body: unknown, chain?: string) { seen.push({ chain }); }, expansionFailed() {}, terminal() {},
        logFields: () => ({ transport: "websocket" as const, first: true, threadRef: "c".repeat(64), turnRef: "d".repeat(64) }) };
      const logCtx = { model: "unknown", provider: "unknown" } as RequestLogContext;
      const response = await handleResponses(new Request("http://127.0.0.1/v1/responses", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chain/linked", input: "hi", stream: true, store: false }) }), config, logCtx, { linkTurn: observer });
      await response.text();
      expect(seen).toEqual([{ chain: "none" }]);
      expect(logCtx.link).toEqual({ transport: "websocket", continuation: "full", continuationReason: "first", threadRef: "c".repeat(64), turnRef: "d".repeat(64) });
    } finally {
      globalThis.fetch = originalFetch;
      runOptionalShutdownHooks();
      release();
      temp.remove();
    }
  });
});
