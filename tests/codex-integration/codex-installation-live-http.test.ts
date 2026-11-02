import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as auth from "../../src/codex/auth-context";
import { saveConfig } from "../../src/config";
import { waitForNativeMainStartupGate } from "../../src/codex/native-profile-startup";
import { startServer } from "../../src/server";
import { resolveAudioClient } from "../../src/server/audio-client";
import { handleExternalLive } from "../../src/server/audio-live";
import { LiveCallBindings } from "../../src/server/live-call-bindings";
import { tryAdmitTurn } from "../../src/server/lifecycle";
import { ownedServiceHomeInspection } from "../helpers/owned-service-home-inspection";
import { callerId, clientKey, install, installationLiveFixture, liveConfig, metadata, turn, turnMetadataBytes } from "../helpers/codex-installation-live";

const fixture = installationLiveFixture();
const originalFetch = globalThis.fetch;
let sent: Request[];
beforeEach(() => {
  sent = [];
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).hostname !== "chatgpt.com") throw new Error("unexpected fixture upstream");
    sent.push(request);
    return new Response("v=0 answer", { status: 201, headers: { location: "/v1/realtime/calls/rtc_fixture" } });
  }) as typeof fetch;
});
afterEach(() => { globalThis.fetch = originalFetch; });

function request(multipart: boolean, present = true, header = false, cm: Record<string, string> = metadata(present)) {
  const session = { model: "gpt-live-1", client_metadata: cm };
  const headers = new Headers({ authorization: `Bearer ${clientKey}` });
  if (header) headers.set(install, callerId);
  let body: BodyInit;
  if (multipart) {
    const form = new FormData(); form.set("sdp", "v=0 offer"); form.set("session", JSON.stringify(session)); body = form;
  } else { headers.set("content-type", "application/json"); body = JSON.stringify({ sdp: "v=0 offer", session }); }
  return new Request(`http://localhost/v1/${multipart ? "realtime/calls" : "live"}`, { method: "POST", headers, body });
}
for (const multipart of [false, true]) for (const kind of ["main", "main-pool", "pool"] as const)
for (const bytes of [32 * 1024 - 1, 32 * 1024, 32 * 1024 + 1]) {
  test(`external ${multipart ? "multipart" : "JSON"} ${kind} turn metadata ${bytes} bytes`, async () => {
    const raw = turnMetadataBytes(bytes); expect(Buffer.byteLength(raw)).toBe(bytes);
    const response = await call(request(multipart, false, false, { [turn]: raw }), liveConfig(kind));
    const refused = kind === "pool" && bytes > 32 * 1024;
    expect(response.status).toBe(refused ? 503 : 201); expect(sent).toHaveLength(refused ? 0 : 1);
    if (refused) expect(await response.json()).toEqual({ error: { type: "server_error", code: "server_is_overloaded", message: "Codex installation identity unavailable" } });
    else {
      const cm = (await sent[0]!.json()).session.client_metadata;
      expect(Object.hasOwn(cm, install)).toBe(false);
      if (kind === "pool") expect(JSON.parse(cm[turn])).toEqual({ installation_id: fixture.expected(), pad: JSON.parse(raw).pad });
      else expect(cm[turn]).toBe(raw);
    }
  });
}
async function call(req: Request, config = liveConfig()) {
  const client = resolveAudioClient(req, config, true);
  if (!client || client instanceof Response) throw new Error("fixture admission failed");
  const lease = tryAdmitTurn();
  if (!lease) throw new Error("fixture turn admission failed");
  try { return await handleExternalLive(req, config, { model: "", provider: "" }, { client, lease, bindings: new LiveCallBindings() }); }
  finally { lease.release(); }
}
for (const multipart of [false, true]) {
  test(`authenticated routed ${multipart ? "multipart" : "JSON"} isolates session metadata`, async () => {
    saveConfig(liveConfig());
    const server = startServer(0, { inspectNativeCodexOwnership: ownedServiceHomeInspection("installation live fixture") });
    try {
      await waitForNativeMainStartupGate();
      const req = request(multipart, true, true);
      const response = await originalFetch(new URL(new URL(req.url).pathname, server.url), req);
      expect(response.status).toBe(201);
      expect(sent).toHaveLength(1);
      const wire = await sent[0]!.json();
      expect(wire.session.client_metadata).toEqual({ keep: "unchanged", [install]: fixture.expected(),
        [turn]: JSON.stringify({ installation_id: fixture.expected(), keep: "turn" }) });
      expect(sent[0]!.headers.get(install)).toBe(fixture.expected());
    } finally { await server.stop(true); }
  });
  for (const kind of ["main", "pool", "main-pool"] as const) for (const present of [false, true]) {
    test(`external ${multipart ? "multipart" : "JSON"} ${kind} body=${present} preserves input/existence`, async () => {
      const req = request(multipart, present); const original = req.clone();
      const response = await call(req, liveConfig(kind));
      expect(response.status).toBe(201); expect(sent).toHaveLength(1);
      const wire = await sent[0]!.json();
      const cm = wire.session.client_metadata;
      expect(Object.hasOwn(cm, install)).toBe(present); expect(Object.hasOwn(cm, turn)).toBe(present);
      if (kind !== "pool" || !present) expect(cm).toEqual(metadata(present));
      else { expect(cm[install]).toBe(fixture.expected()); expect(JSON.parse(cm[turn]).installation_id).toBe(fixture.expected()); }
      expect(sent[0]!.headers.has(install)).toBe(false);
      if (multipart) expect((await original.formData()).get("session")).toBe(JSON.stringify({ model: "gpt-live-1", client_metadata: metadata(present) }));
      else expect((await original.json()).session.client_metadata).toEqual(metadata(present));
    });
  }
  for (const late of [false, true]) test(`external ${multipart ? "multipart" : "JSON"} ${late ? "late" : "body-only"} failure refuses before send`, async () => {
    const materialize = auth.headersForCodexAuthContext;
    const hook = late ? spyOn(auth, "headersForCodexAuthContext").mockImplementation((...args) => {
      const headers = materialize(...args); fixture.corrupt(); return headers;
    }) : undefined;
    if (!late) fixture.corrupt();
    try {
      const response = await call(request(multipart, true, late));
      expect(response.status).toBe(503); expect(sent).toHaveLength(0);
      expect(await response.json()).toEqual({ error: { type: "server_error", code: "server_is_overloaded", message: "Codex installation identity unavailable" } });
    } finally { hook?.mockRestore(); }
  });
}
