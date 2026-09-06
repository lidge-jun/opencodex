import { describe, expect, test } from "bun:test";
import {
  createDataPlaneSeamHeaders,
  createHotPathResponsesBridge,
  HOT_PATH_BRIDGE_HEADER,
  HOT_PATH_RESPONSES_BRIDGE_PATH,
  HOT_PATH_SEAM_PATH,
  type HotPathResponsesBridge,
} from "../src/server/hot-path-seam";
import type { DataPlaneAdmission } from "../src/server/auth-cors";

// 43-char base64url relay secret, the same shape the write relay uses.
const secret = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ";
const bridgeToken = "bridge-token";
const clock = () => 1_800_000_000_000;

const admission: DataPlaneAdmission = { kind: "environment", source: "x-api-key" };

function makeBridge(dispatch?: (c: unknown) => Promise<Response>): HotPathResponsesBridge {
  const bridge = createHotPathResponsesBridge({
    bridgeToken,
    relaySecret: secret,
    dispatchResponses: async c => {
      dispatch?.(c);
      return new Response("fixture-stream", { status: 200, headers: { "content-type": "text/event-stream" } });
    },
    now: clock,
  });
  if (!bridge) throw new Error("bridge creation failed");
  return bridge;
}

function seamRequest(headers: Headers, body = `{"model":"fixture","stream":true}`): { request: Request; url: URL } {
  const request = new Request(`http://127.0.0.1${HOT_PATH_RESPONSES_BRIDGE_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json", [HOT_PATH_BRIDGE_HEADER]: bridgeToken, ...Object.fromEntries(headers) },
    body,
  });
  return { request, url: new URL(request.url) };
}

describe("hot-path seam claim and bridge (ticket #24)", () => {
  test("an admitted claim reaches dispatch with the reconstructed admission and identical body", async () => {
    let captured: { admission: DataPlaneAdmission; contentType: string | null; grokSurface: boolean; body: Uint8Array } | null = null;
    const bridge = makeBridge(c => { captured = c as typeof captured; });
    const bodyBytes = new TextEncoder().encode(`{"model":"fixture","stream":true}`);
    const headers = createDataPlaneSeamHeaders(secret, admission, "POST", HOT_PATH_SEAM_PATH, bodyBytes, clock);
    expect(headers).not.toBeNull();

    const { request, url } = seamRequest(headers!, `{"model":"fixture","stream":true}`);
    const response = await bridge.handle(request, url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("fixture-stream");
    expect(captured).not.toBeNull();
    expect(captured!.admission).toEqual(admission);
    expect(captured!.contentType).toBe("application/json");
    expect(captured!.grokSurface).toBe(false);
    expect(new TextDecoder().decode(captured!.body)).toBe(`{"model":"fixture","stream":true}`);
  });

  test("the explicit Grok surface marker reaches the bridge dispatch", async () => {
    let captured: { grokSurface: boolean } | null = null;
    const bridge = makeBridge(c => { captured = c as typeof captured; });
    const body = new Uint8Array(0);
    const headers = createDataPlaneSeamHeaders(secret, admission, "POST", HOT_PATH_SEAM_PATH, body, clock)!;
    const { request, url } = seamRequest(headers, "");
    request.headers.set("x-opencodex-grok", "1");
    expect((await bridge.handle(request, url)).status).toBe(200);
    expect(captured!.grokSurface).toBe(true);
  });

  test("a configured-key admission keeps its keyId across the bridge", async () => {
    let captured: { admission: DataPlaneAdmission } | null = null;
    const bridge = makeBridge(c => { captured = c as typeof captured; });
    const configured: DataPlaneAdmission = { kind: "configured", keyId: "key-1", source: "bearer" };
    const bodyBytes = new Uint8Array(0);
    const headers = createDataPlaneSeamHeaders(secret, configured, "POST", HOT_PATH_SEAM_PATH, bodyBytes, clock);
    const { request, url } = seamRequest(headers!, "");
    const response = await bridge.handle(request, url);
    expect(response.status).toBe(200);
    expect(captured!.admission).toEqual(configured);
  });

  test("missing or wrong bridge capability answers 404 without touching dispatch", async () => {
    let dispatched = 0;
    const bridge = makeBridge(() => { dispatched++; });
    const bodyBytes = new Uint8Array(0);
    const headers = createDataPlaneSeamHeaders(secret, admission, "POST", HOT_PATH_SEAM_PATH, bodyBytes, clock)!;
    const missing = new Request(`http://127.0.0.1${HOT_PATH_RESPONSES_BRIDGE_PATH}`, {
      method: "POST",
      headers: Object.fromEntries(headers),
      body: "",
    });
    expect((await bridge.handle(missing, new URL(missing.url))).status).toBe(404);
    const wrong = new Request(`http://127.0.0.1${HOT_PATH_RESPONSES_BRIDGE_PATH}`, {
      method: "POST",
      headers: { ...Object.fromEntries(headers), [HOT_PATH_BRIDGE_HEADER]: "wrong" },
      body: "",
    });
    expect((await bridge.handle(wrong, new URL(wrong.url))).status).toBe(404);
    expect(dispatched).toBe(0);
  });

  test("an expired claim is refused", async () => {
    const bridge = makeBridge();
    const bodyBytes = new Uint8Array(0);
    const headers = createDataPlaneSeamHeaders(secret, admission, "POST", HOT_PATH_SEAM_PATH, bodyBytes, clock)!;
    const { request, url } = seamRequest(headers, "");
    // One second past the 60s TTL window.
    const late = clock() + 60_001;
    const expiredBridge = createHotPathResponsesBridge({
      bridgeToken,
      relaySecret: secret,
      dispatchResponses: async () => new Response("never", { status: 200 }),
      now: () => late,
    })!;
    expect((await expiredBridge.handle(request, url)).status).toBe(404);
  });

  test("a changed body fails the body-bound proof", async () => {
    const bridge = makeBridge();
    const bodyBytes = new TextEncoder().encode(`{"model":"fixture","stream":true}`);
    const headers = createDataPlaneSeamHeaders(secret, admission, "POST", HOT_PATH_SEAM_PATH, bodyBytes, clock)!;
    const { request, url } = seamRequest(headers, `{"model":"TAMPERED","stream":true}`);
    expect((await bridge.handle(request, url)).status).toBe(404);
  });

  test("a replay of the same nonce is refused", async () => {
    const bridge = makeBridge();
    const bodyBytes = new Uint8Array(0);
    const headers = createDataPlaneSeamHeaders(secret, admission, "POST", HOT_PATH_SEAM_PATH, bodyBytes, clock)!;
    const first = seamRequest(headers, "");
    expect((await bridge.handle(first.request, first.url)).status).toBe(200);
    const second = seamRequest(headers, "");
    expect((await bridge.handle(second.request, second.url)).status).toBe(404);
  });

  test("a mismatched admission shape is refused before any body read", async () => {
    const bridge = makeBridge();
    const bodyBytes = new Uint8Array(0);
    const headers = createDataPlaneSeamHeaders(secret, admission, "POST", HOT_PATH_SEAM_PATH, bodyBytes, clock)!;
    const tampered = new Headers(headers);
    tampered.set("x-ocx-go-dataplane-admission", `{"kind":"bogus"}`);
    const { request, url } = seamRequest(tampered, "");
    expect((await bridge.handle(request, url)).status).toBe(404);
  });

  test("a claimed content-length beyond the body bound is refused as 413", async () => {
    const bridge = makeBridge();
    const bodyBytes = new Uint8Array(0);
    const headers = createDataPlaneSeamHeaders(secret, admission, "POST", HOT_PATH_SEAM_PATH, bodyBytes, clock)!;
    const huge = new Headers(headers);
    huge.set("content-length", String(300 * 1024 * 1024));
    const request = new Request(`http://127.0.0.1${HOT_PATH_RESPONSES_BRIDGE_PATH}`, {
      method: "POST",
      headers: { [HOT_PATH_BRIDGE_HEADER]: bridgeToken, ...Object.fromEntries(huge) },
      body: "",
    });
    const response = await bridge.handle(request, new URL(request.url));
    expect(response.status).toBe(413);
  });

  test("a malformed mint (invalid secret) produces no headers at all", () => {
    expect(createDataPlaneSeamHeaders("short", admission, "POST", HOT_PATH_SEAM_PATH, new Uint8Array(0), clock)).toBeNull();
    expect(createDataPlaneSeamHeaders("", admission, "POST", HOT_PATH_SEAM_PATH, new Uint8Array(0), clock)).toBeNull();
  });
});
