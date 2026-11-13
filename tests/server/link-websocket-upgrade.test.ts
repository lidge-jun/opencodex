import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHmac } from "node:crypto";
import type { OcxConfig } from "../../src/types";
import { linkStorePath } from "../../src/link/paths";
import { writeLinkStore, type LinkStore } from "../../src/link/store";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { getRequestLogEntries } from "../../src/server/request-log";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { LinkWireClient, frameType, type WireMessage } from "../helpers/link-ws-client";
import { setLinkWebsocketTransportReadyForTests } from "../../src/server/index/link-websocket-limits";
import * as nativeControl from "../../src/server/responses/native-response-control";
import * as workflow from "../../src/server/workflow-refusal";
import * as requestDecompress from "../../src/server/request-decompress";

const originalMode = nativeControl.nativeResponseControlMode;

// The Home side of the Responses WebSocket over a Remote Link (lane T5a). Every case drives a real
// Home: the relay-auth challenge, the session request and the upgrade share one TCP connection.

const KEY_A_ID = "link-ws-a";
const KEY_A = "link-ws-secret-a-0123456789";
const KEY_B_ID = "link-ws-b";
const KEY_B = "link-ws-secret-b-0123456789";
const LINK_A = "lnk_aaaaaaaaaaaaaaaa";
const LINK_B = "lnk_bbbbbbbbbbbbbbbb";
const ADMIN = "link-ws-admin-token-0123456789";

