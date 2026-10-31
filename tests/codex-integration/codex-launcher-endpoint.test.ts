import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { attestCodexRuntime, codexRuntimeAttestationMatchesTarget, type CodexRuntimeAttestation } from "../../src/cli/codex-launch-auth";
import { buildCodexLaunchEnv } from "../../src/cli/codex-launcher";
import { proveLiveProxyOwnedByHome, type LiveProxy } from "../../src/server/proxy-liveness";
import { createLocalAttestationProof, LOCAL_ATTESTATION_PROOF_HEADER } from "../../src/lib/local-management-attestation";
import { buildProviderTableBlockForTarget } from "../../src/codex/inject/config-toml";
import { standaloneCodexRoutingTarget, validateCodexRoutingTarget } from "../../src/codex/inject/routing-target";
import { createCodexLaunchFixtureRoot, codexLaunchOwnershipTest, buildCodexPrivateFixtureLaunchEnv } from "../helpers/codex-launch-private-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const token = "ocx_fixture_endpoint_bound", origin = "http://127.0.0.1:12199";
const live: LiveProxy = { pid: 4242, port: 12199, hostname: "0.0.0.0", source: "runtime" };

/** Exercise the launch boundary independently of the host's filesystem ACL policy. */
function launch(proof: CodexRuntimeAttestation | null | undefined, extra: Record<string, string> = {}, args: string[] = []) {
  let reads = 0, checks = 0;
  const env = buildCodexLaunchEnv({ CODEX_HOME: process.cwd(), ...extra }, {
    routingKind: "opencodex-local", runtimeAttestation: proof, args,
    credentialDestination: (_home, _report, received) => {
      checks++;
      expect(received).toBe(proof);
      return codexRuntimeAttestationMatchesTarget(`${origin}/v1`, received);
    },
    serviceToken: () => { reads++; return token; },
  });
  return { env, reads, checks };
}

