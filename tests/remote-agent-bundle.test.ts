import { afterEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
  REMOTE_AGENT_SPECS,
  assembleRemoteAgentBundle,
  remoteAgentPackageForRuntime,
  verifyRemoteAgentArtifact,
  verifyRemoteAgentBundle,
} from "../src/remote/agent-bundle";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ocx-agent-bundle-"));
  cleanup.push(root);
  const inputRoot = join(root, "input");
  const bundleRoot = join(root, "bundle");
  const releaseAssetsRoot = join(root, "release");
  for (const spec of REMOTE_AGENT_SPECS) {
    const artifactRoot = join(inputRoot, `remote-agent-${spec.package}`);
    mkdirSync(artifactRoot, { recursive: true });
    writeFileSync(join(artifactRoot, spec.executable), `native-agent:${spec.package}\n`, { mode: 0o755 });
  }
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
  const manifest = assembleRemoteAgentBundle({
    inputRoot,
    bundleRoot,
    releaseAssetsRoot,
    privateKeyPem,
    expectedPublicKeyPem: publicKeyPem,
    sourceCommit: "a".repeat(40),
    packageVersion: "9.8.7",
  });
  return { root, bundleRoot, releaseAssetsRoot, privateKeyPem, publicKeyPem, manifest };
}

describe("Remote Agent release bundle", () => {
  test("assembles and verifies the complete six-platform set", () => {
    const built = fixture();
    expect(Object.keys(verifyRemoteAgentBundle(built.bundleRoot, built.publicKeyPem).artifacts)).toHaveLength(6);
    expect(built.manifest.sourceCommit).toBe("a".repeat(40));
    expect(built.manifest.packageVersion).toBe("9.8.7");
    for (const spec of REMOTE_AGENT_SPECS) {
      expect(readFileSync(join(built.releaseAssetsRoot, `${spec.releaseFile}.sig`))).toHaveLength(64);
      expect(verifyRemoteAgentArtifact(built.bundleRoot, spec.package, built.publicKeyPem)).toEndWith(spec.executable);
    }
  });

  test("fails closed when a packaged binary is modified", () => {
    const built = fixture();
    const linuxBinary = join(built.bundleRoot, "linux-x64", "opencodex-remote-agent");
    writeFileSync(linuxBinary, "tampered\n");
    chmodSync(linuxBinary, 0o755);
    expect(() => verifyRemoteAgentArtifact(built.bundleRoot, "linux-x64", built.publicKeyPem))
      .toThrow("checksum verification failed");
  });

  test("rejects a missing platform and manifest path substitution", () => {
    const missing = fixture();
    rmSync(join(missing.bundleRoot, "windows-arm64", "opencodex-remote-agent.exe"));
    expect(() => verifyRemoteAgentBundle(missing.bundleRoot, missing.publicKeyPem)).toThrow("artifact is missing");

    const substituted = fixture();
    const manifestPath = join(substituted.bundleRoot, "remote-agent-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.artifacts["linux-x64"].path = "../opencodex-remote-agent";
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() => verifyRemoteAgentBundle(substituted.bundleRoot, substituted.publicKeyPem))
      .toThrow("manifest path is invalid");
  });

  test("authenticates source provenance and the installed package version", () => {
    const built = fixture();
    const manifestPath = join(built.bundleRoot, "remote-agent-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.sourceCommit = "b".repeat(40);
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
    expect(() => verifyRemoteAgentBundle(built.bundleRoot, built.publicKeyPem, "9.8.7"))
      .toThrow("manifest signature verification failed");

    const versionBound = fixture();
    expect(() => verifyRemoteAgentBundle(versionBound.bundleRoot, versionBound.publicKeyPem, "9.8.8"))
      .toThrow("does not match the installed package version");
  });

  test("rejects a signing key that does not match the pinned public key", () => {
    const built = fixture();
    const other = generateKeyPairSync("ed25519");
    const otherPrivateKey = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => assembleRemoteAgentBundle({
      inputRoot: join(built.root, "input"),
      bundleRoot: join(built.root, "wrong-bundle"),
      releaseAssetsRoot: join(built.root, "wrong-release"),
      privateKeyPem: otherPrivateKey,
      expectedPublicKeyPem: built.publicKeyPem,
      sourceCommit: "b".repeat(40),
      packageVersion: "9.8.7",
    })).toThrow("does not match the pinned public key");
  });

  test("maps only the supported runtime combinations", () => {
    expect(remoteAgentPackageForRuntime("linux", "x64")).toBe("linux-x64");
    expect(remoteAgentPackageForRuntime("darwin", "arm64")).toBe("macos-arm64");
    expect(remoteAgentPackageForRuntime("win32", "x64")).toBe("windows-x64");
    expect(remoteAgentPackageForRuntime("freebsd", "x64")).toBeNull();
    expect(remoteAgentPackageForRuntime("linux", "riscv64")).toBeNull();
  });
});
