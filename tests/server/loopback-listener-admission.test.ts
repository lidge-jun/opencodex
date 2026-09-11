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
} from "../../src/server/auth-cors";
import { buildProviderTableBlock, shouldInjectApiAuthHeader } from "../../src/codex/inject";
import { effectiveLoopbackListenerPort, loopbackCompanionAllowed } from "../../src/codex/loopback-target";
import { validateConfigCandidate } from "../../src/config";
import type { OcxConfig } from "../../src/types";

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
    const source = readFileSync(new URL("../../src/server/index.ts", import.meta.url), "utf8");
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
      "await handleClaudeMessages(req, config, logCtx, { requestId, start, turnAdmissionLease, admission }, policy)",
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

describe("local client inference wires on the loopback listener (#4236)", () => {
  const source = readFileSync(new URL("../../src/server/index.ts", import.meta.url), "utf8");

  test("the allowlist admits all three wires as POST and nothing else about them", () => {
    // The allowlist is a closure inside startServer, so this reads the entry itself. The
    // integration file proves the socket behaviour; this pins the SHAPE, because "admit the
    // path" and "admit the path for any method" are one character apart.
    expect(source).toContain(
      'if (path === "/v1/messages" || path === "/v1/chat/completions") return req.method === "POST";',
    );
    // `count_tokens` completes the Anthropic wire: no provider quota, no stored credential, and
    // a count the caller could compute from the body it already holds. Withholding it only cost
    // Claude Code its server-side count; the boundary that matters is `/api/*` below.
    expect(source).toContain(
      'if (path === "/v1/messages/count_tokens") return req.method === "POST";',
    );
  });

  test("no /api route joins the allowlist", () => {
    // Management discovery is the other destination contract (authenticated ingress). A
    // reviewer condition on #4236: `/api/*` must never appear on this listener.
    const start = source.indexOf("function loopbackRouteAllowed(");
    const end = source.indexOf("function managementIngressRouteAllowed(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).not.toContain('"/api');
  });

  test("the chat wire finishes CORS with the receiving listener's policy", () => {
    // It is now served on the loopback listener, so the public config must not be the source
    // of its CORS headers — the same rule the Anthropic routes above already follow.
    const chatStart = source.indexOf('url.pathname === "/v1/chat/completions"');
    const nextRoute = source.indexOf("url.pathname === \"/v1/live\"", chatStart);
    expect(chatStart).toBeGreaterThan(-1);
    const branch = source.slice(chatStart, nextRoute);
    expect(branch).toContain("handleChatCompletions(req, config, logCtx");
    expect(branch).toContain("req,\n          policy,\n        ));");
    expect(branch).not.toContain("req,\n          config,\n        ));");
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

  test("an enabled listener without a port is rejected on a loopback bind", () => {
    // The port-less form means "same port, on 127.0.0.1". With the public listener already on
    // 127.0.0.1 there is no such address to take, and an OS-assigned port is not the fallback:
    // it would change across restarts and strand app-servers holding the previous base_url —
    // the symptom #1102 reported and we disproved for token rotation.
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

/**
 * The one-port hub (#4236). `{ enabled: true }` with no port binds 127.0.0.1:<proxy port>, so a
 * tailnet-bound hub serves remote clients on its public address and its own local processes on
 * loopback — including every integration that hardcodes `http://127.0.0.1:<proxy port>`.
 */
describe("loopback companion listener configuration", () => {
  const candidate = (overrides: Record<string, unknown> = {}) => ({
    port: 10100,
    providers: { openai: { adapter: "openai", baseUrl: "https://chatgpt.com/backend-api/codex" } },
    defaultProvider: "openai",
    unauthenticatedLoopbackListener: { enabled: true },
    ...overrides,
  });

  test("a port-less listener is accepted on a specific non-loopback bind and survives the parse", () => {
    for (const hostname of ["100.76.170.81", "192.168.1.40", "fd7a:115c:a1e0::1", "macmini.tail19a2d7.ts.net"]) {
      const result = validateConfigCandidate(candidate({ hostname }));
      expect({ hostname, ok: result.ok }).toEqual({ hostname, ok: true });
      // The absent port must SURVIVE. A schema that helpfully filled in the proxy port would
      // make the pair look like the #1102 collision on the next write.
      if (result.ok) {
        expect(result.config.unauthenticatedLoopbackListener).toEqual({ enabled: true });
      }
    }
  });

  test("a port-less listener is refused wherever the public listener already holds loopback", () => {
    // Wildcards included: 0.0.0.0 answers on 127.0.0.1 too, so the companion would collide
    // there just as surely as on an explicit loopback bind.
    for (const hostname of [
      undefined, "127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "00.0.0.000", "0", "*",
      "::", "[::]", "::0", "[::0]", "0::", "0:0:0:0:0:0:0:0",
    ]) {
      const result = validateConfigCandidate(candidate(hostname === undefined ? {} : { hostname }));
      expect({ hostname, ok: result.ok }).toEqual({ hostname, ok: false });
      if (!result.ok) {
        // The message has to name the collision AND both ways out, because an operator who
        // only hears "invalid" will try the other illegal shape next.
        expect(result.error).toContain("127.0.0.1:10100");
        expect(result.error).toContain("set a distinct unauthenticatedLoopbackListener.port");
        expect(result.error).toContain("remove the listener");
      }
    }
  });

  test("the proxy port named in the refusal is the configured one", () => {
    const result = validateConfigCandidate(candidate({ port: 8080, hostname: "0.0.0.0" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("127.0.0.1:8080");
  });

  test("pointing hostname back at loopback is refused by the same check, not by the next start", () => {
    // `ocx config set hostname 127.0.0.1` on a host whose listener is already the companion
    // form writes a candidate carrying BOTH keys. Validating only the key being written would
    // let this through and turn the next `ocx start` into an EADDRINUSE rollback.
    const enabled = validateConfigCandidate(candidate({ hostname: "100.76.170.81" }));
    expect(enabled.ok).toBe(true);
    const reverted = validateConfigCandidate(candidate({ hostname: "127.0.0.1" }));
    expect(reverted.ok).toBe(false);
    if (!reverted.ok) expect(reverted.error).toContain("127.0.0.1:10100");
  });

  test("an explicit port is still required to differ, and still wins over the companion form", () => {
    const collision = validateConfigCandidate(candidate({
      hostname: "100.76.170.81",
      unauthenticatedLoopbackListener: { enabled: true, port: 10100 },
    }));
    expect(collision.ok).toBe(false);
    if (!collision.ok) expect(collision.error).toContain("must differ from the proxy port");

    const ported = validateConfigCandidate(candidate({
      hostname: "100.76.170.81",
      unauthenticatedLoopbackListener: { enabled: true, port: 10104 },
    }));
    expect(ported.ok).toBe(true);
  });

  test("effectiveLoopbackListenerPort is the single answer to \"where do local callers dial\"", () => {
    expect(effectiveLoopbackListenerPort({ unauthenticatedLoopbackListener: { enabled: true } }, 10100)).toBe(10100);
    expect(effectiveLoopbackListenerPort({ unauthenticatedLoopbackListener: { enabled: true, port: 10104 } }, 10100)).toBe(10104);
    expect(effectiveLoopbackListenerPort({ unauthenticatedLoopbackListener: { enabled: false } }, 10100)).toBeNull();
    expect(effectiveLoopbackListenerPort({}, 10100)).toBeNull();
    expect(effectiveLoopbackListenerPort(undefined, 10100)).toBeNull();
  });

  test("loopbackCompanionAllowed is the bind-scope half of that decision", () => {
    for (const hostname of ["100.76.170.81", "10.0.0.5", "hub.example.test"]) {
      expect({ hostname, allowed: loopbackCompanionAllowed(hostname) }).toEqual({ hostname, allowed: true });
    }
    for (const hostname of [undefined, "", "localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0", "::", "[::]", "*"]) {
      expect({ hostname, allowed: loopbackCompanionAllowed(hostname) }).toEqual({ hostname, allowed: false });
    }
  });
});

describe("hub management ingress configuration", () => {
  const candidate = (overrides: Record<string, unknown> = {}) => ({
    port: 10100,
    runtimeRole: "hub",
    hub: { managementIngress: { enabled: true, port: 10101 } },
    providers: { openai: { adapter: "openai", baseUrl: "https://chatgpt.com/backend-api/codex" } },
    defaultProvider: "openai",
    ...overrides,
  });

  test("missing and disabled ingress preserve the no-listener default", () => {
    const missing = validateConfigCandidate(candidate({ hub: {} }));
    expect(missing.ok).toBe(true);
    if (missing.ok) expect(missing.config.hub?.managementIngress).toBeUndefined();

    const disabled = validateConfigCandidate(candidate({ hub: { managementIngress: { enabled: false } } }));
    expect(disabled.ok).toBe(true);
    if (disabled.ok) expect(disabled.config.hub?.managementIngress).toEqual({ enabled: false });
  });

  test("enabled ingress requires the hub role", () => {
    // `client` carries a complete connection block so the ingress rule is what refuses it.
    // Without one it is refused earlier, by the rule that a client role needs that block,
    // and asserting the ingress wording would be asserting an ordering these two
    // independent rules never promise.
    for (const runtimeRole of [undefined, "standalone", "client"] as const) {
      const result = validateConfigCandidate(candidate({
        runtimeRole,
        ...(runtimeRole === "client" ? {
          client: {
            serverUrl: "https://hub.example.test",
            managementUrl: "https://hub.example.test",
            managementTransport: "direct",
            selectedClients: ["codex"],
            tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
            apiKeyId: "client-key-1",
            tokenFingerprint: "a".repeat(64),
            protocolVersion: 1,
            connectedAt: "2026-08-28T00:00:00.000Z",
          },
        } : {}),
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("requires runtimeRole hub");
    }
  });

  test("enabled ingress rejects public and unauthenticated-loopback port collisions", () => {
    const publicCollision = validateConfigCandidate(candidate({
      hub: { managementIngress: { enabled: true, port: 10100 } },
    }));
    expect(publicCollision.ok).toBe(false);
    if (!publicCollision.ok) expect(publicCollision.error).toContain("must differ from the proxy port");

    const loopbackCollision = validateConfigCandidate(candidate({
      unauthenticatedLoopbackListener: { enabled: true, port: 10101 },
    }));
    expect(loopbackCollision.ok).toBe(false);
    if (!loopbackCollision.ok) expect(loopbackCollision.error).toContain("unauthenticatedLoopbackListener.port");
  });

  test("a valid hub ingress survives strict parsing", () => {
    const result = validateConfigCandidate(candidate());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.config.hub?.managementIngress).toEqual({ enabled: true, port: 10101 });
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
