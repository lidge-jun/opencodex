import type { OcxConfig } from "../../src/types";
import { runGuiCommand } from "../../src/cli/gui";
import { createGuiPairingGrant, consumeGuiPairingGrant, issueGuiSession, authorizeGuiSessionRequest } from "../../src/server/gui-session";
import { createManagementSessionControl, managementPrincipal, managementSessionIssuance, requireManagementAuth, type ManagementAuthState } from "../../src/server/management-auth";
import { handleLinkRoutes, type LinkRouteState } from "../../src/server/management/link-routes";
import type { ManagementContext } from "../../src/server/management/context";
import { describe, expect, spyOn, test } from "bun:test";
import { requestBoundGuiPairingGrant } from "../../src/cli/gui-pair-client";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
} from "../../src/lib/local-management-attestation";
import {
  GUI_PAIR_BROWSER_ORIGIN_HEADER,
  GUI_PAIR_CAPABILITY_HEADER,
  GUI_PAIR_CAPABILITY_VERSION,
  GUI_PAIR_PATH,
  verifyGuiPairCapability,
} from "../../src/lib/gui-pair-capability";
import type { LiveProxy } from "../../src/server/proxy-liveness";

const secret = "A".repeat(43);
const nonce = "B".repeat(43);
const browserOrigin = "https://dashboard.example.test";
const target: LiveProxy = { pid: 4242, port: 10100, hostname: "127.0.0.1", source: "runtime" };

function proofResponse(init?: RequestInit, capabilityVersion: unknown = GUI_PAIR_CAPABILITY_VERSION): Response {
  const challenge = new Headers(init?.headers).get(LOCAL_ATTESTATION_CHALLENGE_HEADER)!;
  return Response.json({
    service: "opencodex",
    status: "ok",
    version: "test",
    uptime: 1,
    pid: target.pid,
    port: target.port,
    guiPairCapability: capabilityVersion,
  }, {
    headers: {
      [LOCAL_ATTESTATION_PROOF_HEADER]: createLocalAttestationProof(secret, challenge, target.pid!, target.port)!,
    },
  });
}

describe("GUI pairing client", () => {
  test("refuses unattested targets and unsupported capability versions before POST", async () => {
    let calls = 0;
    expect(await requestBoundGuiPairingGrant(
      { ...target, source: "config" }, browserOrigin,
      { fetchImpl: async () => { calls += 1; return new Response(); } },
    )).toEqual({ kind: "unavailable", reason: "unattested-target" });
    expect(calls).toBe(0);

    const result = await requestBoundGuiPairingGrant(target, browserOrigin, {
      readRuntime: () => ({ ...target, attestationSecret: secret }),
      createChallenge: () => nonce,
      fetchImpl: async (_input, init) => {
        calls += 1;
        return proofResponse(init, "v0");
      },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "capability" });
    expect(calls).toBe(1);
  });

  test("rechecks PID and port after proof", async () => {
    let reads = 0;
    let calls = 0;
    const result = await requestBoundGuiPairingGrant(target, browserOrigin, {
      readRuntime: () => {
        reads += 1;
        return reads === 1
          ? { ...target, attestationSecret: secret }
          : { ...target, port: target.port + 1, attestationSecret: secret };
      },
      createChallenge: () => nonce,
      fetchImpl: async (_input, init) => {
        calls += 1;
        return proofResponse(init);
      },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "runtime-mismatch" });
    expect(calls).toBe(1);
  });

  test("stops after one failed attestation or transport attempt", async () => {
    let calls = 0;
    const unattested = await requestBoundGuiPairingGrant(target, browserOrigin, {
      readRuntime: () => ({ ...target, attestationSecret: secret }),
      createChallenge: () => nonce,
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ service: "opencodex", pid: target.pid, port: target.port });
      },
    });
    expect(unattested).toEqual({ kind: "unavailable", reason: "attestation" });
    expect(calls).toBe(1);

    calls = 0;
    const transport = await requestBoundGuiPairingGrant(target, browserOrigin, {
      readRuntime: () => ({ ...target, attestationSecret: secret }),
      createChallenge: () => nonce,
      fetchImpl: async () => {
        calls += 1;
        throw new Error("response body contains secret-that-must-be-redacted");
      },
    });
    expect(transport).toEqual({ kind: "unavailable", reason: "transport" });
    expect(JSON.stringify(transport)).not.toContain("secret-that-must-be-redacted");
    expect(calls).toBe(1);
  });

  test("sends one bodyless origin-bound capability and redacts rejected bodies", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const now = 1_800_000_000_000;
    const result = await requestBoundGuiPairingGrant(target, browserOrigin, {
      readRuntime: () => ({ ...target, attestationSecret: secret }),
      createChallenge: () => nonce,
      now: () => now,
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        if (requests.length === 1) return proofResponse(init);
        return Response.json({
          grant: `ocx_pair_${"C".repeat(43)}`,
          browserOrigin,
          serverOrigin: "https://hub.example.test",
          expiresAt: now + 300_000,
        });
      },
    });
    expect(result).toEqual({
      kind: "created",
      grant: `ocx_pair_${"C".repeat(43)}`,
      browserOrigin,
      serverOrigin: "https://hub.example.test",
      expiresAt: now + 300_000,
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe(`http://127.0.0.1:10100${GUI_PAIR_PATH}`);
    expect(requests[1]!.init?.body).toBeUndefined();
    const headers = new Headers(requests[1]!.init?.headers);
    expect(headers.get(GUI_PAIR_BROWSER_ORIGIN_HEADER)).toBe(browserOrigin);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-opencodex-api-key")).toBe(false);
    expect(verifyGuiPairCapability(
      secret,
      nonce,
      "POST",
      GUI_PAIR_PATH,
      browserOrigin,
      target.pid!,
      target.port,
      Number(headers.get("x-opencodex-gui-pair-expires-at")),
      headers.get(GUI_PAIR_CAPABILITY_HEADER),
      now,
    )).toBe(true);

    const rejected = await requestBoundGuiPairingGrant(target, browserOrigin, {
      readRuntime: () => ({ ...target, attestationSecret: secret }),
      createChallenge: () => nonce,
      fetchImpl: async (_input, init) => init?.method
        ? Response.json({ grant: "secret-must-not-surface" }, { status: 403 })
        : proofResponse(init),
    });
    expect(rejected).toEqual({ kind: "unavailable", reason: "rejected" });
    expect(JSON.stringify(rejected)).not.toContain("secret-must-not-surface");
  });
});

