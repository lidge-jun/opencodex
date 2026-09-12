import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resolveAudioClient, type AudioClient } from "../../src/server/audio-client";
import type { OcxConfig } from "../../src/types";

const KEY = "ocx_data_audio_client_fixture";
const originalToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const config = { providers: {}, defaultProvider: "none", apiKeys: [{ id: "one", name: "one", key: KEY, createdAt: "2026-09-12T00:00:00Z" }] } as OcxConfig;
beforeEach(() => { delete process.env.OPENCODEX_API_AUTH_TOKEN; });
afterEach(() => {
  if (originalToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = originalToken;
});

function request(headers: Record<string, string>): Request {
  return new Request("http://localhost/v1/live", { headers: { upgrade: "websocket", ...headers } });
}
function carrier(key = KEY): string { return `opencodex-audio, opencodex-key.${Buffer.from(key).toString("base64url")}`; }
function client(result: ReturnType<typeof resolveAudioClient>): AudioClient {
  if (!result || result instanceof Response) throw new Error("Expected admitted audio client");
  return result;
}

describe("audio-only WebSocket admission", () => {
  test("browser carrier resolves a configured owner and selects only the public protocol", () => {
    const result = client(resolveAudioClient(request({ "sec-websocket-protocol": carrier() }), config, true));
    expect(result.admission).toEqual({ kind: "configured", keyId: "one", source: "dedicated" });
    expect(result.protocol).toBe("opencodex-audio");
    expect(result.owner).toBe('["configured","one"]');
    expect(result.owner).not.toContain(KEY);
  });
  test("bad explicit headers win over a valid carrier", () => {
    const result = resolveAudioClient(request({ "sec-websocket-protocol": carrier(), "x-opencodex-api-key": "wrong" }), config, true);
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
  test.each([
    "opencodex-audio", `opencodex-key.${Buffer.from(KEY).toString("base64url")}`,
    carrier() + ", opencodex-audio", carrier() + ", other",
    "opencodex-audio, opencodex-key.bm9uY2Fub25pY2Fs=",
  ])("rejects malformed protocol pair %s", value => {
    expect((resolveAudioClient(request({ "sec-websocket-protocol": value }), config, true) as Response).status).toBe(400);
  });
  test("same environment key has one owner across header carriers", () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "fixture-env-audio";
    const bearer = client(resolveAudioClient(request({ authorization: "Bearer fixture-env-audio" }), config));
    const dedicated = client(resolveAudioClient(request({ "x-opencodex-api-key": "fixture-env-audio" }), config));
    expect(bearer.owner).toBe(dedicated.owner);
    expect(bearer.owner).not.toContain("fixture-env-audio");
  });
  test("required audio never falls through to unauthenticated loopback", () => {
    expect((resolveAudioClient(request({}), config, true) as Response).status).toBe(401);
    expect(resolveAudioClient(request({}), config)).toBeNull();
    expect((resolveAudioClient(request({ authorization: "Bearer custom-revoked-key" }), config) as Response).status).toBe(401);
  });
  test("pending rotation key keeps configured call ownership", () => {
    const rotated = { ...config, apiKeys: [{ ...config.apiKeys![0]!, pendingRotation: { id: "rotation", key: "ocx_data_rotated_fixture", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() } }] };
    const old = client(resolveAudioClient(request({ authorization: `Bearer ${KEY}` }), rotated));
    const next = client(resolveAudioClient(request({ authorization: "Bearer ocx_data_rotated_fixture" }), rotated));
    expect(next.owner).toBe(old.owner);
  });
  test("known native platform bearer retains legacy handling without guessing by prefix", () => {
    const keyed: OcxConfig = { ...config, providers: { "openai-apikey": { adapter: "openai-responses", baseUrl: "https://api.openai.com/v1", apiKey: "sk-fixture-native", authMode: "key" } } };
    expect(resolveAudioClient(request({ authorization: "Bearer sk-fixture-native" }), keyed)).toBeNull();
    expect((resolveAudioClient(request({ authorization: "Bearer sk-other-revoked" }), keyed) as Response).status).toBe(401);
  });
});
