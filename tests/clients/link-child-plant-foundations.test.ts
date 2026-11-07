import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  childArtifactFilename,
  hostChildTargetTriple,
  resolveChildBinarySource,
} from "../../src/link/child-binary-source";
import {
  classifyChildAttachConflict,
  parseRemoteRuntimeInspection,
  parseTargetTriple,
  remoteInspectRuntimeArgv,
  remotePlantChildArgv,
  remotePurgePlantedChildArgv,
} from "../../src/link/remote-plant";
import {
  POWERSHELL_ENCODED_MAX,
  windowsInspectRuntimeArgv,
  windowsOcxArgv,
  windowsPlantChildArgv,
  windowsPurgePlantedChildArgv,
} from "../../src/link/remote-windows";
import { quoteRemote } from "../../src/link/ssh-argv";
import { parseLinkStore, readLinkStore, writeLinkStore } from "../../src/link/store";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoRoot } from "../helpers/repo-root";

let scratch: string;
let prevHome: string | undefined;
beforeEach(() => {
  prevHome = process.env.OPENCODEX_HOME;
  scratch = mkdtempSync(join(tmpdir(), "ocx-child-plant-foundations-"));
  process.env.OPENCODEX_HOME = join(scratch, ".opencodex");
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = prevHome;
  removeTreeWithRetry(scratch);
});

describe("LinkRecord childKind persistence", () => {
  test("roundtrips full, ephemeral, and omitted childKind while rejecting invalid values", () => {
    const storePath = join(scratch, ".opencodex", "link", "links.json");
    writeLinkStore(storePath, {
      version: 1,
      listenerPort: 18181,
      links: [
        {
          id: "lnk_0123456789abcdef",
          alias: "ephemeral-box",
          direction: "hub-initiated",
          hostKeyFingerprint: "SHA256:abcdefghijklmnop",
          tunnelPort: 24500,
          apiKeyId: "key_1",
          createdAt: "2026-11-07T00:00:00.000Z",
          remotePlatform: "posix",
          childKind: "ephemeral",
        },
        {
          id: "lnk_fedcba9876543210",
          alias: "legacy-box",
          direction: "hub-initiated",
          hostKeyFingerprint: "SHA256:abcdefghijklmnop",
          tunnelPort: 24501,
          apiKeyId: "key_2",
          createdAt: "2026-11-07T00:00:00.000Z",
        },
      ],
    });
    const loaded = readLinkStore(storePath);
    expect(loaded.links[0]?.childKind).toBe("ephemeral");
    expect(loaded.links[1]?.childKind).toBeUndefined();
    expect(() =>
      parseLinkStore(JSON.stringify({ ...loaded, links: [{ ...loaded.links[0], childKind: "bogus" }] })),
    ).toThrow(/childKind/);
  });
});

describe("child-binary-source SHA256SUMS and boundary guards", () => {
  test("verifies OPENCODEX_CHILD_BIN_DIR and cache SHA256SUMS, fails closed on mismatch or symlink without local-release fallthrough", () => {
    const envDir = join(scratch, "bin-override");
    mkdirSync(envDir, { recursive: true, mode: 0o700 });
    const linuxArtifact = childArtifactFilename("linux-x64");
    const payload = Buffer.from("#!/bin/sh\necho opencodex 2.98.0\n", "utf8");
    const digest = createHash("sha256").update(payload).digest("hex");
    writeFileSync(join(envDir, linuxArtifact), payload, { mode: 0o700 });
    writeFileSync(join(envDir, "SHA256SUMS"), `${digest}  ${linuxArtifact}\n`, { mode: 0o600 });

    const verified = resolveChildBinarySource("linux-x64", { env: { OPENCODEX_CHILD_BIN_DIR: envDir }, allowLocalRelease: false });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.artifact.source).toBe("env");
      expect(verified.artifact.sha256).toBe(digest);
      expect(verified.artifact.sizeBytes).toBe(payload.byteLength);
    }

    // Tamper with SHA256SUMS for host triple: must fail closed with checksum_mismatch instead of falling through to local-release
    const hostTriple = hostChildTargetTriple();
    if (hostTriple) {
      const hostFile = childArtifactFilename(hostTriple);
      writeFileSync(join(envDir, hostFile), payload, { mode: 0o700 });
      writeFileSync(join(envDir, "SHA256SUMS"), `${"0".repeat(64)}  ${hostFile}\n`, { mode: 0o600 });
      const mismatch = resolveChildBinarySource(hostTriple, {
        env: { OPENCODEX_CHILD_BIN_DIR: envDir },
        repoRoot: repoRoot(),
        allowLocalRelease: true,
      });
      expect(mismatch).toEqual({ ok: false, reason: "checksum_mismatch" });
    }

    // Symlinked SHA256SUMS on POSIX is rejected
    if (process.platform !== "win32") {
      const cacheDir = join(scratch, ".opencodex", "cache", "ocx-child", "2.98.0");
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      const armArtifact = childArtifactFilename("linux-arm64");
      writeFileSync(join(cacheDir, armArtifact), payload, { mode: 0o700 });
      const realSums = join(scratch, "real-sums");
      writeFileSync(realSums, `${digest}  ${armArtifact}\n`, { mode: 0o600 });
      symlinkSync(realSums, join(cacheDir, "SHA256SUMS"));
      const symRes = resolveChildBinarySource("linux-arm64", {
        env: {},
        opencodexHome: join(scratch, ".opencodex"),
        version: "2.98.0",
        allowLocalRelease: false,
      });
      expect(symRes).toEqual({ ok: false, reason: "checksum_mismatch" });
    }

    expect(resolveChildBinarySource(null)).toEqual({ ok: false, reason: "unsupported_target" });
  });
});

