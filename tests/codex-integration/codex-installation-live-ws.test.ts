import { expect, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { resolveAudioClient } from "../../src/server/audio-client";
import { resolveExternalLiveSocket } from "../../src/server/audio-live";
import { attachLiveSidebandUpstream } from "../../src/server/index/live-sideband";
import { createWebsocketHandler } from "../../src/server/index/websocket-handler";
import type { ServeOptionsContext } from "../../src/server/index/serve-options";
import { resolveLiveSidebandUpgrade } from "../../src/server/live";
import { LiveCallBindings } from "../../src/server/live-call-bindings";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import type { WsData } from "../../src/server/ws-bridge";
import { resetCodexRoutingForManualSelection } from "../../src/codex/routing";
import { saveConfig } from "../../src/config";
import { waitForNativeMainStartupGate } from "../../src/codex/native-profile-startup";
import { startServer } from "../../src/server";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { callerId, callerToken, clientKey, install, installationLiveFixture, liveConfig, metadata, turn, turnMetadataBytes, type AuthKind } from "../helpers/codex-installation-live";

const fixture = installationLiveFixture();
class Upstream extends EventTarget {
  readyState: number = WebSocket.CONNECTING;
  sent: (string | Uint8Array)[] = [];
  bufferedAmount = 0;
  send(frame: string | Uint8Array) { this.sent.push(frame); this.dispatchEvent(new Event("sent")); }
  open() { this.readyState = WebSocket.OPEN; this.dispatchEvent(new Event("open")); }
  close(code = 1000, reason = "") { this.readyState = WebSocket.CLOSED; this.dispatchEvent(new CloseEvent("close", { code, reason })); }
}
async function relay(external: boolean, kind: AuthKind = "pool", account = "live-a", header = true) {
  const config = liveConfig(kind, account);
  resetCodexRoutingForManualSelection(config.activeCodexAccountId!);
  const headers = new Headers(external ? { authorization: `Bearer ${clientKey}` } : { authorization: `Bearer ${callerToken}`, "chatgpt-account-id": "caller-account" });
  if (header) headers.set(install, callerId);
  const req = new Request("http://localhost/v1/live?model=gpt-live-1", { headers });
  const lease = tryAdmitTurn(); if (!lease) throw new Error("fixture admission failed");
  const client = external ? resolveAudioClient(req, config, true) : undefined;
  if (external && (!client || client instanceof Response)) throw new Error("fixture key admission failed");
  const target = { style: "frameless-standalone", query: "model=gpt-live-1" } as const;
  const selected = external
    ? await resolveExternalLiveSocket(client!, config, { model: "", provider: "" }, target, { lease, bindings: new LiveCallBindings() })
    : await resolveLiveSidebandUpgrade(req, config, { model: "", provider: "" }, target, lease);
  if (selected instanceof Response) { lease.release(); throw new Error(`fixture resolution ${selected.status}`); }
  const upstream = new Upstream();
  const closes: { code: number; reason: string }[] = [];
  // Keep the actual resolver's selected context, just as the HTTP upgrade must.
  const data: WsData = { kind: "live-sideband", authContext: "authContext" in selected ? selected.authContext as WsData["authContext"] : undefined,
    liveUpstreamUrl: selected.upstreamWsUrl, liveUpstreamHeaders: selected.headers, livePending: [],
    liveTurnAdmissionLease: lease, liveFinish: "finish" in selected ? selected.finish : undefined };
  const socket = { data, readyState: WebSocket.OPEN as number, close(code: number, reason: string) { this.readyState = WebSocket.CLOSED; closes.push({ code, reason }); }, send() { return 1; } } as unknown as ServerWebSocket<WsData>;
  attachLiveSidebandUpstream(socket, () => upstream as unknown as WebSocket);
  const handler = createWebsocketHandler({ config, deps: {} } as ServeOptionsContext);
  return { selected, data, upstream, closes, send: (frame: string | Buffer) => handler.message(socket, frame), close: () => { upstream.close(); lease.release(); } };
}
function frame(present = true) {
  return '{ "type": "session.update", "session": ' + JSON.stringify({ client_metadata: metadata(present), instructions: "keep" }) + ' }';
}
for (const external of [false, true]) for (const queued of [false, true]) for (const binary of [false, true]) {
  test(`${external ? "key" : "native"} WS ${queued ? "queued" : "immediate"} ${binary ? "binary JSON" : "text"} isolates selected Pool`, async () => {
    const r = await relay(external);
    try {
      if (!queued) r.upstream.open();
      const original = frame(); const raw = binary ? Buffer.from(original) : original;
      await r.send(raw);
      if (queued) { expect(r.upstream.sent).toHaveLength(0); r.upstream.open(); }
      expect(r.upstream.sent).toHaveLength(1);
      const wire = r.upstream.sent[0]!;
      expect(typeof wire === "string").toBe(!binary);
      const cm = JSON.parse(typeof wire === "string" ? wire : Buffer.from(wire).toString()).session.client_metadata;
      expect(cm[install]).toBe(fixture.expected()); expect(cm[install]).toBe(r.selected.headers[install]!);
      expect(JSON.parse(cm[turn])).toEqual({ installation_id: fixture.expected(), keep: "turn" });
      expect(cm.keep).toBe("unchanged"); expect(raw.toString()).toBe(original); expect(r.closes).toEqual([]);
    } finally { r.close(); }
  });
}
for (const kind of ["main", "main-pool", "pool"] as const) for (const queued of [false, true]) {
  test(`WS ${kind} ${queued ? "queued" : "immediate"} preserves unaffected bytes with corrupt identity storage`, async () => {
    const r = await relay(false, kind, "live-a", false);
    try {
      fixture.corrupt(); if (!queued) r.upstream.open();
      const frames = kind === "pool" ? [frame(false), "not JSON", "[1,2]", '{"type":"audio.append","audio":"AA=="}'] : [frame(), frame(false)];
      for (const raw of frames) await r.send(raw);
      if (queued) r.upstream.open();
      expect(r.upstream.sent).toEqual(frames); expect(r.closes).toEqual([]);
    } finally { r.close(); }
  });
  test(`WS ${kind} ${queued ? "queued" : "immediate"} does not fabricate absent session metadata`, async () => {
    const r = await relay(true, kind);
    try {
      if (!queued) r.upstream.open();
      const raw = '{ "type": "session.update", "session": {"instructions":"keep"} }';
      await r.send(raw); if (queued) r.upstream.open();
      expect(r.upstream.sent).toEqual([raw]);
    } finally { r.close(); }
  });
}
for (const external of [false, true]) for (const queued of [false, true]) test(`WS ${external ? "key" : "native"} ${queued ? "queued" : "immediate"} identity failure refuses frame`, async () => {
  const r = await relay(external);
  try {
    if (!queued) r.upstream.open();
    fixture.corrupt(); await r.send(frame()); if (queued) r.upstream.open();
    expect(r.upstream.sent).toHaveLength(0);
    expect(r.closes).toEqual([{ code: 1011, reason: "upstream send failed" }]);
    expect(r.data.livePending).toBeUndefined();
  } finally { r.close(); }
});
for (const external of [false, true]) for (const refuse of [false, true]) test(`native downstream upgrade ${external ? "key" : "caller"} ${refuse ? "refuses late failure" : "retains selected Pool context"}`, async () => {
  const upstream = new Upstream(); let selectedHeaders: Record<string, string> | undefined;
  saveConfig(liveConfig());
  upstream.addEventListener("sent", () => upstream.dispatchEvent(new MessageEvent("message", { data: '{"type":"fixture.ack"}' })));
  const server = startServer(0, {
    inspectNativeCodexOwnership: ownedServiceHomeInspection("installation WS fixture"),
    liveSidebandWebSocketFactory: (_url, headers) => {
      selectedHeaders = headers; queueMicrotask(() => upstream.open()); return upstream as unknown as WebSocket;
    },
  });
  let client: WebSocket | undefined;
  try {
    await waitForNativeMainStartupGate();
    const url = new URL("/v1/live?model=gpt-live-1", server.url); url.protocol = "ws:";
    const outcome = await new Promise<{ code?: number; message?: string }>((resolve, reject) => {
      client = new WebSocket(url.toString(), { headers: {
        authorization: `Bearer ${external ? clientKey : callerToken}`, [install]: callerId,
        ...(external ? {} : { "chatgpt-account-id": "caller-account" }),
      } } as unknown as string[]);
      client.addEventListener("error", () => reject(new Error("fixture downstream connection failed")), { once: true });
      client.addEventListener("open", () => { if (refuse) fixture.corrupt(); client!.send(frame()); }, { once: true });
      client.addEventListener("message", event => resolve({ message: String(event.data) }), { once: true });
      client.addEventListener("close", event => resolve({ code: event.code }), { once: true });
    });
    if (refuse) { expect(outcome).toEqual({ code: 1011 }); expect(upstream.sent).toHaveLength(0); }
    else {
      expect(outcome).toEqual({ message: '{"type":"fixture.ack"}' }); expect(upstream.sent).toHaveLength(1);
      const cm = JSON.parse(upstream.sent[0] as string).session.client_metadata;
      expect(cm[install]).toBe(fixture.expected()); expect(cm[install]).toBe(selectedHeaders?.[install]);
    }
  } finally { client?.close(); await server.stop(true); }
});
test("a second selected Pool account gets a distinct session identity", async () => {
  const ids: string[] = [];
  for (const account of ["live-a", "live-b"]) {
    const r = await relay(true, "pool", account);
    try {
      r.upstream.open(); await r.send(frame());
      const cm = JSON.parse(r.upstream.sent[0] as string).session.client_metadata;
      expect(cm[install]).toBe(fixture.expected(account)); ids.push(cm[install]);
    } finally { r.close(); }
  }
  expect(ids[0]).not.toBe(ids[1]);
});
for (const queued of [false, true]) for (const bytes of [32 * 1024, 32 * 1024 + 1]) test(`WS ${queued ? "queued" : "immediate"} turn-only metadata ${bytes} bytes`, async () => {
  const r = await relay(true, "pool", "live-a", false);
  try {
    if (!queued) r.upstream.open();
    await r.send(JSON.stringify({ type: "session.update", session: { client_metadata: { [turn]: turnMetadataBytes(bytes) } } }));
    if (queued) r.upstream.open();
    if (bytes > 32 * 1024) {
      expect(r.upstream.sent).toHaveLength(0); expect(r.closes).toEqual([{ code: 1011, reason: "upstream send failed" }]);
    } else {
      expect(r.upstream.sent).toHaveLength(1);
      const cm = JSON.parse(r.upstream.sent[0] as string).session.client_metadata;
      expect(Object.hasOwn(cm, install)).toBe(false); expect(JSON.parse(cm[turn]).installation_id).toBe(fixture.expected());
    }
  } finally { r.close(); }
});
