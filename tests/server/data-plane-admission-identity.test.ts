import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  hasValidApiAuth,
  isDataPlaneAdmissionSecret,
  isProxyAdmissionSecret,
  requireResponsesApiAuth,
  resolveApiAuth,
  resolveContextPrincipal,
  resolveDataPlaneAdmissionSecret,
  resolveResponsesApiAuth,
} from "../../src/server/auth-cors";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextRelayActivated } from "../../src/codex/context-compat";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { buildResponsesWsData } from "../../src/server/ws-bridge";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

// The admission path already knew WHICH key matched and threw it away. These
// tests pin two things at once: the id now survives, and no admission decision
// changed while it started surviving.

const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;

function remoteConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: { adapter: "openai-chat", baseUrl: "https://example.test/v1", disabled: true, models: ["gpt-test"] },
    },
    apiKeys: [
      { id: "first-key", name: "first", key: "ocx_data_firstsecret", createdAt: "2026-07-31T00:00:00.000Z" },
      { id: "second-key", name: "second", key: "ocx_data_secondsecret", createdAt: "2026-07-31T00:00:00.000Z" },
    ],
  };
}

function loopbackConfig(): OcxConfig {
  return { ...remoteConfig(), hostname: "127.0.0.1" };
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://proxy.test/v1/responses", { method: "POST", headers });
}

beforeEach(() => {
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
});

afterEach(() => {
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
});