const localConfig: OcxConfig = { port: 10100, hostname: "127.0.0.1", runtimeRole: "standalone", defaultProvider: "test", providers: {} };
const localOrigin = "http://127.0.0.1:10100";
function pairingState(): Extract<ManagementAuthState, { available: true }> {
  return { available: true, token: `ocx_admin_${"D".repeat(43)}`, source: "environment", sessions: new Map(), pairingGrants: new Map() };
}
function pairingRequest(origin = localOrigin, extra: Record<string, string> = {}): Request {
  return new Request(`${origin}/opencodex-session`, { method: "POST", headers: { Host: new URL(origin).host, Origin: origin, ...extra } });
}
const localAttempt = { ingress: "public" as const, peerAddress: "127.0.0.1", tailscaleUser: null, browserOrigin: localOrigin };

// PURE_PAIRING_REGRESSIONS_BEGIN

describe("standalone one-use pairing boundaries", () => {
  test("mint, redeem once, enforce CSRF and expire without sliding", () => {
    const state = pairingState(), now = Date.now();
    const created = createGuiPairingGrant(localOrigin, localConfig, state, now);
    expect(created.serverOrigin).toBe(localOrigin);
    expect(state.pairingGrants.has(created.grant)).toBe(false);
    const session = consumeGuiPairingGrant(pairingRequest(), { grant: created.grant }, localConfig, state, now, localAttempt);
    expect(session).toMatchObject({ issuance: "pairing", serverOrigin: localOrigin, browserOrigin: localOrigin });
    if (!session || "allowed" in session) throw new Error("expected a real redeemed session");
    expect(consumeGuiPairingGrant(pairingRequest(), { grant: created.grant }, localConfig, state, now, localAttempt)).toBeNull();
    const request = (csrf?: string) => new Request(`${localOrigin}/api/link/join`, { method: "POST", headers: {
      Host: "127.0.0.1:10100", Origin: localOrigin, "x-opencodex-gui-origin": localOrigin,
      "x-opencodex-api-key": session.token, ...(csrf ? { "x-opencodex-csrf-token": csrf } : {}),
    } });
    expect(authorizeGuiSessionRequest(request(), localConfig, state, now).ok).toBe(false);
    expect(authorizeGuiSessionRequest(request(session.csrfToken), localConfig, state, now + 1000).ok).toBe(true);
    expect(state.sessions.get(session.token)?.expiresAt).toBe(now + 300000);
    expect(authorizeGuiSessionRequest(request(session.csrfToken), localConfig, state, now + 300000).ok).toBe(false);
  });
  test("wrong address, alternate credentials, missing peer and nonlocal peer cannot burn a valid code", () => {
    const state = pairingState(), now = Date.now();
    const created = createGuiPairingGrant(localOrigin, localConfig, state, now);
    for (const peerAddress of [null, "", "192.0.2.3"]) {
      expect(consumeGuiPairingGrant(pairingRequest(), { grant: created.grant }, localConfig, state, now,
        { ...localAttempt, peerAddress })).toBeNull();
    }
    expect(consumeGuiPairingGrant(pairingRequest(), { grant: created.grant }, localConfig, state, now)).toBeNull();
    expect(consumeGuiPairingGrant(pairingRequest("http://127.0.0.1:10101"), { grant: created.grant }, localConfig, state, now, localAttempt)).toBeNull();
    expect(consumeGuiPairingGrant(pairingRequest(localOrigin, { Origin: "https://foreign.example.test" }), { grant: created.grant }, localConfig, state, now, localAttempt)).toBeNull();
    for (const name of ["authorization", "x-opencodex-api-key", "x-api-key"]) {
      expect(consumeGuiPairingGrant(pairingRequest(localOrigin, { [name]: "old-credential" }), { grant: created.grant }, localConfig, state, now, localAttempt)).toBeNull();
    }
    expect(state.pairingGrants.size).toBe(1);
    expect(consumeGuiPairingGrant(pairingRequest(), { grant: created.grant }, localConfig, state, now,
      { ...localAttempt, peerAddress: "::ffff:127.0.0.1" })).toMatchObject({ issuance: "pairing" });
  });
  test("CORS and hub hints cannot widen the standalone mint", () => {
    for (const origin of ["http://localhost:10100", "http://127.0.0.1:10101", "https://127.0.0.1:10100", "https://foreign.example.test", "http://127.0.0.1:10100/"]) {
      const state = pairingState();
      expect(() => createGuiPairingGrant(origin, { ...localConfig, corsAllowOrigins: [origin], hub: { managementPublicOrigin: origin } }, state)).toThrow();
      expect(state.pairingGrants.size).toBe(0);
    }
    for (const config of [{ ...localConfig, hostname: "0.0.0.0" }, { ...localConfig, hostname: "localhost" },
      { ...localConfig, runtimeRole: "client" as const }, { ...localConfig, port: 0 }]) {
      expect(() => createGuiPairingGrant(localOrigin, config, pairingState())).toThrow();
    }
  });
  test("default standalone and IPv6 use the same exact-origin contract", () => {
    for (const [config, origin, peerAddress] of [
      [{ ...localConfig, runtimeRole: undefined, hostname: undefined }, localOrigin, "127.0.0.1"],
      [{ ...localConfig, hostname: "::1" }, "http://[::1]:10100", "::1"],
    ] as const) {
      const state = pairingState(), created = createGuiPairingGrant(origin, config, state);
      expect(consumeGuiPairingGrant(pairingRequest(origin), { grant: created.grant }, config, state, Date.now(),
        { ...localAttempt, browserOrigin: origin, peerAddress })).toMatchObject({ issuance: "pairing" });
    }
  });
  test("role changes cannot convert grants and invalidate local paired sessions", () => {
    const state = pairingState(), now = Date.now();
    const hub = { ...localConfig, runtimeRole: "hub" as const, hub: { managementPublicOrigin: localOrigin } };
    const localGrant = createGuiPairingGrant(localOrigin, localConfig, state, now);
    expect(consumeGuiPairingGrant(pairingRequest(), { grant: localGrant.grant }, hub, state, now, localAttempt)).toBeNull();
    const hubGrant = createGuiPairingGrant(localOrigin, hub, state, now);
    expect(consumeGuiPairingGrant(pairingRequest(), { grant: hubGrant.grant }, localConfig, state, now, localAttempt)).toBeNull();
    const session = consumeGuiPairingGrant(pairingRequest(), { grant: localGrant.grant }, localConfig, state, now, localAttempt);
    if (!session || "allowed" in session) throw new Error("expected local pairing");
    const request = new Request(`${localOrigin}/api/link/status`, { headers: { Host: "127.0.0.1:10100",
      "x-opencodex-api-key": session.token, "x-opencodex-gui-origin": localOrigin } });
    expect(authorizeGuiSessionRequest(request, hub, state, now).ok).toBe(false);
    expect(state.sessions.has(session.token)).toBe(false);
  });
  test("remote hub pairing remains origin-bound with its existing lifetime", () => {
    const state = pairingState(), now = Date.now(), origin = "https://hub.example.test";
    const config: OcxConfig = { ...localConfig, runtimeRole: "hub", hostname: "0.0.0.0", hub: { managementPublicOrigin: origin } };
    const created = createGuiPairingGrant(origin, config, state, now);
    const session = consumeGuiPairingGrant(pairingRequest(origin), { grant: created.grant }, config, state, now);
    expect(session).toMatchObject({ issuance: "pairing", expiresAt: now + 12 * 60 * 60000 });
  });
  test("ordinary local bootstrap remains unpaired", () => {
    const state = pairingState();
    const session = issueGuiSession(new Request(`${localOrigin}/opencodex-session`, {
      headers: { Host: "127.0.0.1:10100", Origin: localOrigin },
    }), localConfig, state);
    expect(session).toMatchObject({ issuance: "loopback" });
    expect(state.pairingGrants.size).toBe(0);
  });
});

