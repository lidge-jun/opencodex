import { describe, expect, test } from "bun:test";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
  createLocalAttestationSecret,
} from "../src/lib/local-management-attestation";
import {
  SYSTEM_RESTART_CAPABILITY_HEADER,
  SYSTEM_RESTART_CAPABILITY_VERSION,
  SYSTEM_RESTART_EXPECTED_PID_HEADER,
  SYSTEM_RESTART_METHOD,
  SYSTEM_RESTART_NONCE_HEADER,
  SYSTEM_RESTART_PATH,
  verifySystemRestartCapability,
} from "../src/lib/system-restart-contract";
import { requestBoundSystemRestart } from "../src/cli/system-restart-client";
import type { LiveProxy } from "../src/server/proxy-liveness";

const target: LiveProxy = {
  pid: 4242,
  port: 10100,
  hostname: "127.0.0.1",
  source: "runtime",
};

function successfulDeps() {
  const secret = createLocalAttestationSecret();
  const challenge = "A".repeat(43);
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith("/healthz")) {
      return successfulDepsResponse(secret, challenge);
    }
    return new Response(JSON.stringify({ success: true }), { status: 202 });
  }) as typeof fetch;

  return {
    secret,
    challenge,
    requests,
    deps: {
      fetchImpl,
      readRuntime: () => ({
        pid: target.pid!,
        port: target.port,
        hostname: target.hostname,
        attestationSecret: secret,
      }),
      findLive: async () => target,
      createChallenge: () => challenge,
      now: () => 1_000,
    },
  };
}

