import { describe, expect, test } from "bun:test";
import {
  GO_SIDECAR_BRIDGE_HEADER,
  GO_SIDECAR_WRITE_BRIDGE_PATH,
  GO_SIDECAR_WRITE_RELAY_EXPIRES_AT_HEADER,
  GO_SIDECAR_WRITE_RELAY_METHOD_HEADER,
  GO_SIDECAR_WRITE_RELAY_NONCE_HEADER,
  GO_SIDECAR_WRITE_RELAY_PATH_HEADER,
  GO_SIDECAR_WRITE_RELAY_PRINCIPAL_HEADER,
  GO_SIDECAR_WRITE_RELAY_PROOF_HEADER,
  createGoSidecarWriteRelay,
  createGoSidecarWriteRelayHeaders,
  createGoSidecarWriteRelayNonce,
  createGoSidecarWriteRelayProof,
} from "../src/server/go-sidecar-write-relay";

const BRIDGE_TOKEN = "c8cb2a09-6c5e-4d5a-9252-421cb8c3e698";
const RELAY_SECRET = "b".repeat(43);
const NOW = 1_800_000_000_000;
const ROUTE = "/api/settings";
const BODY = new TextEncoder().encode('{"streamMode":"eager-relay"}');

function request(options: Partial<{ bridgeToken: string; nonce: string; method: string; path: string; principal: string; expiresAt: number; proof: string; body: Uint8Array }> = {}): Request {
  const nonce = options.nonce ?? createGoSidecarWriteRelayNonce();
  const method = options.method ?? "PUT";
  const path = options.path ?? ROUTE;
  const principal = options.principal ?? "admin-token";
  const expiresAt = options.expiresAt ?? NOW + 1_000;
  const body = options.body ?? BODY;
  const proof = options.proof ?? createGoSidecarWriteRelayProof(
    RELAY_SECRET,
    { nonce, principal: principal as "admin-token", method: method as "PUT", path, expiresAt },
    body,
  )!;
  return new Request("http://127.0.0.1" + GO_SIDECAR_WRITE_BRIDGE_PATH, {
    method: "PUT",
    headers: {
      [GO_SIDECAR_BRIDGE_HEADER]: options.bridgeToken ?? BRIDGE_TOKEN,
      [GO_SIDECAR_WRITE_RELAY_NONCE_HEADER]: nonce,
      [GO_SIDECAR_WRITE_RELAY_PRINCIPAL_HEADER]: principal,
      [GO_SIDECAR_WRITE_RELAY_METHOD_HEADER]: method,
      [GO_SIDECAR_WRITE_RELAY_PATH_HEADER]: path,
      [GO_SIDECAR_WRITE_RELAY_EXPIRES_AT_HEADER]: String(expiresAt),
      [GO_SIDECAR_WRITE_RELAY_PROOF_HEADER]: proof,
      "content-type": "application/json",
    },
    body,
  });
}

function relay(calls: Array<{ request: Request; principal: string }> = []) {
  return createGoSidecarWriteRelay({
    bridgeToken: BRIDGE_TOKEN,
    relaySecret: RELAY_SECRET,
    now: () => NOW,
    dispatchLegacy: async (legacyRequest, _url, principal) => {
      calls.push({ request: legacyRequest, principal });
      return new Response("legacy-body", { status: 409, headers: { "content-type": "application/json", "retry-after": "1" } });
    },
  })!;
}

describe("Go sidecar private write relay", () => {
  test("mints a fresh body-bound claim only for an admitted principal", async () => {
    const headers = createGoSidecarWriteRelayHeaders(
      RELAY_SECRET,
      "admin-token",
      { method: "PUT", pathname: ROUTE, body: BODY },
      () => NOW,
    );
    expect(headers).not.toBeNull();
    expect(headers!.get(GO_SIDECAR_WRITE_RELAY_METHOD_HEADER)).toBe("PUT");
    expect(headers!.get(GO_SIDECAR_WRITE_RELAY_PATH_HEADER)).toBe(ROUTE);
    const bridge = relay();
    const signed = new Request("http://127.0.0.1" + GO_SIDECAR_WRITE_BRIDGE_PATH, {
      method: "PUT",
      headers: { [GO_SIDECAR_BRIDGE_HEADER]: BRIDGE_TOKEN, ...Object.fromEntries(headers!) },
      body: BODY,
    });
    expect((await bridge.handle(signed, new URL(signed.url))).status).toBe(409);
    expect(createGoSidecarWriteRelayHeaders(
      RELAY_SECRET,
      undefined,
      { method: "PUT", pathname: ROUTE, body: BODY },
      () => NOW,
    )).toBeNull();
  });

  test("accepts the UUID-shaped per-sidecar capability but requires a separate HMAC secret", () => {
    expect(createGoSidecarWriteRelay({
      bridgeToken: BRIDGE_TOKEN,
      relaySecret: RELAY_SECRET,
      dispatchLegacy: async () => null,
    })).not.toBeNull();
    expect(createGoSidecarWriteRelay({
      bridgeToken: "",
      relaySecret: RELAY_SECRET,
      dispatchLegacy: async () => null,
    })).toBeNull();
  });

  test("requires bridge capability and one body-bound signed claim before legacy dispatch", async () => {
    const calls: Array<{ request: Request; principal: string }> = [];
    const bridge = relay(calls);
    const response = await bridge.handle(request(), new URL("http://127.0.0.1" + GO_SIDECAR_WRITE_BRIDGE_PATH));
    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.text()).toBe("legacy-body");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.principal).toBe("admin-token");
    expect(calls[0]!.request.method).toBe("PUT");
    expect(new URL(calls[0]!.request.url).pathname).toBe(ROUTE);
    expect(await calls[0]!.request.text()).toBe(new TextDecoder().decode(BODY));
  });

  test("rejects wrong bridge capability, undeclared writes, altered bodies, expired claims, and replay", async () => {
    const calls: Array<{ request: Request; principal: string }> = [];
    const bridge = relay(calls);
    const nonce = createGoSidecarWriteRelayNonce();
    const valid = request({ nonce });
    const staleProofNonce = createGoSidecarWriteRelayNonce();
    const altered = request({
      nonce: createGoSidecarWriteRelayNonce(),
      body: new TextEncoder().encode('{"streamMode":"auto"}'),
      proof: createGoSidecarWriteRelayProof(
        RELAY_SECRET,
        { nonce: staleProofNonce, principal: "admin-token", method: "PUT", path: ROUTE, expiresAt: NOW + 1_000 },
        BODY,
      )!,
    });
    for (const candidate of [
      request({ bridgeToken: "c".repeat(43) }),
      request({ path: "/api/not-declared" }),
      request({ expiresAt: NOW }),
      altered,
    ]) {
      expect((await bridge.handle(candidate, new URL(candidate.url))).status).toBe(404);
    }
    expect((await bridge.handle(valid, new URL(valid.url))).status).toBe(409);
    expect((await bridge.handle(request({ nonce }), new URL("http://127.0.0.1" + GO_SIDECAR_WRITE_BRIDGE_PATH))).status).toBe(404);
    expect(calls).toHaveLength(1);
  });
});
