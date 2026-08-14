import { describe, expect, test } from "bun:test";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
} from "../src/lib/local-management-attestation";
import {
  CODEX_RESET_CREDIT_CONSENT_ACCOUNT_ID_HEADER,
  CODEX_RESET_CREDIT_CONSENT_CAPABILITY_HEADER,
  CODEX_RESET_CREDIT_CONSENT_CAPABILITY_VERSION,
  CODEX_RESET_CREDIT_CONSENT_EXPIRES_AT_HEADER,
  CODEX_RESET_CREDIT_CONSENT_OPERATION_ID_HEADER,
  CODEX_RESET_CREDIT_CONSENT_PATH,
  verifyCodexResetCreditConsentCapability,
} from "../src/lib/codex-reset-credit-consent-contract";
import { requestBoundCodexResetCreditConsent } from "../src/cli/reset-credit-consent-client";
import type { LiveProxy } from "../src/server/proxy-liveness";

const secret = "A".repeat(43);
const nonce = "B".repeat(43);
const accountId = "pool-consent-test";
const operationId = "00112233-4455-4677-8899-aabbccddeeff";
const target: LiveProxy = {
  pid: 4242,
  port: 10100,
  hostname: "127.0.0.1",
  source: "runtime",
};

function proofResponse(
  init?: RequestInit,
  capabilityVersion = CODEX_RESET_CREDIT_CONSENT_CAPABILITY_VERSION,
): Response {
  const challenge = new Headers(init?.headers).get(LOCAL_ATTESTATION_CHALLENGE_HEADER)!;
  return Response.json({
    service: "opencodex",
    status: "ok",
    version: "test",
    uptime: 1,
    pid: target.pid,
    port: target.port,
    resetCreditConsentCapability: capabilityVersion,
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

describe("reset-credit consent client", () => {
  test("never sends a request when the target lacks process-bound runtime identity", async () => {
    let calls = 0;
    const result = await requestBoundCodexResetCreditConsent(accountId, operationId, {
      findLive: async () => ({ ...target, source: "config" }),
      fetchImpl: async () => { calls += 1; return new Response(); },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "unattested-target" });
    expect(calls).toBe(0);
  });

  test("requires listener proof before the consent POST", async () => {
    const requests: string[] = [];
    const result = await requestBoundCodexResetCreditConsent(accountId, operationId, {
      findLive: async () => target,
      readRuntime: () => ({ ...target, attestationSecret: secret }),
      createNonce: () => nonce,
      fetchImpl: async input => {
        requests.push(String(input));
        return Response.json({
          service: "opencodex",
          pid: target.pid,
          port: target.port,
          resetCreditConsentCapability: CODEX_RESET_CREDIT_CONSENT_CAPABILITY_VERSION,
        });
      },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "attestation" });
    expect(requests).toEqual(["http://127.0.0.1:10100/healthz"]);
  });

  test("rejects a proven listener with a stale consent capability version", async () => {
    const requests: string[] = [];
    const result = await requestBoundCodexResetCreditConsent(accountId, operationId, {
      findLive: async () => target,
      readRuntime: () => ({ ...target, attestationSecret: secret }),
      createNonce: () => nonce,
      fetchImpl: async (input, init) => {
        requests.push(String(input));
        return proofResponse(init, "v0");
      },
    });
    expect(result).toEqual({ kind: "unavailable", reason: "attestation" });
    expect(requests).toEqual(["http://127.0.0.1:10100/healthz"]);
  });

  test("sends only an operation-bound bodyless capability after proof", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const now = 1_800_000_000_000;
    const result = await requestBoundCodexResetCreditConsent(accountId, operationId, {
      findLive: async () => target,
      readRuntime: () => ({ ...target, attestationSecret: secret }),
      createNonce: () => nonce,
      now: () => now,
      fetchImpl: async (input, init) => {
        requests.push({ url: String(input), init });
        return requests.length === 1 ? proofResponse(init) : Response.json({ code: "reset" });
      },
    });

    expect(result.kind).toBe("response");
    if (result.kind !== "response") throw new Error("expected response");
    expect(await result.response.json()).toEqual({ code: "reset" });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe(`http://127.0.0.1:10100${CODEX_RESET_CREDIT_CONSENT_PATH}`);
    expect(requests[1]!.init?.method).toBe("POST");
    expect(requests[1]!.init?.body).toBeUndefined();
    const headers = new Headers(requests[1]!.init?.headers);
    expect(headers.get(CODEX_RESET_CREDIT_CONSENT_ACCOUNT_ID_HEADER)).toBe(accountId);
    expect(headers.get(CODEX_RESET_CREDIT_CONSENT_OPERATION_ID_HEADER)).toBe(operationId);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("x-opencodex-api-key")).toBe(false);
    expect(verifyCodexResetCreditConsentCapability(
      secret,
      nonce,
      "POST",
      CODEX_RESET_CREDIT_CONSENT_PATH,
      accountId,
      operationId,
      target.pid!,
      target.port,
      Number(headers.get(CODEX_RESET_CREDIT_CONSENT_EXPIRES_AT_HEADER)),
      headers.get(CODEX_RESET_CREDIT_CONSENT_CAPABILITY_HEADER),
      now,
    )).toBe(true);
  });

  test("allows the consent POST more time than the server consume budget", async () => {
    const timeoutCalls: number[] = [];
    const ioTimeoutCalls: number[] = [];
    const originalTimeout = AbortSignal.timeout;
    AbortSignal.timeout = ((ms: number) => {
      const signal = originalTimeout(ms);
      timeoutCalls.push(ms);
      return signal;
    }) as typeof AbortSignal.timeout;
    try {
      let calls = 0;
      const result = await requestBoundCodexResetCreditConsent(accountId, operationId, {
        findLive: async () => target,
        readRuntime: () => ({ ...target, attestationSecret: secret }),
        createNonce: () => nonce,
        directLocalHttpFetchImpl: async (_input, init, io) => {
          calls += 1;
          ioTimeoutCalls.push(io.timeoutMs ?? -1);
          return calls === 1 ? proofResponse(init) : Response.json({ code: "reset" });
        },
      });
      expect(result.kind).toBe("response");
    } finally {
      AbortSignal.timeout = originalTimeout;
    }
    expect(timeoutCalls).toEqual([10_000, 15_000]);
    expect(ioTimeoutCalls).toEqual([10_000, 15_000]);
  });

  test("stops when the protected runtime record changes after proof", async () => {
    let reads = 0;
    let calls = 0;
    const result = await requestBoundCodexResetCreditConsent(accountId, operationId, {
      findLive: async () => target,
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
