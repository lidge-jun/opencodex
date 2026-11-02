import { afterEach, beforeEach, expect, test } from "bun:test";
import { saveConfig } from "../../src/config";
import { waitForNativeMainStartupGate } from "../../src/codex/native-profile-startup";
import { startServer } from "../../src/server";
import { handleLive } from "../../src/server/live";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { callerToken, install, installationLiveFixture, liveConfig, metadata, turn } from "../helpers/codex-installation-live";

const fixture = installationLiveFixture();
const originalFetch = globalThis.fetch;
let sent: Request[];
beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (input, init) => {
    sent.push(new Request(input, init));
    return new Response("v=0 answer", { status: 201 });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });
function request(type: string, body: string) {
  return new Request("http://localhost/v1/live", { method: "POST", headers: {
    authorization: `Bearer ${callerToken}`, "chatgpt-account-id": "caller-account", "content-type": type,
  }, body });
}
for (const type of ["application/json", "text/plain", "application/octet-stream", "application/vnd.openai+json", "application/sdp"])
for (const corrupt of [false, true]) test(`routed JSON content ${type} corrupt=${corrupt}`, async () => {
  saveConfig(liveConfig());
  const server = startServer(0, { inspectNativeCodexOwnership: ownedServiceHomeInspection("installation content fixture") });
  const body = JSON.stringify({ sdp: "v=0 offer", client_metadata: metadata(), session: {
    model: "gpt-live-1", client_metadata: metadata(),
  } });
  try {
    await waitForNativeMainStartupGate();
    if (corrupt) fixture.corrupt();
    const req = request(type, body);
    const original = req.clone();
    const response = await originalFetch(new URL("/v1/live", server.url), req);
    expect(response.status).toBe(corrupt ? 503 : 201);
    expect(await original.text()).toBe(body);
    expect(sent).toHaveLength(corrupt ? 0 : 1);
    if (corrupt) {
      expect(await response.json()).toEqual({ error: { type: "server_error", code: "server_is_overloaded",
        message: "Codex installation identity unavailable" } });
    } else {
      expect(sent[0]!.headers.get("chatgpt-account-id")).toBe("canonical-live-a");
      expect(sent[0]!.headers.has(install)).toBe(false);
      const wire = await sent[0]!.json();
      for (const cm of [wire.client_metadata, wire.session.client_metadata]) {
        expect(cm[install]).toBe(fixture.expected());
        expect(JSON.parse(cm[turn])).toEqual({ installation_id: fixture.expected(), keep: "turn" });
      }
    }
  } finally { await server.stop(true); }
});
for (const kind of ["main", "main-pool", "pool"] as const)
for (const body of ["v=0\r\no=SDP offer\r\n", '{ "session": { "model": "gpt-live-1" }, "sdp": "v=0 offer" }']) {
  test(`${kind} absent metadata preserves body bytes`, async () => {
    fixture.corrupt();
    const response = await handleLive(request("application/sdp", body), liveConfig(kind), { model: "", provider: "" });
    expect(response.status).toBe(201);
    expect(sent).toHaveLength(1);
    expect(await sent[0]!.text()).toBe(body);
    expect(sent[0]!.headers.has(install)).toBe(false);
  });
}
for (const kind of ["main", "main-pool"] as const) test(`${kind} preserves present metadata bytes`, async () => {
  fixture.corrupt();
  const body = '{ "sdp": "v=0 offer", "session": ' + JSON.stringify({ client_metadata: metadata() }) + ' }';
  const response = await handleLive(request("text/plain", body), liveConfig(kind), { model: "", provider: "" });
  expect(response.status).toBe(201);
  expect(sent).toHaveLength(1);
  expect(await sent[0]!.text()).toBe(body);
});