describe("remote-plant POSIX & Windows command contracts", () => {
  test("Windows inspect, plant, and purge commands fit under POWERSHELL_ENCODED_MAX and quoteRemote", () => {
    const sha = "a".repeat(64);
    for (const argv of [
      windowsInspectRuntimeArgv(),
      windowsOcxArgv(["disconnect", "--purge"]),
      windowsPlantChildArgv(950_000, sha),
      windowsPurgePlantedChildArgv(),
    ]) {
      expect(argv[0]).toBe("powershell.exe");
      expect(argv[5]!.length).toBeLessThanOrEqual(POWERSHELL_ENCODED_MAX);
      expect(() => quoteRemote(argv)).not.toThrow();
    }
    expect(parseTargetTriple("windows", "AMD64")).toBe("windows-x64");
    expect(parseTargetTriple("windows", "ARM64")).toBeNull();
    expect(parseTargetTriple("posix", "Darwin:arm64")).toBe("darwin-arm64");
    expect(parseTargetTriple("posix", "Linux:x86_64")).toBe("linux-x64");
    expect(parseTargetTriple("posix", "Linux:aarch64")).toBe("linux-arm64");
    expect(classifyChildAttachConflict("ocx-child-conflict:child_port_busy: bound")).toBe("child_port_busy");
    expect(classifyChildAttachConflict("ocx-child-conflict:child_external_provider_conflict: ext")).toBe("child_external_provider_conflict");
  });

  function sandboxInspectScript(script: string, rootDir: string): string {
    const empty = join(rootDir, "empty-sys");
    mkdirSync(empty, { recursive: true });
    return script
      .replaceAll("/Applications/OpenCodex.app/Contents/MacOS/ocx", join(empty, "ocx"))
      .replaceAll("/usr/bin/ocx", join(empty, "ocx"))
      .replaceAll("/opt/homebrew/bin", empty)
      .replaceAll("/usr/local/bin", empty);
  }

  test("POSIX inspect, stdin plant, and purge scripts operate end-to-end and refuse symlinked .cache", async () => {
    if (process.platform === "win32") return;
    const fakeHome = join(scratch, "remote-home");
    mkdirSync(fakeHome, { recursive: true, mode: 0o700 });
    const env = { HOME: fakeHome, PATH: "/usr/bin:/bin" };

    const inspectArgv = remoteInspectRuntimeArgv("posix");
    inspectArgv[2] = sandboxInspectScript(inspectArgv[2]!, scratch);
    const inspectMissing = Bun.spawnSync(["sh", ...inspectArgv.slice(1)], { env });
    expect(inspectMissing.exitCode).toBe(0);
    const parsedMissing = parseRemoteRuntimeInspection("posix", inspectMissing.stdout.toString("utf8"));
    expect(parsedMissing?.runtimeKind).toBe("missing");

    const scriptPayload = Buffer.from("#!/bin/sh\necho \"opencodex 2.98.0\"\n", "utf8");
    const scriptSha = createHash("sha256").update(scriptPayload).digest("hex");
    const plantArgv = remotePlantChildArgv("posix", scriptPayload.byteLength, scriptSha);
    const planted = Bun.spawnSync([plantArgv[0]!, ...plantArgv.slice(1)], { env, stdin: scriptPayload });
    expect(planted.exitCode).toBe(0);
    const plantedPath = join(fakeHome, ".cache", "opencodex", "bin", "ocx-child");
    expect(existsSync(plantedPath)).toBe(true);

    const inspectEphemeral = Bun.spawnSync(["sh", ...inspectArgv.slice(1)], { env });
    const parsedEphemeral = parseRemoteRuntimeInspection("posix", inspectEphemeral.stdout.toString("utf8"));
    expect(parsedEphemeral?.runtimeKind).toBe("ephemeral");
    expect(parsedEphemeral?.ocxVersionLine).toBe("opencodex 2.98.0");

    const purgeArgv = remotePurgePlantedChildArgv("posix");
    const purged = Bun.spawnSync([purgeArgv[0]!, ...purgeArgv.slice(1)], { env });
    expect(purged.exitCode).toBe(0);
    expect(existsSync(plantedPath)).toBe(false);

    // Preserves planted binary and returns nonzero when detach --purge fails (e.g. exit 4 conflict)
    const failingScript = Buffer.from("#!/bin/sh\nif [ \"$1\" = \"detach\" ]; then exit 4; fi\necho \"opencodex 2.98.0\"\n", "utf8");
    const failingSha = createHash("sha256").update(failingScript).digest("hex");
    const failPlantArgv = remotePlantChildArgv("posix", failingScript.byteLength, failingSha);
    expect(Bun.spawnSync([failPlantArgv[0]!, ...failPlantArgv.slice(1)], { env, stdin: failingScript }).exitCode).toBe(0);
    const failedPurge = Bun.spawnSync([purgeArgv[0]!, ...purgeArgv.slice(1)], { env });
    expect(failedPurge.exitCode).toBe(4);
    expect(existsSync(plantedPath)).toBe(true);

    // Refuses symlinked .cache ancestor
    const symHome = join(scratch, "sym-remote-home");
    const targetCache = join(scratch, "real-cache");
    mkdirSync(symHome, { recursive: true, mode: 0o700 });
    mkdirSync(targetCache, { recursive: true, mode: 0o700 });
    symlinkSync(targetCache, join(symHome, ".cache"));
    chmodSync(targetCache, 0o700);
    const symPlant = Bun.spawnSync([plantArgv[0]!, ...plantArgv.slice(1)], {
      env: { HOME: symHome, PATH: "/usr/bin:/bin" },
      stdin: scriptPayload,
    });
    expect(symPlant.exitCode).not.toBe(0);
  });
});

