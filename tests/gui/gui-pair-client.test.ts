import { describe, expect, test } from "bun:test";
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
