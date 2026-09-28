/**
 * #5496: a proxy fenced by the package-tree guard answers /healthz with 503. Liveness may accept it
 * only when a caller opts in AND the listener proves it holds this home's runtime record secret for
 * the pid and port that record names. A 503 body alone is never identity.
 */
import { describe, expect, test } from "bun:test";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
  createLocalAttestationSecret,
} from "../../src/lib/local-management-attestation";
import { SYSTEM_RESTART_CAPABILITY_VERSION } from "../../src/lib/system-restart-contract";
import { findLiveProxy, proveLiveProxyOwnedByHome, proxyIdentityAt, type LivenessIo } from "../../src/server/proxy-liveness";

const PID = 4242;
const PORT = 10100;
const CHALLENGE = "C".repeat(43);

function fencedBody(pid = PID, port = PORT, code = "package_tree_changed") {
  return {
    status: "restart_required",
    service: "opencodex",
    version: "2.59.0",
    uptime: 12,
    pid,
    port,
    restartCapability: SYSTEM_RESTART_CAPABILITY_VERSION,
    installedVersion: "2.63.0",
    error: { code, message: "package files changed" },
  };
}

/** A listener that serves the fenced body and signs challenges with `signingSecret`. */
function fencedListener(signingSecret: string | null, body: Record<string, unknown> = fencedBody(), status = 503) {
  const seen = { plain: 0, challenged: 0 };
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const challenge = headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER);
    const responseHeaders = new Headers({ "content-type": "application/json" });
    if (challenge) {
      seen.challenged += 1;
      const proof = signingSecret
        ? createLocalAttestationProof(signingSecret, challenge, body.pid as number, body.port as number)
        : null;
      if (proof) responseHeaders.set(LOCAL_ATTESTATION_PROOF_HEADER, proof);
    } else {
      seen.plain += 1;
    }
    return new Response(JSON.stringify(body), { status, headers: responseHeaders });
  }) as typeof fetch;
  return { fetchFn, seen };
}

function ownedIo(secret: string, fetchFn: typeof fetch, overrides: Partial<LivenessIo> = {}): LivenessIo {
  const record = { pid: PID, port: PORT, hostname: "127.0.0.1", attestationSecret: secret };
  return {
    fetchFn,
    readPidFn: () => PID,
    verifyPidFn: candidate => candidate,
    readRuntimeFn: () => record,
    configFn: () => ({ port: PORT }),
    createChallengeFn: () => CHALLENGE,
    acceptPackageTreeFenced: true,
    ...overrides,
  };
}