describe("resolveDataPlaneAdmissionSecret", () => {
  test("current and unexpired pending secrets resolve to the same stable id", () => {
    const config = remoteConfig();
    config.apiKeys![0]!.pendingRotation = {
      id: "rotation-1",
      key: "ocx_data_pendingsecret",
      createdAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    expect(resolveDataPlaneAdmissionSecret("ocx_data_firstsecret", config)).toMatchObject({ keyId: "first-key" });
    expect(resolveDataPlaneAdmissionSecret("ocx_data_pendingsecret", config)).toMatchObject({ keyId: "first-key" });
    config.apiKeys![0]!.pendingRotation!.expiresAt = new Date(Date.now() - 1).toISOString();
    expect(resolveDataPlaneAdmissionSecret("ocx_data_pendingsecret", config)).toBeNull();
  });
  test("principal identity binds secret rotation while preserving promotion and transport identity", () => {
    const config = remoteConfig();
    const key = config.apiKeys![0]!;
    const principal = (token: string, source: "dedicated" | "bearer" = "dedicated") => {
      const admission = resolveDataPlaneAdmissionSecret(token, config, source);
      expect(admission).not.toBeNull();
      return admission && "contextPrincipalId" in admission ? admission.contextPrincipalId : undefined;
    };
    const initial = principal(key.key);
    expect(initial).toMatch(/^[a-f0-9]{64}$/);
    expect(principal(key.key, "bearer")).toBe(initial);
    expect(principal(config.apiKeys![1]!.key)).not.toBe(initial);
    key.pendingRotation = { id: "rotation", key: "ocx_data_new_secret",
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const pending = principal(key.pendingRotation.key);
    expect(pending).not.toBe(initial);
    const old = key.key;
    key.key = key.pendingRotation.key;
    delete key.pendingRotation;
    expect(principal(key.key)).toBe(pending);
    expect(resolveDataPlaneAdmissionSecret(old, config)).toBeNull();
  });
  test("names the configured key that actually matched", () => {
    const config = remoteConfig();
    expect(resolveDataPlaneAdmissionSecret("ocx_data_firstsecret", config)).toEqual({
      kind: "configured",
      keyId: "first-key",
      source: "dedicated",
      contextPrincipalId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test("resolves the SECOND key to its own id, not the first", () => {
    const config = remoteConfig();
    // The whole point of the refactor: the id must be the matched entry's, not
    // whichever entry happens to be first.
    expect(resolveDataPlaneAdmissionSecret("ocx_data_secondsecret", config)).toEqual({
      kind: "configured",
      keyId: "second-key",
      source: "dedicated",
      contextPrincipalId: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test("the environment token has no configured key to name", () => {
    process.env.OPENCODEX_API_AUTH_TOKEN = "env-secret";
    expect(resolveDataPlaneAdmissionSecret("env-secret", remoteConfig())).toEqual({ kind: "environment", source: "dedicated", contextPrincipalId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  test.each([
    ["an unknown token", "not-a-key"],
    ["an empty token", ""],
    ["whitespace only", "   "],
  ])("rejects %s", (_label, token) => {
    expect(resolveDataPlaneAdmissionSecret(token, remoteConfig())).toBeNull();
  });

  test("a key that only shares a prefix does not match", () => {
    expect(resolveDataPlaneAdmissionSecret("ocx_data_first", remoteConfig())).toBeNull();
  });
});

describe("no admission decision changed", () => {
  test.each([
    ["configured key", "ocx_data_firstsecret", true],
    ["second configured key", "ocx_data_secondsecret", true],
    ["unknown token", "nope", false],
    ["empty token", "", false],
  ])("isDataPlaneAdmissionSecret agrees with the resolver for %s", (_label, token, expected) => {
    const config = remoteConfig();
    expect(isDataPlaneAdmissionSecret(token, config)).toBe(expected);
    expect(resolveDataPlaneAdmissionSecret(token, config) !== null).toBe(expected);
  });

  test("the never-forward-upstream guard still recognizes a configured key", () => {
    const config = remoteConfig();
    expect(isProxyAdmissionSecret("ocx_data_firstsecret", config)).toBe(true);
    // Legacy 40-hex shape and the other proxy prefixes are unaffected.
    expect(isProxyAdmissionSecret(`ocx_${"a".repeat(40)}`, config)).toBe(true);
    expect(isProxyAdmissionSecret("sk-some-upstream-key", config)).toBe(false);
  });
});

describe("the two wrappers still differ", () => {
  test("bearer admission is accepted on both paths and names its source (#1686)", () => {
    const config = remoteConfig();
    const bearer = request({ authorization: "Bearer ocx_data_firstsecret" });

    // /v1/models and /v1/messages take bearer...
    expect(resolveApiAuth(bearer, config)).toEqual({ kind: "configured", keyId: "first-key", source: "bearer", contextPrincipalId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(hasValidApiAuth(bearer, config)).toBe(true);

    // ...and Responses now does too. Rejecting it meant a Codex client configured with
    // `env_key` could not reach Direct at all. It is safe ONLY because the upstream
    // credential is substituted rather than forwarded -- see materializeCodexUpstreamAuth.
    // The source is recorded so that substitution can be made conditional on it.
    expect(resolveResponsesApiAuth(request({ authorization: "Bearer ocx_data_firstsecret" }), config))
      .toEqual({ kind: "configured", keyId: "first-key", source: "bearer", contextPrincipalId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(requireResponsesApiAuth(request({ authorization: "Bearer ocx_data_firstsecret" }), config)).toBeNull();
  });

  test("a bearer that is NOT our secret stays unadmitted on the Responses path (#1686)", () => {
    const config = remoteConfig();
    // This is the Codex Direct passthrough case: an upstream ChatGPT bearer must not be
    // mistaken for admission, or the two bearer domains would mix after all.
    const foreign = request({ authorization: "Bearer sk-some-upstream-key" });
    expect(resolveResponsesApiAuth(foreign, config)).toBeNull();
    expect(requireResponsesApiAuth(foreign, config)?.status).toBe(401);
  });

  test("the dedicated header still wins over a bearer (#1686)", () => {
    const config = remoteConfig();
    const both = request({
      "x-opencodex-api-key": "ocx_data_secondsecret",
      authorization: "Bearer ocx_data_firstsecret",
    });
    expect(resolveResponsesApiAuth(both, config))
      .toEqual({ kind: "configured", keyId: "second-key", source: "dedicated", contextPrincipalId: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  test("x-api-key is accepted only by the broad path", () => {
    const config = remoteConfig();
    expect(resolveApiAuth(request({ "x-api-key": "ocx_data_firstsecret" }), config)).not.toBeNull();
    expect(resolveResponsesApiAuth(request({ "x-api-key": "ocx_data_firstsecret" }), config)).toBeNull();
  });

  test("the dedicated header works on both", () => {
    const config = remoteConfig();
    const dedicated = () => request({ "x-opencodex-api-key": "ocx_data_secondsecret" });
    expect(resolveApiAuth(dedicated(), config)).toEqual({ kind: "configured", keyId: "second-key", source: "dedicated", contextPrincipalId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(resolveResponsesApiAuth(dedicated(), config)).toEqual({ kind: "configured", keyId: "second-key", source: "dedicated", contextPrincipalId: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(requireResponsesApiAuth(dedicated(), config)).toBeNull();
  });
});

describe("loopback binds", () => {
  test("admit without reading a token, and say so", () => {
    const config = loopbackConfig();
    expect(resolveApiAuth(request(), config)).toEqual({ kind: "loopback", source: "loopback" });
    expect(resolveResponsesApiAuth(request(), config)).toEqual({ kind: "loopback", source: "loopback" });
    expect(hasValidApiAuth(request(), config)).toBe(true);
    expect(requireResponsesApiAuth(request(), config)).toBeNull();
  });

  test("still let a context caller name itself with a real key", () => {
    const config = loopbackConfig();
    const admission = resolveApiAuth(request(), config)!;
    // Admission is unchanged: the relay asks the identity question separately, so a caller that
    // volunteers a real key owns its sessions even here, and one that volunteers nothing does not.
    expect(resolveContextPrincipal(request(), config, admission)).toBeUndefined();
    expect(resolveContextPrincipal(request({ "x-opencodex-api-key": "ocx_data_wrongsecret" }), config, admission)).toBeUndefined();

    const first = resolveContextPrincipal(request({ "x-opencodex-api-key": "ocx_data_firstsecret" }), config, admission);
    const bearer = resolveContextPrincipal(request({ authorization: "Bearer ocx_data_firstsecret" }), config, admission);
    const second = resolveContextPrincipal(request({ "x-opencodex-api-key": "ocx_data_secondsecret" }), config, admission);
    expect(first).toBeString();
    expect(bearer).toBe(first!);
    expect(second).not.toBe(first!);
  });

  test("the activation gate re-reads a changed config and fails closed on a bad home", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-context-gate-"));
    const configPath = join(home, "config.toml");
    writeFileSync(configPath, "[features]\ncontext_management.experimental_mode = true\n");
    expect(contextRelayActivated(configPath)).toBe(true);
    // No reset seam here on purpose: turning the feature off has to take effect on its own,
    // which is the whole point of keying the cache on the config identity.
    writeFileSync(configPath, "[features]\ncontext_management.experimental_mode = false\n");
    expect(contextRelayActivated(configPath)).toBe(false);
    writeFileSync(configPath, "model = \"gpt-5.5\"\n");
    expect(contextRelayActivated(configPath)).toBe(false);
    expect(contextRelayActivated(join(home, "absent.toml"))).toBe(false);

    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = join(home, "not-a-directory-here");
    try {
      // An unreadable CODEX_HOME is a refusal, never an exception: this runs during model turns.
      expect(contextRelayActivated()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
    removeTreeWithRetry(home);
  });

  test("a remote bind keeps naming the principal from its own admission", () => {
    const config = remoteConfig();
    const admission = resolveApiAuth(request({ "x-opencodex-api-key": "ocx_data_firstsecret" }), config)!;
    expect(resolveContextPrincipal(request(), config, admission))
      .toBe(resolveContextPrincipal(request({ "x-opencodex-api-key": "ocx_data_firstsecret" }), config, admission));
    expect(resolveContextPrincipal(request(), config, undefined)).toBeUndefined();
  });
});

describe("the Responses WebSocket handshake", () => {
  test("opens for a configured key", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-admission-ws-"));
    const previousHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = home;
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret-for-ws";
    const config = remoteConfig();
    config.websockets = true;
    saveConfig(config);
    const server = startServer(0);
    try {
      const target = new URL("/v1/responses", server.url);
      target.protocol = "ws:";
      const opened = await new Promise<boolean>(resolve => {
        const socket = new WebSocket(target, {
          headers: { "X-OpenCodex-API-Key": "ocx_data_secondsecret" },
        } as unknown as string[]);
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try { socket.close(); } catch { /* already closed */ }
          resolve(value);
        };
        socket.addEventListener("open", () => finish(true));
        socket.addEventListener("error", () => finish(false));
        socket.addEventListener("close", () => finish(false));
        const timer = setTimeout(() => finish(false), 5_000);
      });
      // The handshake now branches on the resolver rather than the boolean
      // wrapper, so this pins that the rewrite did not change who gets in.
      expect(opened).toBe(true);
    } finally {
      await server.stop(true);
      if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
      else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(home);
    }
  });

  /**
   * `ws.data` is not reachable from a client socket, so this phase cannot prove
   * end-to-end that the admission arrives in the per-frame context — nothing
   * READS it yet. What is provable here is that the handshake stores it and the
   * type carries it; phase 3, which adds the consumer, drives a real frame and
   * asserts the emitted log row carries the key id.
   */
  test("the upgrade payload carries the resolved admission", () => {
    // This is the exact object the handshake hands to `server.upgrade`, so
    // dropping `admission` from the payload fails here rather than passing a
    // socket-opened assertion that never looked at it.
    const headers = new Headers({ "x-forwarded-for": "ignored" });
    const payload = buildResponsesWsData(headers, { kind: "configured", keyId: "second-key", source: "dedicated" });
    expect(payload.admission).toEqual({ kind: "configured", keyId: "second-key", source: "dedicated" });
    expect(payload.headers).toBe(headers);
  });

  // The phase-2 guard that asserted no telemetry symbols existed yet has served
  // its purpose and is gone: phase 3 is what adds them, and a guard that must be
  // deleted by the next commit is a scheduling note, not a test. What survives is
  // the payload assertion above, which stays true regardless of who consumes it.
});
