/**
 * #5496: `ocx restart` on a proxy fenced by the package-tree guard. The fenced /healthz is a 503,
 * but it still proves its identity, so the bound restart may proceed. What the respawn will run is
 * the manifest now on disk, so the skew guard compares against that installed version.
 */
import { describe, expect, test } from "bun:test";
import {
  LOCAL_ATTESTATION_CHALLENGE_HEADER,
  LOCAL_ATTESTATION_PROOF_HEADER,
  createLocalAttestationProof,
  createLocalAttestationSecret,
} from "../../src/lib/local-management-attestation";
import { SYSTEM_RESTART_CAPABILITY_VERSION, SYSTEM_RESTART_PATH } from "../../src/lib/system-restart-contract";
import { requestBoundSystemRestart } from "../../src/cli/system-restart-client";
import type { LiveProxy, LivenessIo } from "../../src/server/proxy-liveness";

const target: LiveProxy = { pid: 5151, port: 10100, hostname: "127.0.0.1", source: "runtime" };
const CHALLENGE = "F".repeat(43);

function fencedHarness(options: {
  status?: number;
  installedVersion?: unknown;
  code?: string;
  sign?: boolean;
} = {}) {
  const secret = createLocalAttestationSecret();
  const requests: string[] = [];
  const recheckOptions: LivenessIo[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/healthz")) {
      const challenge = new Headers(init?.headers).get(LOCAL_ATTESTATION_CHALLENGE_HEADER);
      const headers = new Headers({ "content-type": "application/json" });
      if (challenge && options.sign !== false) {
        headers.set(LOCAL_ATTESTATION_PROOF_HEADER, createLocalAttestationProof(secret, challenge, target.pid!, target.port)!);
      }
      return new Response(JSON.stringify({
        status: "restart_required",
        service: "opencodex",
        version: "2.59.0",
        uptime: 30,
        pid: target.pid,
        port: target.port,
        restartCapability: SYSTEM_RESTART_CAPABILITY_VERSION,
        ...("installedVersion" in options ? { installedVersion: options.installedVersion } : { installedVersion: "2.63.0" }),
        error: { code: options.code ?? "package_tree_changed", message: "package files changed" },
      }), { status: options.status ?? 503, headers });
    }
    return new Response(JSON.stringify({ success: true, alreadyDraining: true }), { status: 202 });
  }) as typeof fetch;
  const runtime = { pid: target.pid!, port: target.port, hostname: target.hostname, attestationSecret: secret };
  return {
    requests,
    recheckOptions,
    deps: {
      fetchImpl,
      readRuntime: () => runtime,
      findLive: async (io: LivenessIo = {}) => {
        recheckOptions.push(io);
        return io.acceptPackageTreeFenced ? { ...target, packageTreeFenced: true as const } : null;
      },
      createChallenge: () => CHALLENGE,
      now: () => 1_000,
      cliVersion: "2.63.0",
    },
  };
}

function errorCode(outcome: Awaited<ReturnType<typeof requestBoundSystemRestart>>): string {
  return outcome.accepted ? "" : (outcome.error as Error).message;
}

describe("bound restart of a package-tree fenced proxy (#5496)", () => {
  test("an attested fenced proxy whose installed files match this CLI is restarted in place", async () => {
    const harness = fencedHarness();
    expect(await requestBoundSystemRestart(target, 10_000, harness.deps)).toEqual({ accepted: true });
    expect(harness.requests.some(url => url.endsWith(SYSTEM_RESTART_PATH))).toBe(true);
    // The pre-POST recheck must be able to see the same fenced process again.
    expect(harness.recheckOptions.map(io => io.acceptPackageTreeFenced)).toEqual([true]);
  });

  test("installed files from a different version are refused as skew, never compared with the boot version", async () => {
    const harness = fencedHarness({ installedVersion: "2.64.0" });
    const outcome = await requestBoundSystemRestart(target, 10_000, harness.deps);
    expect(errorCode(outcome)).toBe("restart_version_skew");
    expect(harness.requests.some(url => url.endsWith(SYSTEM_RESTART_PATH))).toBe(false);
  });

  test("a replacement still in flight is refused without POST", async () => {
    for (const installedVersion of [undefined, "", "not-a-version", 7]) {
      const harness = fencedHarness({ installedVersion });
      const outcome = await requestBoundSystemRestart(target, 10_000, harness.deps);
      expect(errorCode(outcome)).toBe("restart_package_tree_unsettled");
      expect(harness.requests.some(url => url.endsWith(SYSTEM_RESTART_PATH))).toBe(false);
    }
  });

  test("a fenced body without a valid proof is refused", async () => {
    const harness = fencedHarness({ sign: false });
    expect(errorCode(await requestBoundSystemRestart(target, 10_000, harness.deps))).toBe("restart_attestation_failed");
  });

  test("any other non-OK proof response is still refused", async () => {
    for (const variant of [{ code: "draining" }, { status: 500 }]) {
      const harness = fencedHarness(variant);
      expect(errorCode(await requestBoundSystemRestart(target, 10_000, harness.deps))).toBe("restart_attestation_failed");
      expect(harness.requests.some(url => url.endsWith(SYSTEM_RESTART_PATH))).toBe(false);
    }
  });
});