// PURE_PAIRING_REGRESSIONS_END

test("operator CLI proof -> one-use grant -> real paired session -> guarded join, without an isPaired stub", async () => {
  const state = pairingState(), output: string[] = [];
  const log = spyOn(console, "log").mockImplementation(value => { output.push(String(value)); });
  const local = { attestationSecret: secret, pid: target.pid!, port: target.port };
  let joins = 0;
  try {
    const result = await runGuiCommand(["pair", "--origin", localOrigin, "--json"], {
      loadConfig: () => localConfig, findLiveProxy: async () => target, openDefaultGui: async () => 0,
      requestPairingGrant: (runtime, origin) => requestBoundGuiPairingGrant(runtime, origin, {
        readRuntime: () => ({ ...target, attestationSecret: secret }),
        fetchImpl: (async (input, init) => {
          if (!init?.method) return proofResponse(init);
          const req = new Request(input, init);
          expect(requireManagementAuth(req, state, localConfig, local)).toBeNull();
          expect(managementPrincipal(req, state, localConfig, local)).toBe("gui-pair-capability");
          return Response.json(createGuiPairingGrant(req.headers.get(GUI_PAIR_BROWSER_ORIGIN_HEADER)!, localConfig, state), { status: 201 });
        }) as typeof fetch,
      }),
    });
    expect(result).toBe(0); expect(output).toHaveLength(1);
    const grant = JSON.parse(output[0]!).grant;
    const paired = consumeGuiPairingGrant(pairingRequest(), { grant }, localConfig, state, Date.now(), localAttempt);
    if (!paired || "allowed" in paired) throw new Error("operator grant was not redeemed");
    const ordinary = issueGuiSession(new Request(`${localOrigin}/`, { headers: { Host: "127.0.0.1:10100" } }), localConfig, state)!;
    const sessionControl = createManagementSessionControl(state);
    const routeState: LinkRouteState = { pendingHosts: new Map(), confirmedHosts: new Map([["home", {
      alias: "home", fingerprint: `SHA256:${"a".repeat(32)}`, keyType: "ed25519", knownHostLine: "home ssh-ed25519 AAAA", probedAt: Date.now(), ocxVersion: "2.71.0",
    }]]), supervisor: {} as LinkRouteState["supervisor"], listener: {} as LinkRouteState["listener"] };
    for (const [session, expected] of [[ordinary, 403], [paired, 202]] as const) {
      const req = new Request(`${localOrigin}/api/link/join`, { method: "POST", headers: {
        Host: "127.0.0.1:10100", Origin: localOrigin, "content-type": "application/json", "x-opencodex-api-key": session.token,
        "x-opencodex-gui-origin": localOrigin, "x-opencodex-csrf-token": session.csrfToken,
      }, body: JSON.stringify({ alias: "home" }) });
      expect(requireManagementAuth(req, state, localConfig)).toBeNull();
      const ctx: ManagementContext = { req, url: new URL(req.url), config: localConfig, version: "test",
        principal: managementPrincipal(req, state, localConfig) ?? undefined, sessionControl,
        trustedLoopbackIngress: true, guiSessionIssuance: managementSessionIssuance(req, state),
        deps: { liveListenPort: () => localConfig.port, linkKnownHostsPath: () => "/unused/known_hosts",
          sshRunner: { run: async () => { throw new Error("unexpected SSH"); } } as never, ...{ joinHome: async () => { joins++; return { linkId: "lnk_0123456789abcdef", apiKeyId: "link-key-1" }; } } },
        convergeCodexCatalog: async () => ({ status: "unchanged" } as never), syncClaudeAgentDefsBestEffort: async () => {},
      };
      expect((await handleLinkRoutes(ctx, routeState))?.status).toBe(expected);
    }
    expect(joins).toBe(1);
  } finally { log.mockRestore(); }
});