describe("bound system restart client", () => {
  test("rejects an unattested discovery result without network access", async () => {
    let fetches = 0;
    const outcome = await requestBoundSystemRestart(
      { pid: null, port: 10100, source: "config" },
      10_000,
      { fetchImpl: (async () => { fetches += 1; return new Response(); }) as typeof fetch },
    );
    expect(outcome.accepted).toBe(false);
    expect(outcome.accepted ? null : outcome.uncertain).toBe(false);
    expect(fetches).toBe(0);
  });

  test("rejects missing runtime proof state before fetching", async () => {
    let fetches = 0;
    const fetchImpl = (async () => { fetches += 1; return new Response(); }) as typeof fetch;
    const noRuntime = await requestBoundSystemRestart(target, 10_000, {
      fetchImpl,
      readRuntime: () => null,
    });
    expect(noRuntime.accepted).toBe(false);
    expect(fetches).toBe(0);
  });

  test("rejects stale runtime PID or port state before fetching", async () => {
    for (const runtime of [
      { ...target, pid: target.pid! + 1 },
      { ...target, port: target.port + 1 },
    ]) {
      let fetches = 0;
      const outcome = await requestBoundSystemRestart(target, 10_000, {
        fetchImpl: (async () => { fetches += 1; return new Response(); }) as typeof fetch,
        readRuntime: () => ({
          pid: runtime.pid!,
          port: runtime.port,
          hostname: runtime.hostname,
          attestationSecret: createLocalAttestationSecret(),
        }),
      });
      expect(outcome.accepted).toBe(false);
      expect(fetches).toBe(0);
    }
  });

  test("does not send the admin token when attestation fails", async () => {
    const setup = successfulDeps();
    setup.deps.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      setup.requests.push({ url: String(input), init });
      return new Response(JSON.stringify({
        status: "ok",
        service: "opencodex",
        version: "test",
        uptime: 1,
        pid: target.pid,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    const outcome = await requestBoundSystemRestart(target, 10_000, setup.deps);
    expect(outcome.accepted).toBe(false);
    expect(setup.requests).toHaveLength(1);
    const headers = new Headers(setup.requests[0]!.init?.headers);
    expect(headers.has("X-OpenCodex-API-Key")).toBe(false);
  });

  test("refuses a pre-update proxy before POST instead of weakening PID-bound auth", async () => {
    const setup = successfulDeps();
    setup.deps.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      setup.requests.push({ url, init });
      if (url.endsWith("/healthz")) {
        const response = successfulDepsResponse(setup.secret, setup.challenge);
        const body = await response.json() as Record<string, unknown>;
        delete body.restartCapability;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: response.headers,
        });
      }
      throw new Error("POST must not be attempted");
    }) as typeof fetch;

    const outcome = await requestBoundSystemRestart(target, 10_000, setup.deps);
    expect(outcome).toMatchObject({ accepted: false, uncertain: false });
    expect(outcome.accepted ? "" : (outcome.error as Error).message)
      .toBe("restart_capability_unsupported");
    expect(setup.requests).toHaveLength(1);
  });

  test("refuses to POST when the live target changes after attestation", async () => {
    const setup = successfulDeps();
    setup.deps.findLive = async () => ({ ...target, pid: 4343 });
    const outcome = await requestBoundSystemRestart(target, 10_000, setup.deps);
    expect(outcome.accepted).toBe(false);
    expect(setup.requests).toHaveLength(1);
  });

  test("posts once with a process-scoped capability and no reusable admin token", async () => {
    const setup = successfulDeps();
    const outcome = await requestBoundSystemRestart(target, 10_000, setup.deps);
    expect(outcome).toEqual({ accepted: true });
    expect(setup.requests).toHaveLength(2);

    const proofHeaders = new Headers(setup.requests[0]!.init?.headers);
    expect(proofHeaders.get(LOCAL_ATTESTATION_CHALLENGE_HEADER)).toBe(setup.challenge);
    expect(proofHeaders.has("X-OpenCodex-API-Key")).toBe(false);

    const restart = setup.requests[1]!;
    expect(restart.url).toBe("http://127.0.0.1:10100/api/system/restart");
    expect(restart.init?.method).toBe("POST");
    const restartHeaders = new Headers(restart.init?.headers);
    expect(restartHeaders.has("X-OpenCodex-API-Key")).toBe(false);
    expect(restartHeaders.get(SYSTEM_RESTART_EXPECTED_PID_HEADER)).toBe(String(target.pid));
    expect(restartHeaders.get(SYSTEM_RESTART_NONCE_HEADER)).toBe(setup.challenge);
    expect(verifySystemRestartCapability(
      setup.secret,
      restartHeaders.get(SYSTEM_RESTART_NONCE_HEADER),
      SYSTEM_RESTART_METHOD,
      SYSTEM_RESTART_PATH,
      target.pid!,
      target.port,
      restartHeaders.get(SYSTEM_RESTART_CAPABILITY_HEADER),
    )).toBe(true);
  });

  test("forwards the absolute deadline into the final target recheck", async () => {
    const setup = successfulDeps();
    let observedDeadline: number | undefined;
    setup.deps.findLive = async io => {
      observedDeadline = io.deadlineAt;
      return target;
    };
    expect(await requestBoundSystemRestart(target, 10_000, setup.deps)).toEqual({ accepted: true });
    expect(observedDeadline).toBe(10_000);
  });

  test("treats an HTTP rejection as definite and a POST transport loss as uncertain", async () => {
    const rejected = successfulDeps();
    rejected.deps.fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/healthz")) return successfulDepsResponse(rejected.secret, rejected.challenge);
      rejected.requests.push({ url, init });
      return new Response("stale", { status: 409 });
    }) as typeof fetch;
    const rejectedOutcome = await requestBoundSystemRestart(target, 10_000, rejected.deps);
    expect(rejectedOutcome.accepted).toBe(false);
    expect(rejectedOutcome.accepted ? null : rejectedOutcome.uncertain).toBe(false);

    const uncertain = successfulDeps();
    uncertain.deps.fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/healthz")) return successfulDepsResponse(uncertain.secret, uncertain.challenge);
      throw new Error("connection closed");
    }) as typeof fetch;
    const uncertainOutcome = await requestBoundSystemRestart(target, 10_000, uncertain.deps);
    expect(uncertainOutcome.accepted).toBe(false);
    expect(uncertainOutcome.accepted ? null : uncertainOutcome.uncertain).toBe(true);
  });

  test("treats an unreachable attestation probe as definite and never posts", async () => {
    const setup = successfulDeps();
    setup.deps.fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith("/healthz")) throw new Error("connection refused");
      throw new Error("POST must not be attempted");
    }) as typeof fetch;
    const outcome = await requestBoundSystemRestart(target, 10_000, setup.deps);
    expect(outcome).toMatchObject({ accepted: false, uncertain: false });
    expect(outcome.accepted ? "" : (outcome.error as Error).message)
      .toBe("restart_attestation_unreachable");
  });

  test("enforces the absolute deadline before any fetch", async () => {
    const setup = successfulDeps();
    setup.deps.now = () => 10_001;
    const outcome = await requestBoundSystemRestart(target, 10_000, setup.deps);
    expect(outcome.accepted).toBe(false);
    expect(setup.requests).toHaveLength(0);
  });
});

function successfulDepsResponse(secret: string, challenge: string): Response {
  const proof = createLocalAttestationProof(secret, challenge, target.pid!, target.port);
  return new Response(JSON.stringify({
    status: "ok",
    service: "opencodex",
    version: "test",
    uptime: 1,
    pid: target.pid,
    port: target.port,
    restartCapability: SYSTEM_RESTART_CAPABILITY_VERSION,
  }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      [LOCAL_ATTESTATION_PROOF_HEADER]: proof!,
    },
  });
}