describe("Codex runtime endpoint binding", () => {
  test("a real challenge proof is bound to the address actually dialed", async () => {
    const secret = "s".repeat(43), challenge = "c".repeat(43);
    for (const port of [12199, 12200]) {
      let requested = "";
      const endpoint = { ...live, port, hostname: "::1", probeHostname: "127.0.0.1" };
      const proof = await attestCodexRuntime(endpoint, snapshot => proveLiveProxyOwnedByHome(snapshot, {
        readRuntimeFn: () => ({ pid: 4242, port, attestationSecret: secret }),
        createChallengeFn: () => challenge,
        fetchFn: async input => {
          requested = String(input);
          return Response.json({ service: "opencodex", pid: 4242 }, {
            headers: { [LOCAL_ATTESTATION_PROOF_HEADER]: createLocalAttestationProof(secret, challenge, 4242, port)! },
          });
        },
      }));
      expect(requested).toBe(`http://127.0.0.1:${port}/healthz`);
      expect(proof).toEqual({ origin: `http://127.0.0.1:${port}` });
      expect(launch(proof).reads).toBe(port === 12199 ? 1 : 0);
    }
  });

  test("direct-client destination matching is independent of the local machine port", () => {
    const local = standaloneCodexRoutingTarget(12200, { hostname: "0.0.0.0" });
    const direct = validateCodexRoutingTarget({ baseUrl: `${origin}/v1`, requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" });
    expect(codexRuntimeAttestationMatchesTarget(direct.baseUrl, { origin })).toBe(true);
    expect(codexRuntimeAttestationMatchesTarget(local.baseUrl, { origin })).toBe(false);
    expect(codexRuntimeAttestationMatchesTarget(direct.baseUrl, { origin: "http://127.0.0.1:12200" })).toBe(false);
  });

  test("a different attested runtime port cannot authorize the configured destination", async () => {
    const result = launch(await attestCodexRuntime({ ...live, port: 12200 }, async () => "proven"));
    expect(result.checks).toBe(1);
    expect(result.reads).toBe(0);
    expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
  });
  test("the same attested endpoint reads exactly one fresh token", async () => {
    const result = launch(await attestCodexRuntime(live, async () => "proven"));
    expect(result.reads).toBe(1);
    expect(result.env.OPENCODEX_API_AUTH_TOKEN).toBe(token);
  });
  for (const verdict of ["refuted", "indeterminate"] as const) test(`${verdict} ownership never authorizes loading`, async () => {
    const proof = await attestCodexRuntime(live, async () => verdict);
    expect(proof).toBeNull();
    expect(launch(proof).reads).toBe(0);
  });
  test("missing proof also refuses helper calls without a routing classification", () => {
    let reads = 0;
    const env = buildCodexLaunchEnv({ CODEX_HOME: process.cwd() }, {
      credentialDestination: () => true, serviceToken: () => { reads++; return token; },
    });
    expect(reads).toBe(0);
    expect(env.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
    expect(launch(undefined).checks).toBe(0);
  });
  test("a failed proof operation degrades without a fresh credential", async () => {
    expect(await attestCodexRuntime(live, async () => { throw new Error("unavailable"); })).toBeNull();
  });
  for (const hostname of ["0.0.0.0", "::", "[::]", "0:0:0:0:0:0:0:0", "0.0.0.0.", "*"]) {
    test(`wildcard proof uses established loopback normalization: ${hostname}`, async () => {
      expect(await attestCodexRuntime({ ...live, hostname }, async () => "proven")).toEqual({ origin });
    });
  }
  test("the successful probe address takes precedence and IPv6 does not bless IPv4", async () => {
    const proof = await attestCodexRuntime({ ...live, probeHostname: "::1" }, async () => "proven");
    expect(proof).toEqual({ origin: "http://[::1]:12199" });
    expect(launch(proof).reads).toBe(0);
    expect(codexRuntimeAttestationMatchesTarget("http://[0:0:0:0:0:0:0:1]:12199/v1", proof)).toBe(true);
    expect(codexRuntimeAttestationMatchesTarget("https://[::1]:12199/v1", proof)).toBe(false);
    expect(codexRuntimeAttestationMatchesTarget("invalid", proof)).toBe(false);
  });
  test("proof snapshots the endpoint before awaiting ownership", async () => {
    const mutable = { ...live };
    const proof = await attestCodexRuntime(mutable, async snapshot => {
      mutable.port = 12200; mutable.hostname = "::1";
      expect(snapshot.port).toBe(12199);
      expect(snapshot.hostname).toBe("0.0.0.0");
      return "proven";
    });
    expect(proof).toEqual({ origin });
    expect(Object.isFrozen(proof)).toBe(true);
  });
  test("valid proof retains argv/environment guards and explicit user credentials win", async () => {
    const proof = await attestCodexRuntime(live, async () => "proven");
    for (const args of [["-c", "model_provider=foreign"], ["--profile=foreign"], ["resume"]]) {
      expect(launch(proof, {}, args).reads).toBe(0);
    }
    expect(launch(proof, { OPENAI_BASE_URL: "https://foreign.invalid/v1" }).reads).toBe(0);
    const inherited = launch({ origin: "http://127.0.0.1:12200" }, { OPENCODEX_API_AUTH_TOKEN: "fixture-explicit" }, ["--profile=foreign"]);
    expect(inherited.reads).toBe(0);
    expect(inherited.checks).toBe(0);
    expect(inherited.env.OPENCODEX_API_AUTH_TOKEN).toBe("fixture-explicit");
  });
});

function configurationFixture(client: boolean, run: (home: string) => void) {
  const root = createCodexLaunchFixtureRoot("ocx-bound-endpoint-"), home = join(root, "codex"), ocx = join(root, "ocx");
  mkdirSync(home); mkdirSync(ocx);
  const saved = process.env.OPENCODEX_HOME, cwd = process.cwd();
  try {
    process.env.OPENCODEX_HOME = ocx; process.chdir(root);
    const config = { port: client ? 12200 : 12199, hostname: "0.0.0.0", ...(client ? {
      runtimeRole: "client", client: { serverUrl: origin, managementUrl: origin,
        managementTransport: "direct", selectedClients: ["codex"], tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
        apiKeyId: "fixture", tokenFingerprint: "a".repeat(64), protocolVersion: 1, connectedAt: "2026-01-01T00:00:00.000Z" },
    } : {}) };
    const target = client ? validateCodexRoutingTarget({ baseUrl: `${origin}/v1`, requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN" })
      : standaloneCodexRoutingTarget(config.port, config);
    writeFileSync(join(ocx, "config.json"), JSON.stringify(config));
    writeFileSync(join(home, "config.toml"), 'model_provider="opencodex"\n' + buildProviderTableBlockForTarget(target));
    run(home);
  } finally {
    process.chdir(cwd);
    if (saved === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = saved;
    removeTreeWithRetry(root);
  }
}

for (const client of [false, true]) codexLaunchOwnershipTest(`${client ? "direct client" : "standalone"} binds proof to the final provider destination`, () => {
  configurationFixture(client, home => {
    for (const port of [12199, 12200]) {
      let reads = 0;
      const result = buildCodexPrivateFixtureLaunchEnv({ CODEX_HOME: home }, {
        routingKind: "opencodex-local", runtimeAttestation: { origin: `http://127.0.0.1:${port}` },
        serviceToken: () => { reads++; return token; },
      });
      expect(reads).toBe(port === 12199 ? 1 : 0);
      expect(result.OPENCODEX_API_AUTH_TOKEN).toBe(port === 12199 ? token : undefined);
    }
    writeFileSync(join(home, "managed_config.toml"), "");
    let reads = 0;
    buildCodexPrivateFixtureLaunchEnv({ CODEX_HOME: home }, { runtimeAttestation: { origin }, serviceToken: () => { reads++; return token; } });
    expect(reads).toBe(0);
  });
});
