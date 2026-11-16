import { expect, test } from "bun:test";
import { LOCAL_ATTESTATION_PROOF_HEADER, createLocalAttestationProof, createLocalAttestationSecret } from "../../src/lib/local-management-attestation";
import { SYSTEM_RESTART_CAPABILITY_VERSION, SYSTEM_RESTART_PATH } from "../../src/lib/system-restart-contract";
import { requestBoundSystemRestart } from "../../src/cli/system-restart-client";
import { UpdateRestartRequired } from "../../src/cli/update-restart-candidate";
import type { LiveProxy } from "../../src/server/proxy-liveness";

// #8246: the headless Desktop updater proves the runtime's image is the installed ocx.exe, so its
// in-place respawn runs the installed (newer) bytes and the CLI-newer refusal must not apply.
const target: LiveProxy = { pid: 4242, port: 10100, hostname: "127.0.0.1", source: "runtime" };

function harness() {
  const secret = createLocalAttestationSecret();
  const challenge = "B".repeat(43);
  const posts: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith("/healthz")) {
      return new Response(JSON.stringify({ status: "ok", service: "opencodex", version: "2.99.0", uptime: 1, pid: target.pid,
        port: target.port, restartCapability: SYSTEM_RESTART_CAPABILITY_VERSION }), {
        status: 200, headers: { "content-type": "application/json", [LOCAL_ATTESTATION_PROOF_HEADER]: createLocalAttestationProof(secret, challenge, target.pid!, target.port)! },
      });
    }
    posts.push(url);
    return new Response("{}", { status: 202 });
  }) as typeof fetch;
  return {
    posts,
    deps: {
      fetchImpl,
      readRuntime: () => ({ pid: target.pid!, port: target.port, hostname: target.hostname, attestationSecret: secret }),
      findLive: async () => target,
      createChallenge: () => challenge,
      now: () => 1_000,
      cliVersion: "2.100.3",
      readUpdateHome: () => ({ config: { path: "/test/ocx", dev: 1, ino: 2, fileId: "1:2" }, codex: { path: "/test/codex", dev: 1, ino: 3, fileId: "1:3" }, revision: 0, serviceRecord: { schema: 1 as const, digest: "a".repeat(64) }, diagnosedHostname: "127.0.0.1" }),
    },
  };
}

test("a CLI-newer restart still refuses without installed-image proof", async () => {
  const h = harness();
  const result = await requestBoundSystemRestart(target, 10_000, h.deps);
  expect(result.accepted).toBe(false);
  if (!result.accepted) expect(result.error).toBeInstanceOf(UpdateRestartRequired);
  expect(h.posts).toEqual([]);
});

test("installed-image proof sends the bound restart to the attested runtime", async () => {
  const h = harness();
  const result = await requestBoundSystemRestart(target, 10_000, { ...h.deps, respawnRunsInstalledImage: true });
  expect(result).toEqual({ accepted: true });
  expect(h.posts).toEqual([`http://127.0.0.1:${target.port}${SYSTEM_RESTART_PATH}`]);
});

test("installed-image proof does not admit a runtime newer than the installed version", async () => {
  const h = harness();
  const result = await requestBoundSystemRestart(target, 10_000, { ...h.deps, cliVersion: "2.98.0", respawnRunsInstalledImage: true });
  expect(result.accepted).toBe(false);
  if (!result.accepted) expect((result.error as Error).message).toBe("restart_version_skew");
  expect(h.posts).toEqual([]);
});