test("standalone CLI rejects actual runtime address/port mismatch before requesting a grant", async () => {
  let requests = 0;
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    for (const runtime of [{ ...target, port: 10101 }, { ...target, hostname: "0.0.0.0" }]) {
      expect(await runGuiCommand(["pair", "--origin", localOrigin], { loadConfig: () => localConfig,
        findLiveProxy: async () => runtime, openDefaultGui: async () => 0,
        requestPairingGrant: async () => { requests++; return { kind: "unavailable", reason: "rejected" }; },
      })).toBe(1);
    }
    expect(requests).toBe(0);
  } finally { log.mockRestore(); }
});


describe("CLI local intent lifecycle", () => {
  const common = {
    readRuntime: () => ({ ...target, attestationSecret: secret }),
    createChallenge: () => nonce,
  };
  test("an older runtime cannot downgrade the new pairing contract", async () => {
    let calls = 0;
    const result = await requestBoundGuiPairingGrant(target, browserOrigin, {
      ...common, fetchImpl: async (_url, init) => { calls++; return proofResponse(init, "v1"); },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "capability" });
    expect(calls).toBe(1);
  });
  test("intent creation failure stops before POST and is sanitized", async () => {
    let calls = 0;
    const result = await requestBoundGuiPairingGrant(target, browserOrigin, {
      ...common, createIntent: () => { throw new Error("private-path-must-not-leak"); },
      fetchImpl: async (_url, init) => { calls++; return proofResponse(init); },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "local-intent" });
    expect(calls).toBe(1);
  });
  for (const outcome of ["transport", "rejected", "malformed", "created"] as const) {
    test(`disposes local intent after ${outcome}`, async () => {
      let calls = 0, disposed = 0;
      const result = await requestBoundGuiPairingGrant(target, browserOrigin, {
        ...common,
        createIntent: () => ({ proof: "D".repeat(43), dispose: () => { disposed++; } }),
        fetchImpl: async (_url, init) => {
          calls++;
          if (calls === 1) return proofResponse(init);
          expect(new Headers(init?.headers).get("x-opencodex-gui-pair-intent") === "D".repeat(43)).toBe(true);
          if (outcome === "transport") throw new Error("private transport diagnostic");
          if (outcome === "rejected") return new Response("private rejection", { status: 403 });
          if (outcome === "malformed") return new Response("not JSON");
          return Response.json({ grant: `ocx_pair_${"C".repeat(43)}`, browserOrigin,
            serverOrigin: "https://hub.example.test", expiresAt: Date.now() + 300_000 });
        },
      });
      expect(disposed).toBe(1); expect(calls).toBe(2);
      expect(result.kind).toBe(outcome === "created" ? "created" : "unavailable");
    });
  }
  test("the explicit Hub path never publishes a local intent", async () => {
    let calls = 0;
    const result = await requestBoundGuiPairingGrant(target, browserOrigin, {
      ...common, requireLocalIntent: false,
      createIntent: () => { throw new Error("hub must not publish standalone intent"); },
      fetchImpl: async (_url, init) => {
        calls++;
        if (calls === 1) return proofResponse(init);
        expect(new Headers(init?.headers).has("x-opencodex-gui-pair-intent")).toBe(false);
        return Response.json({ grant: `ocx_pair_${"C".repeat(43)}`, browserOrigin,
          serverOrigin: "https://hub.example.test", expiresAt: Date.now() + 300_000 });
      },
    });
    expect(result.kind).toBe("created"); expect(calls).toBe(2);
  });
});