async function waitForHolds(path: string, linkId: string, expected: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    let contents: string | undefined;
    try { contents = readFileSync(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (contents !== undefined) {
      const state: unknown = JSON.parse(contents);
      if (!state || typeof state !== "object" || !("version" in state) || state.version !== 1 || !("keyId" in state) || (state.keyId !== null && typeof state.keyId !== "string") || !("links" in state) || !state.links || typeof state.links !== "object" || Array.isArray(state.links)) throw new Error("Malformed activity holds state");
      const entry = (state.links as Record<string, unknown>)[linkId];
      if (entry !== undefined && (!entry || typeof entry !== "object" || !("holds" in entry) || !Array.isArray(entry.holds) || !("unknown" in entry))) throw new Error("Malformed activity holds entry");
      if (entry !== undefined && (entry as { unknown: unknown }).unknown !== null) throw new Error("Activity holds state is unknown");
      if ((entry === undefined ? 0 : (entry as { holds: unknown[] }).holds.length) === expected) return;
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected} activity holds`);
    await Bun.sleep(25);
  }
}

const identityA = { keyId: KEY_A_ID, linkId: LINK_A, fingerprint: serviceApiTokenFingerprint(KEY_A) };
const identityB = { keyId: KEY_B_ID, linkId: LINK_B, fingerprint: serviceApiTokenFingerprint(KEY_B) };

const previous = {
  home: process.env.OPENCODEX_HOME,
  admin: process.env.OPENCODEX_ADMIN_AUTH_TOKEN,
};
let testHome = "";
let codexHome: IsolatedCodexHome | null = null;
let server: { stop(closeActiveConnections?: boolean): Promise<void>; url: URL } | null = null;
let upstream: ReturnType<typeof Bun.serve> | null = null;
let upstreamRequests: Array<{ headers: Array<[string, string]>; body: string }> = [];
// Which SSE body the fixture upstream answers with; a test may vary it per request.
let upstreamBody: () => string = () => COMPLETED;
let upstreamStatus: () => number = () => 200;
const clients: LinkWireClient[] = [];

const COMPLETED = [
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_link_ws","status":"in_progress","output":[]}}\n\n',
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_link_ws","status":"completed","output":[{"type":"message","id":"msg_link_ws","role":"assistant","status":"completed","content":[{"type":"output_text","text":"ok","annotations":[]}]}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
].join("");

function link(id: string, apiKeyId: string): LinkStore["links"][number] {
  return {
    id, alias: "alias-" + id.slice(-4), direction: "client-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnop",
    tunnelPort: 2222, apiKeyId, createdAt: "2026-11-12T00:00:00.000Z",
  } as LinkStore["links"][number];
}

function homeConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "fixture",
    websockets: true,
    linkResponsesWebsocket: true,
    codexAutoStart: false,
    clientIntegrations: { codex: false },
    providers: {
      fixture: {
        adapter: "openai-responses", baseUrl: "http://127.0.0.1:" + upstream!.port + "/v1",
        authMode: "key", apiKey: "fixture-upstream-key", allowPrivateNetwork: true, models: ["fixture"],
      },
    },
    apiKeys: [
      { id: KEY_A_ID, name: KEY_A_ID, key: KEY_A, createdAt: "2026-11-12T00:00:00.000Z" },
      { id: KEY_B_ID, name: KEY_B_ID, key: KEY_B, createdAt: "2026-11-12T00:00:00.000Z" },
    ],
    ...overrides,
  } as OcxConfig;
}

async function startHome(overrides: Partial<OcxConfig> = {}, links = [link(LINK_A, KEY_A_ID), link(LINK_B, KEY_B_ID)]): Promise<number> {
  const { saveConfig } = await import("../../src/config");
  writeLinkStore(linkStorePath(), { version: 1, listenerPort: null, links });
  saveConfig(homeConfig(overrides));
  const { startServer } = await import("../../src/server");
  server = startServer(0);
  return JSON.parse(readFileSync(linkStorePath(), "utf8")).listenerPort as number;
}

async function client(port: number): Promise<LinkWireClient> {
  const opened = await LinkWireClient.open(port);
  clients.push(opened);
  return opened;
}

async function openSocket(port: number, identity = identityA, bearer = KEY_A): Promise<LinkWireClient> {
  const wire = await client(port);
  const { nonce, head } = await wire.challenge(identity);
  expect(head.status).toBe(204);
  const upgrade = await wire.upgrade({ nonce, bearer });
  expect(upgrade.status).toBe(101);
  return wire;
}

function create(input = "hello"): Record<string, unknown> {
  return { type: "response.create", model: "fixture/fixture", input, stream: true };
}

async function runTurn(wire: LinkWireClient, frame = create()): Promise<WireMessage[]> {
  wire.sendJson(frame);
  return wire.until(message => frameType(message) === "response.completed");
}

async function removeLink(id: string): Promise<Response> {
  return fetch(new URL("/api/link/" + id, server!.url), { method: "DELETE", headers: { authorization: "Bearer " + ADMIN, "content-type": "application/json" }, body: "{}" });
}

beforeEach(() => {
  setLinkWebsocketTransportReadyForTests(true);
  testHome = mkdtempSync(join(tmpdir(), "ocx-link-ws-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN;
  codexHome = installIsolatedCodexHome("ocx-link-ws-codex-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture/fixture" }] }));
  upstreamRequests = [];
  upstreamBody = () => COMPLETED;
  upstreamStatus = () => 200;
  upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      upstreamRequests.push({ headers: [...req.headers.entries()], body: await req.text() });
      const status = upstreamStatus();
      if (status !== 200) return Response.json({ error: { type: "server_error", message: "fixture upstream failure" } }, { status });
      return new Response(upstreamBody(), { headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterEach(async () => {
  setLinkWebsocketTransportReadyForTests(false);
  for (const opened of clients.splice(0)) opened.destroy();
  if (server) await server.stop(true);
  server = null;
  if (upstream) await upstream.stop(true);
  upstream = null;
  codexHome?.restore();
  codexHome = null;
  if (previous.home === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous.home;
  if (previous.admin === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previous.admin;
  if (testHome) removeTreeWithRetry(testHome);
  testHome = "";
});

test("hold state wait checks persisted state without notifications and propagates bad reads", async () => {
  const path = join(testHome, "holds-probe.json");
  const waiting = waitForHolds(path, LINK_A, 1);
  writeFileSync(path, JSON.stringify({ version: 1, keyId: null, links: { [LINK_A]: { holds: [{}], unknown: null } } }));
  await waiting;
  await waitForHolds(path, LINK_A, 1);
  writeFileSync(path, "{broken");
  await expect(waitForHolds(path, LINK_A, 1)).rejects.toThrow();
  writeFileSync(path, JSON.stringify({ version: 1, keyId: null, links: { [LINK_A]: {} } }));
  await expect(waitForHolds(path, LINK_A, 1)).rejects.toThrow("Malformed activity holds entry");
  writeFileSync(path, JSON.stringify({ version: 1, keyId: null, links: { [LINK_A]: { holds: [], unknown: "write-failed" } } }));
  await expect(waitForHolds(path, LINK_A, 0)).rejects.toThrow("Activity holds state is unknown");
  await expect(waitForHolds(testHome, LINK_A, 1)).rejects.toThrow();
});

describe("link Responses WebSocket switched off (characterization)", () => {
  test.each([
    ["websockets on, link switch unset", { linkResponsesWebsocket: undefined }],
    ["websockets on, link switch false", { linkResponsesWebsocket: false }],
    ["websockets off, link switch on", { websockets: false }],
    ["link switch as a string", { linkResponsesWebsocket: "true" as unknown as boolean }],
  ])("%s: a verified upgrade gets today's 404 and the 204 carries no WebSocket state", async (_label, overrides) => {
    const port = await startHome(overrides);
    const wire = await client(port);
    const { nonce, head } = await wire.challenge(identityA);
    expect(head.status).toBe(204);
    // Today's 204: the proof and the Home's features (#8594), and no WebSocket state pair.
    expect([...head.headers.keys()].filter(name => name.startsWith("x-opencodex-")).sort()).toEqual(["x-opencodex-link-home-features", "x-opencodex-link-proof"]);
    const answer = await wire.upgrade({ nonce, bearer: KEY_A });
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "not_found" } });
    expect(upstreamRequests).toHaveLength(0);
  });

  test("switch on, but the build's release gate closed: today's 404 and no WebSocket state (R1-02)", async () => {
    setLinkWebsocketTransportReadyForTests(false);
    const port = await startHome();
    const wire = await client(port);
    const { nonce, head } = await wire.challenge(identityA);
    expect(head.headers.has("x-opencodex-link-ws-state")).toBe(false);
    const answer = await wire.upgrade({ nonce, bearer: KEY_A });
    expect(answer.status).toBe(404);
    expect(JSON.parse(answer.body)).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("link Responses WebSocket switched on", () => {
  test("a verified upgrade with the proof's key opens, runs a turn, and never forwards the link key (11.1-1, 11.1-10)", async () => {
    const port = await startHome();
    const wire = await client(port);
    const { nonce, head } = await wire.challenge(identityA);
    expect(head.headers.get("x-opencodex-link-ws-state")).toBe("on");
    const expectedProof = createHmac("sha256", Buffer.from(identityA.fingerprint, "hex"))
      .update("opencodex-link-ws-v1\0" + KEY_A_ID + "\0" + LINK_A + "\0" + nonce + "\0on").digest("hex");
    expect(head.headers.get("x-opencodex-link-ws-proof")).toBe(expectedProof);
    expect((await wire.upgrade({ nonce, bearer: KEY_A })).status).toBe(101);
    const messages = await runTurn(wire);
    expect(messages.map(frameType)).toContain("response.completed");
    expect(upstreamRequests).toHaveLength(1);
    const seen = JSON.stringify(upstreamRequests);
    expect(seen).not.toContain(KEY_A);
    expect(seen).not.toContain(identityA.fingerprint);
  });

  test("a credential that is not the proof's key gets 401 (S2, 11.1-6)", async () => {
    const port = await startHome();
    const wire = await client(port);
    const { nonce } = await wire.challenge(identityA);
    const answer = await wire.upgrade({ nonce, bearer: KEY_B });
    expect(answer.status).toBe(401);
    expect(upstreamRequests).toHaveLength(0);
  });

  test("malformed, sessionless and legacy-key upgrades keep today's 404 (characterization)", async () => {
    const port = await startHome();
    const malformed: Array<Parameters<LinkWireClient["upgrade"]>[0]> = [
      { headers: { origin: "http://127.0.0.1" } },
      { path: "/v1/responses?x=1" },
      { path: "/v1/responses/compact" },
      { headers: { "sec-websocket-protocol": "chat" } },
      { headers: { "sec-websocket-extensions": "permessage-deflate" } },
      { headers: { "sec-websocket-version": "8" } },
      { headers: { "sec-websocket-key": null } },
      { headers: { upgrade: "h2c" } },
    ];
    for (const shape of malformed) {
      const wire = await client(port);
      const { nonce } = await wire.challenge(identityA);
      const answer = await wire.upgrade({ ...shape, nonce, bearer: KEY_A });
      expect({ shape, status: answer.status }).toEqual({ shape, status: 404 });
    }
    const sessionless = await client(port);
    expect((await sessionless.upgrade({ bearer: KEY_A })).status).toBe(404);
    const unknownNonce = await client(port);
    expect((await unknownNonce.upgrade({ nonce: "0".repeat(64), bearer: KEY_A })).status).toBe(404);
    expect(upstreamRequests).toHaveLength(0);
  });

  test("revoking a link through DELETE /api/link/:id closes its socket with 4401; the other link keeps working (11.1-2)", async () => {
    const port = await startHome();
    const a = await openSocket(port, identityA, KEY_A);
    const b = await openSocket(port, identityB, KEY_B);
    const removed = await removeLink(LINK_A);
    expect(removed.status).toBe(200);
    const closed = await a.nextMessage();
    expect(closed).toMatchObject({ type: "close", code: 4401 });
    const rowsBefore = getRequestLogEntries().length;
    a.sendJson(create("after revoke"));
    // Synchronize on the Home ending the connection before reading the counters.
    expect(await a.nextMessage()).toEqual({ type: "eof" });
    expect(upstreamRequests).toHaveLength(0);
    expect(getRequestLogEntries().length).toBe(rowsBefore);
    const turn = await runTurn(b);
    expect(turn.map(frameType)).toContain("response.completed");
    expect(upstreamRequests).toHaveLength(1);
  });

  test("an external links.json edit with the same size and mtime refuses the next frame (11.1-3)", async () => {
    const port = await startHome();
    const wire = await openSocket(port);
    const path = linkStorePath();
    // A whole-second mtime survives utimes exactly, so "same mtime" is an exact comparison.
    utimesSync(path, 1_794_000_000, 1_794_000_000);
    const before = statSync(path);
    const original = readFileSync(path, "utf8");
    // Same length: swap which key each link names. Same mtime: restore it after the write.
    const swapped = original.replace('"' + KEY_A_ID + '"', '"__KEY_A__"').replace('"' + KEY_B_ID + '"', '"' + KEY_A_ID + '"').replace('"__KEY_A__"', '"' + KEY_B_ID + '"');
    expect(swapped.length).toBe(original.length);
    expect(swapped).not.toBe(original);
    writeFileSync(path, swapped);
    utimesSync(path, 1_794_000_000, 1_794_000_000);
    expect(statSync(path).size).toBe(before.size);
    expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    wire.sendJson(create());
    expect(await wire.nextMessage()).toMatchObject({ type: "close", code: 4401 });
    expect(upstreamRequests).toHaveLength(0);
  });

  test("a proof made on one connection never upgrades another, even on the same port (S1, S4)", async () => {
    const port = await startHome();
    const proved = await client(port);
    const { nonce } = await proved.challenge(identityA);
    const other = await client(port);
    expect((await other.upgrade({ nonce, bearer: KEY_A })).status).toBe(404);
    // The nonce was consumed by the refused attempt, so the proving connection cannot use it either.
    expect((await proved.upgrade({ nonce, bearer: KEY_A })).status).toBe(404);
  });

  test("native control frames get native_control_unavailable_on_link even with steering and injection on (11.1-5a)", async () => {
    const port = await startHome({ codexNativeSteering: true, codexNativeInjection: true });
    const wire = await openSocket(port);
    for (const type of ["response.inject", "response.steer"]) {
      wire.sendJson({ type, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "x" }] }] });
      const answer = await wire.nextMessage();
      expect(answer.type).toBe("text");
      const parsed = JSON.parse((answer as { data: string }).data) as { type: string; error?: { code?: string } };
      expect({ type, frame: parsed.type, code: parsed.error?.code }).toEqual({ type, frame: "error", code: "native_control_unavailable_on_link" });
    }
    const turn = await runTurn(wire);
    expect(turn.map(frameType)).toContain("response.completed");
    expect(upstreamRequests).toHaveLength(1);
  });

  test("a link response.create never reaches native mode selection, while a local socket with the same config does (R2-01)", async () => {
    const port = await startHome({ codexNativeSteering: true, codexNativeInjection: true });
    const mode = spyOn(nativeControl, "nativeResponseControlMode");
    try {
      const wire = await openSocket(port);
      const turn = await runTurn(wire);
      expect(turn.map(frameType)).toContain("response.completed");
      expect(mode).not.toHaveBeenCalled();
      // Control: the same frame on the Home's own listener does reach the decision, and it selects
      // steering, so the assertion above is not vacuous.
      const local = new WebSocket(new URL("/v1/responses", server!.url).href.replace("http:", "ws:"));
      await new Promise<void>((resolve, reject) => { local.onopen = () => resolve(); local.onerror = () => reject(new Error("local websocket failed")); });
      const decided = new Promise<void>(resolve => { mode.mockImplementation((...args) => { resolve(); return originalMode(...args); }); });
      local.send(JSON.stringify(create()));
      await decided;
      expect(mode).toHaveBeenCalledTimes(1);
      expect(originalMode(create(), { codexNativeSteering: true, codexNativeInjection: true })).toBe("steering");
      local.close();
    } finally {
      mode.mockRestore();
    }
  });

  test("with the real shared handler, a workflow refusal keeps a hold and an admitted turn releases it (T5d1-R3-01)", async () => {
    const callTurn = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_tool","status":"in_progress","output":[]}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_tool","status":"completed","output":[{"type":"function_call","id":"fc_hold","call_id":"call_hold","name":"shell","arguments":"{}","status":"completed"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
    ].join("");
    upstreamBody = () => (upstreamRequests.length === 1 ? callTurn : COMPLETED);
    const port = await startHome();
    const holdsPath = join(testHome, "link", "activity-holds.json");
    const holdsOf = () => (JSON.parse(readFileSync(holdsPath, "utf8")) as { links: Record<string, { holds: unknown[] }> }).links[LINK_A]?.holds.length ?? 0;
    const first = await client(port);
    const session = await first.challenge(identityA);
    expect((await first.upgrade({ nonce: session.nonce, bearer: KEY_A, headers: { "thread-id": "thread-hold" } })).status).toBe(101);
    await runTurn(first);
    first.destroy();
    await waitForHolds(holdsPath, LINK_A, 1);
    expect(holdsOf()).toBe(1);

    const second = await client(port);
    const next = await second.challenge(identityA);
    expect((await second.upgrade({ nonce: next.nonce, bearer: KEY_A, headers: { "thread-id": "thread-hold" } })).status).toBe(101);
    const returned = { ...create([{ type: "function_call_output", call_id: "call_hold", output: "done" }]) };
    const refuse = spyOn(workflow, "admitHttpWorkflowTurn").mockImplementation(() => ({ admitted: false, reason: "workflow-sends-exhausted", rootId: "" }));
    try {
      second.sendJson(returned);
      const refused = await second.nextMessage();
      expect(frameType(refused)).toBe("error");
    } finally { refuse.mockRestore(); }
    expect(holdsOf()).toBe(1);
    // A turn the pipeline answers with an error (here the upstream refuses it) does not release it either.
    upstreamStatus = () => 400;
    second.sendJson(returned);
    const failed = await second.until(message => frameType(message) === "error" || frameType(message) === "response.failed");
    expect(failed.map(frameType).some(type => type === "error" || type === "response.failed")).toBe(true);
    upstreamStatus = () => 200;
    expect(holdsOf()).toBe(1);
    await runTurn(second, returned);
    await waitForHolds(holdsPath, LINK_A, 0);
    expect(holdsOf()).toBe(0);
  });

  test("with the real shared handler, a result refused on its own socket stays pending, so a later close still holds (T5d1-R4-01)", async () => {
    const callTurn = [
      'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_tool2","status":"in_progress","output":[]}}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_tool2","status":"completed","output":[{"type":"function_call","id":"fc_same","call_id":"call_same","name":"shell","arguments":"{}","status":"completed"}],"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
    ].join("");
    upstreamBody = () => (upstreamRequests.length === 1 ? callTurn : COMPLETED);
    const port = await startHome();
    const holdsPath = join(testHome, "link", "activity-holds.json");
    const holdsOf = () => (JSON.parse(readFileSync(holdsPath, "utf8")) as { links: Record<string, { holds: unknown[] }> }).links[LINK_A]?.holds.length ?? 0;
    const wire = await client(port);
    const session = await wire.challenge(identityA);
    expect((await wire.upgrade({ nonce: session.nonce, bearer: KEY_A, headers: { "thread-id": "thread-same" } })).status).toBe(101);
    await runTurn(wire);
    const returned = create([{ type: "function_call_output", call_id: "call_same", output: "done" }]);
    const refuse = spyOn(workflow, "admitHttpWorkflowTurn").mockImplementation(() => ({ admitted: false, reason: "workflow-sends-exhausted", rootId: "" }));
    try {
      wire.sendJson(returned);
      expect(frameType(await wire.nextMessage())).toBe("error");
    } finally { refuse.mockRestore(); }
    upstreamStatus = () => 400;
    wire.sendJson(returned);
    const failed = await wire.until(message => frameType(message) === "error" || frameType(message) === "response.failed");
    expect(failed.map(frameType).some(type => type === "error" || type === "response.failed")).toBe(true);
    upstreamStatus = () => 200;
    wire.destroy();
    await waitForHolds(holdsPath, LINK_A, 1);
    expect(holdsOf()).toBe(1);
  });

  test("a revoked socket's inject is refused by the authorization check, not answered (11.1-5a)", async () => {
    const port = await startHome({ codexNativeInjection: true });
    const wire = await openSocket(port);
    writeLinkStore(linkStorePath(), { version: 1, listenerPort: port, links: [link(LINK_B, KEY_B_ID)] });
    wire.sendJson({ type: "response.inject", input: [] });
    expect(await wire.nextMessage()).toMatchObject({ type: "close", code: 4401 });
  });

  test("removing the last link closes link sockets and resolves; stopping with a socket open resolves (11.1-11)", async () => {
    const port = await startHome({}, [link(LINK_A, KEY_A_ID)]);
    const first = await openSocket(port);
    expect((await removeLink(LINK_A)).status).toBe(200);
    expect(await first.nextMessage()).toMatchObject({ type: "close", code: 4401 });
    await server!.stop(true);
    server = null;
    const relinked = await startHome({}, [link(LINK_A, KEY_A_ID)]);
    const second = await openSocket(relinked);
    await server!.stop(true);
    server = null;
    const after = await second.nextMessage();
    expect(["close", "eof"]).toContain(after.type);
  });
});

describe("a link create reaches the pipeline once (#8600)", () => {
  test("the pipeline takes the frame the socket parsed instead of reading it back from a request body; a local socket still reads one", async () => {
    const port = await startHome();
    const read = spyOn(requestDecompress, "readJsonRequestBody");
    try {
      const wire = await openSocket(port);
      expect((await runTurn(wire, create("from the link"))).map(frameType)).toContain("response.completed");
      expect(read).not.toHaveBeenCalled();
      const local = new WebSocket(new URL("/v1/responses", server!.url).href.replace("http:", "ws:"));
      await new Promise<void>((resolve, reject) => { local.onopen = () => resolve(); local.onerror = () => reject(new Error("local websocket failed")); });
      const done = new Promise<void>(resolve => { local.onmessage = event => { if (String(event.data).includes("response.completed")) resolve(); }; });
      local.send(JSON.stringify(create("from the local socket")));
      await done;
      expect(read).toHaveBeenCalledTimes(1);
      local.close();
    } finally { read.mockRestore(); }
    // Both turns reached the upstream with their own input.
    expect(JSON.stringify(upstreamRequests)).toContain("from the link");
    expect(JSON.stringify(upstreamRequests)).toContain("from the local socket");
  });

  test("a link create through a combo reaches the upstream as the child the combo built, not as the parent's body", async () => {
    const port = await startHome({ combos: { free: { strategy: "failover", targets: [{ provider: "fixture", model: "fixture" }] } } } as Partial<OcxConfig>);
    const wire = await openSocket(port);
    expect((await runTurn(wire, { ...create("through the combo"), model: "combo/free" })).map(frameType)).toContain("response.completed");
    expect(upstreamRequests).toHaveLength(1);
    expect((JSON.parse(upstreamRequests[0]!.body) as Record<string, unknown>).model).toBe("fixture");
  });

  test("a link create past the configured inbound limit is refused as it was when it was read back", async () => {
    const port = await startHome({ maxInboundBodyBytes: 1024 * 1024 });
    const wire = await openSocket(port);
    wire.sendJson(create("x".repeat(2 * 1024 * 1024)));
    const error = await wire.until(message => frameType(message) === "error");
    const frame = JSON.parse(String(error[error.length - 1]!.data)) as Record<string, unknown>;
    expect({ status: frame.status, code: (frame.error as Record<string, unknown> | undefined)?.code }).toEqual({ status: 413, code: "inbound_body_too_large" });
    expect(upstreamRequests).toHaveLength(0);
  });
});