// INV-FENCE-01 (structure/overview.md).
describe("package-tree fenced liveness (#5496)", () => {
  test("an orphan stop requires this home's fresh challenge proof even from a healthy listener", async () => {
    const secret = createLocalAttestationSecret();
    const body = { service: "opencodex", status: "ok", version: "2.59.0", uptime: 12, pid: PID, port: PORT };
    const listener = fencedListener(secret, body, 200);
    const live = { pid: PID, port: PORT, hostname: "127.0.0.1", source: "config" as const };
    expect(await proveLiveProxyOwnedByHome(live, ownedIo(secret, listener.fetchFn))).toBe("proven");
    expect(await proveLiveProxyOwnedByHome(live, ownedIo(createLocalAttestationSecret(), listener.fetchFn))).toBe("refuted");
    expect(await proveLiveProxyOwnedByHome(live, ownedIo(secret, listener.fetchFn, { readRuntimeFn: () => null }))).toBe("refuted");
    expect(listener.seen.challenged).toBe(2);
  });

  test("a fenced proxy stays invisible to callers that did not opt in", async () => {
    const secret = createLocalAttestationSecret();
    const listener = fencedListener(secret);
    const io = ownedIo(secret, listener.fetchFn, { acceptPackageTreeFenced: undefined });
    expect(await proxyIdentityAt(PORT, {}, io)).toBeNull();
    expect(await findLiveProxy(io)).toBeNull();
    expect(listener.seen.challenged).toBe(0);
  });

  test("an attested fenced proxy is found through its runtime record", async () => {
    const secret = createLocalAttestationSecret();
    const listener = fencedListener(secret);
    const io = ownedIo(secret, listener.fetchFn);
    expect(await proxyIdentityAt(PORT, { expectedPid: PID }, io)).toEqual({
      pid: PID,
      version: "2.59.0",
      packageTreeFenced: true,
    });
    expect(await findLiveProxy(io)).toEqual({
      pid: PID,
      port: PORT,
      hostname: "127.0.0.1",
      source: "runtime",
      version: "2.59.0",
      packageTreeFenced: true,
    });
    expect(listener.seen.challenged).toBeGreaterThan(0);
  });

  test("a proof signed with any other secret is refused", async () => {
    const listener = fencedListener(createLocalAttestationSecret());
    const io = ownedIo(createLocalAttestationSecret(), listener.fetchFn);
    expect(await proxyIdentityAt(PORT, {}, io)).toBeNull();
    expect(await findLiveProxy(io)).toBeNull();
  });

  test("a listener that cannot sign at all is refused", async () => {
    const listener = fencedListener(null);
    expect(await proxyIdentityAt(PORT, {}, ownedIo(createLocalAttestationSecret(), listener.fetchFn))).toBeNull();
  });

  test("the body pid only selects a record; a missing or mismatched record is refused", async () => {
    const secret = createLocalAttestationSecret();
    const listener = fencedListener(secret);
    const records = [
      null,
      { pid: PID + 1, port: PORT, attestationSecret: secret },
      { pid: PID, port: PORT + 1, attestationSecret: secret },
      { pid: PID, port: PORT },
    ];
    for (const record of records) {
      const io = ownedIo(secret, listener.fetchFn, { readRuntimeFn: () => record });
      expect(await proxyIdentityAt(PORT, {}, io)).toBeNull();
    }
  });

  test("an expected pid that differs from the fenced body is refused before any challenge", async () => {
    const secret = createLocalAttestationSecret();
    const listener = fencedListener(secret);
    expect(await proxyIdentityAt(PORT, { expectedPid: PID + 1 }, ownedIo(secret, listener.fetchFn))).toBeNull();
    expect(listener.seen.challenged).toBe(0);
  });

  test("a 503 that is not the package-tree fence is still not identity", async () => {
    const secret = createLocalAttestationSecret();
    for (const body of [
      fencedBody(PID, PORT, "draining"),
      { ...fencedBody(), service: "someone-else" },
      { ...fencedBody(), status: "ok" },
      { ...fencedBody(), pid: "4242" },
    ]) {
      const listener = fencedListener(secret, body);
      expect(await proxyIdentityAt(PORT, {}, ownedIo(secret, listener.fetchFn))).toBeNull();
      expect(listener.seen.challenged).toBe(0);
    }
  });
});

describe("fenced-identity transport retries (#6198)", () => {
  test("a transient fetch failure retries the challenge instead of reporting no owner", async () => {
    const secret = createLocalAttestationSecret();
    const listener = fencedListener(secret, fencedBody(), 200);
    let calls = 0;
    const flakyFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls < 3) throw new TypeError("fetch failed");
      return listener.fetchFn(input, init);
    }) as typeof fetch;
    const io = ownedIo(secret, flakyFetch, { attempts: 3, sleepFn: () => Promise.resolve() });
    const live = { pid: PID, port: PORT, hostname: "127.0.0.1", source: "runtime" as const };
    expect(await proveLiveProxyOwnedByHome(live, io)).toBe("proven");
    expect(calls).toBe(3);
  });

  test("a transport that never answers stays indeterminate after the bounded attempts run out", async () => {
    const secret = createLocalAttestationSecret();
    const deadFetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const io = ownedIo(secret, deadFetch, { attempts: 3, sleepFn: () => Promise.resolve() });
    const live = { pid: PID, port: PORT, hostname: "127.0.0.1", source: "runtime" as const };
    expect(await proveLiveProxyOwnedByHome(live, io)).toBe("indeterminate");
  });

  test("a definitive proof failure is not retried", async () => {
    const listener = fencedListener(createLocalAttestationSecret(), fencedBody(), 200);
    const io = ownedIo(createLocalAttestationSecret(), listener.fetchFn, { attempts: 5, sleepFn: () => Promise.resolve() });
    const live = { pid: PID, port: PORT, hostname: "127.0.0.1", source: "runtime" as const };
    expect(await proveLiveProxyOwnedByHome(live, io)).toBe("refuted");
    expect(listener.seen.challenged).toBe(1);
  });

  test("attempts are clamped to five even when more are requested", async () => {
    const secret = createLocalAttestationSecret();
    let calls = 0;
    const deadFetch = (async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const io = ownedIo(secret, deadFetch, { attempts: 42, sleepFn: () => Promise.resolve() });
    const live = { pid: PID, port: PORT, hostname: "127.0.0.1", source: "runtime" as const };
    expect(await proveLiveProxyOwnedByHome(live, io)).toBe("indeterminate");
    expect(calls).toBe(5);
  });
});
