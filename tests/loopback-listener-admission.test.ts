/**
 * Tests for the unauthenticated loopback listener (#1102).
 *
 * The defect: with `hostname: "0.0.0.0"`, every caller needs `x-opencodex-api-key`, but a
 * `codex app-server` spawned from the resolved entrypoint never goes through the generated
 * shim and so never inherits the token. Every model call 401s at admission.
 *
 * The fix is deliberately NOT an exemption on the public listener. `requestIP()` only proves
 * the last transport hop, and Docker port forwarding, host-network containers, WSL mirrored
 * networking and tunnels all terminate remote connections locally — a peer that "looks
 * loopback" is not evidence of a local caller. Instead a second socket binds 127.0.0.1, so the
 * kernel refuses remote connections and there is no address to judge.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  isAllowedRequestOrigin,
  requestPolicyView,
  resolveResponsesApiAuth,
} from "../src/server/auth-cors";
import { buildProviderTableBlock, shouldInjectApiAuthHeader } from "../src/codex/inject";
import { validateConfigCandidate } from "../src/config";
import type { OcxConfig } from "../src/types";

const wildcardConfig = {
  hostname: "0.0.0.0",
  apiKeys: [{ id: "k1", key: "ocx_data_realsecret", name: "test" }],
} as unknown as OcxConfig;

function request(path = "/v1/responses", headers: Record<string, string> = {}): Request {
  return new Request(`http://127.0.0.1:10200${path}`, { headers });
}

describe("loopback listener policy view", () => {
  test("the public listener still demands a credential on a wildcard bind", () => {
    // The whole point of the separate listener is that this does not change.
    expect(resolveResponsesApiAuth(request(), wildcardConfig)).toBeNull();
  });

  test("the loopback view admits without a credential and names it loopback", () => {
    const policy = requestPolicyView(wildcardConfig, "127.0.0.1");
    expect(resolveResponsesApiAuth(request(), policy)).toEqual({ kind: "loopback", source: "loopback" });
  });

  test("the view carries no bind address other than the one it was given", () => {
    // A view built from a wildcard config must not leak that wildcard back into an auth
    // decision — that would silently restore the 401 the listener exists to avoid.
    const policy = requestPolicyView(wildcardConfig, "127.0.0.1");
    expect(policy.hostname).toBe("127.0.0.1");
  });

  test("a valid configured key is still attributed to that key, not collapsed to loopback", () => {
    // The loopback view takes the same branch a plain loopback bind always has, which returns
    // before reading any header. Assert the public listener keeps per-key attribution so a
    // future refactor cannot quietly make every admission anonymous.
    expect(resolveResponsesApiAuth(
      request("/v1/responses", { "x-opencodex-api-key": "ocx_data_realsecret" }),
      wildcardConfig,
    )).toEqual({ kind: "configured", keyId: "k1", source: "dedicated" });
  });

  test("both Anthropic routes finish CORS with the listener-effective policy", () => {
    const source = readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");
    const countTokensStart = source.indexOf('url.pathname === "/v1/messages/count_tokens"');
    const messagesStart = source.indexOf('url.pathname === "/v1/messages"', countTokensStart + 1);
    const chatStart = source.indexOf('url.pathname === "/v1/chat/completions"', messagesStart);
    expect(countTokensStart).toBeGreaterThan(-1);
    expect(messagesStart).toBeGreaterThan(countTokensStart);
    expect(chatStart).toBeGreaterThan(messagesStart);
    expect(source.slice(countTokensStart, messagesStart)).toContain(
      "await handleClaudeCountTokens(req, config, policy)",
    );
    expect(source.slice(messagesStart, chatStart)).toContain(
      "await handleClaudeMessages(req, config, logCtx, { requestId, start, turnAdmissionLease }, policy)",
    );
    for (const branch of [
      source.slice(countTokensStart, messagesStart),
      source.slice(messagesStart, chatStart),
    ]) {
      expect(branch).toContain("req,\n          policy,\n        ));");
      expect(branch).not.toContain("req,\n          config,\n        ));");
    }
  });
});

describe("loopback listener origin gate", () => {
  // The kernel bind stops remote TCP, but not a victim browser: an attacker page can make the
  // browser connect to 127.0.0.1, and that connection IS local. The Host/Origin gate is the
  // other half of the boundary, and the loopback view must route through it.
  test("a hostile Host is rejected under the loopback policy", () => {
    const policy = requestPolicyView(wildcardConfig, "127.0.0.1");
    expect(isAllowedRequestOrigin(
      request("/v1/responses", { Host: "attacker.example" }),
      policy,
    )).toBe(false);
  });

  test("a hostile Origin is rejected even when the Host looks local", () => {
    const policy = requestPolicyView(wildcardConfig, "127.0.0.1");
    expect(isAllowedRequestOrigin(
      request("/v1/responses", { Host: "127.0.0.1:10200", Origin: "http://attacker.example" }),
      policy,
    )).toBe(false);
  });

  test("the same hostile Origin would pass under the PUBLIC policy via same-origin", () => {
    // This is why the view matters. On a remote bind `isAllowedRequestOrigin` accepts a
    // same-origin request, so handing the public config to the loopback listener's origin
    // check would admit exactly the DNS-rebinding shape the test above rejects.
    const sameOrigin = new Request("http://attacker.example/v1/responses", {
      headers: { Origin: "http://attacker.example" },
    });
    expect(isAllowedRequestOrigin(sameOrigin, wildcardConfig)).toBe(true);
  });

  test("an ordinary local request is allowed", () => {
    const policy = requestPolicyView(wildcardConfig, "127.0.0.1");
    expect(isAllowedRequestOrigin(request("/v1/responses", { Host: "127.0.0.1:10200" }), policy)).toBe(true);
  });
});

describe("loopback listener configuration", () => {
  test("an enabled listener sharing the proxy port is rejected at write time", () => {
    // A collision would otherwise surface as a startup failure after the public listener had
    // already bound, which reads like an unrelated port conflict.
    const result = validateConfigCandidate({
      port: 10100,
      providers: { openai: { adapter: "openai", baseUrl: "https://chatgpt.com/backend-api/codex" } },
      defaultProvider: "openai",
      unauthenticatedLoopbackListener: { enabled: true, port: 10100 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("must differ from the proxy port");
  });

  test("an enabled listener without a port is rejected", () => {
    // An OS-assigned port would change across restarts and strand app-servers holding the
    // previous base_url — the symptom #1102 reported and we disproved for token rotation.
    const result = validateConfigCandidate({
      port: 10100,
      providers: { openai: { adapter: "openai", baseUrl: "https://chatgpt.com/backend-api/codex" } },
      defaultProvider: "openai",
      unauthenticatedLoopbackListener: { enabled: true },
    });
    expect(result.ok).toBe(false);
  });

  test("a disabled listener needs no port", () => {
    const result = validateConfigCandidate({
      port: 10100,
      providers: { openai: { adapter: "openai", baseUrl: "https://chatgpt.com/backend-api/codex" } },
      defaultProvider: "openai",
      unauthenticatedLoopbackListener: { enabled: false },
    });
    expect(result.ok).toBe(true);
  });

  test("a distinct port is accepted and survives the parse", () => {
    const result = validateConfigCandidate({
      port: 10100,
      providers: { openai: { adapter: "openai", baseUrl: "https://chatgpt.com/backend-api/codex" } },
      defaultProvider: "openai",
      unauthenticatedLoopbackListener: { enabled: true, port: 10200 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.unauthenticatedLoopbackListener).toEqual({ enabled: true, port: 10200 });
    }
  });
});

describe("injected Codex provider block", () => {
  test("a wildcard bind alone still emits the env auth header", () => {
    expect(shouldInjectApiAuthHeader({ hostname: "0.0.0.0" })).toBe(true);
  });

  test("enabling the loopback listener drops the header", () => {
    // The directly-spawned app-server has no OPENCODEX_API_AUTH_TOKEN, so emitting the header
    // would make Codex send an empty value rather than authenticate.
    expect(shouldInjectApiAuthHeader({
      hostname: "0.0.0.0",
      unauthenticatedLoopbackListener: { enabled: true, port: 10200 },
    })).toBe(false);
  });

  test("a disabled listener leaves the wildcard behaviour intact", () => {
    expect(shouldInjectApiAuthHeader({
      hostname: "0.0.0.0",
      unauthenticatedLoopbackListener: { enabled: false },
    })).toBe(true);
  });

  test("the emitted block points at the loopback port and carries no auth header", () => {
    // shouldInjectApiAuthHeader alone does not prove the injected TOML is usable. Assert the
    // rendered block, because that is what a directly spawned app-server actually reads: a
    // base_url on the public port, or an env header it cannot populate, both reproduce #1102.
    const block = buildProviderTableBlock(10200, false, false, "0.0.0.0");
    expect(block).toContain('base_url = "http://127.0.0.1:10200/v1"');
    expect(block).not.toContain("env_http_headers");
    expect(block).not.toContain("env_key");
  });
});
