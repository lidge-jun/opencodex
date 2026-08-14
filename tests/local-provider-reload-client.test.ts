import { describe, expect, test } from "bun:test";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
} from "../src/lib/local-management-attestation";
import {
  LOCAL_PROVIDER_RELOAD_CAPABILITY_HEADER,
  LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION,
  LOCAL_PROVIDER_RELOAD_NAME_HEADER,
  LOCAL_PROVIDER_RELOAD_PATH,
  verifyLocalProviderReloadCapability,
} from "../src/lib/local-provider-reload-contract";
import { requestBoundLocalProviderReload } from "../src/server/local-provider-reload-client";
import type { LiveProxy } from "../src/server/proxy-liveness";

const secret = "A".repeat(43);
const nonce = "B".repeat(43);
const target: LiveProxy = {
  pid: 4242,
  port: 10100,
  hostname: "127.0.0.1",
  source: "runtime",
};

function proofResponse(init?: RequestInit): Response {
  const challenge = new Headers(init?.headers).get(LOCAL_ATTESTATION_CHALLENGE_HEADER)!;
  return Response.json({
    service: "opencodex",
    status: "ok",
    version: "test",
    uptime: 1,
    pid: target.pid,
    port: target.port,
    providerReloadCapability: LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION,
  }, {
    headers: {
      [LOCAL_ATTESTATION_PROOF_HEADER]: createLocalAttestationProof(
        secret,
        challenge,
        target.pid!,
        target.port,
      )!,
    },
  });
}

describe("local provider reload client", () => {
  test("never posts when the target lacks process-bound runtime identity", async () => {
    let calls = 0;
    const result = await requestBoundLocalProviderReload(
      { ...target, source: "config" },
      "xai",
      { fetchImpl: async () => { calls += 1; return new Response(); } },
    );
    expect(result).toEqual({ kind: "unavailable", reason: "unattested-target" });
    expect(calls).toBe(0);
  });

  test("requires listener proof before the reload POST", async () => {
    const requests: string[] = [];
    const result = await requestBoundLocalProviderReload(target, "xai", {
      readRuntime: () => ({ ...target, attestationSecret: secret }),
      createNonce: () => nonce,
      fetchImpl: async input => {
        requests.push(String(input));
        return Response.json({
          service: "opencodex",
          pid: target.pid,
          port: target.port,
          providerReloadCapability: LOCAL_PROVIDER_RELOAD_CAPABILITY_VERSION,
        });
      },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "attestation" });
    expect(requests).toEqual(["http://127.0.0.1:10100/healthz"]);
  });

  test("sends only a name-bound bodyless one-shot capability after proof", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const now = 1_800_000_000_000;
    const result = await requestBoundLocalProviderReload(target, "xai", {
      readRuntime: () => ({ ...target, attestationSecret: secret }),
      createNonce: () => nonce,
      now: () => now,
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return requests.length === 1 ? proofResponse(init) : Response.json({ success: true });
      },
    });

    expect(result).toEqual({ kind: "reloaded" });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe(`http://127.0.0.1:10100${LOCAL_PROVIDER_RELOAD_PATH}`);
    expect(requests[1]!.init?.method).toBe("POST");
    expect(requests[1]!.init?.body).toBeUndefined();
    const headers = new Headers(requests[1]!.init?.headers);
    expect(headers.get(LOCAL_PROVIDER_RELOAD_NAME_HEADER)).toBe("xai");
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-opencodex-api-key")).toBe(false);
    expect(verifyLocalProviderReloadCapability(
      secret,
      nonce,
      "POST",
      LOCAL_PROVIDER_RELOAD_PATH,
      "xai",
      target.pid!,
      target.port,
      Number(headers.get("x-opencodex-provider-reload-expires-at")),
      headers.get(LOCAL_PROVIDER_RELOAD_CAPABILITY_HEADER),
      now,
    )).toBe(true);
    expect(JSON.stringify(requests[1])).not.toContain("apiKey");
    expect(JSON.stringify(requests[1])).not.toContain("admin-secret");
  });

  test("stops when the protected runtime record changes after proof", async () => {
    let reads = 0;
    let calls = 0;
    const result = await requestBoundLocalProviderReload(target, "xai", {
      readRuntime: () => {
        reads += 1;
        return reads === 1
          ? { ...target, attestationSecret: secret }
          : { ...target, port: target.port + 1, attestationSecret: secret };
      },
      createNonce: () => nonce,
      fetchImpl: async (_input, init) => {
        calls += 1;
        return proofResponse(init);
      },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "runtime-mismatch" });
    expect(calls).toBe(1);
  });
});
