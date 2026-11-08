import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import {
  childArtifactFilename,
  hostChildTargetTriple,
  resolveChildBinarySource,
} from "../../src/link/child-binary-source";
import {
  classifyChildAttachConflict,
  parsePurgeDisconnectReport,
  parseRemoteRuntimeInspection,
  parseTargetTriple,
  remoteInspectRuntimeArgv,
  remoteManagedPurgeDisconnectArgv,
  remotePlantChildArgv,
  remotePurgePlantedChildArgv,
} from "../../src/link/remote-plant";
import {
  POWERSHELL_ENCODED_MAX,
  windowsInspectRuntimeArgv,
  windowsManagedPurgeDisconnectArgv,
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

  test("an empty OPENCODEX_HOME falls back to ~/.opencodex for the artifact cache instead of the working directory", () => {
    const fakeHome = join(scratch, "empty-ocx-home-user");
    const cacheDir = join(fakeHome, ".opencodex", "cache", "ocx-child", "2.98.0");
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const bytes = Buffer.from("cached-child-binary", "utf8");
    writeFileSync(join(cacheDir, childArtifactFilename("linux-arm64")), bytes, { mode: 0o700 });
    writeFileSync(join(cacheDir, "SHA256SUMS"), createHash("sha256").update(bytes).digest("hex") + "  " + childArtifactFilename("linux-arm64") + "\n", { mode: 0o600 });
    const empty = join(scratch, "empty-elsewhere");
    mkdirSync(empty, { recursive: true });
    const resolved = resolveChildBinarySource("linux-arm64", {
      env: { OPENCODEX_HOME: "", HOME: fakeHome },
      version: "2.98.0",
      repoRoot: empty,
      execPath: join(empty, "bun"),
      allowLocalRelease: false,
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.artifact.source).toBe("cache");
    const blank = resolveChildBinarySource("linux-arm64", {
      env: { OPENCODEX_HOME: "   ", HOME: fakeHome },
      version: "2.98.0",
      repoRoot: empty,
      execPath: join(empty, "bun"),
      allowLocalRelease: false,
    });
    expect(blank.ok).toBe(true);
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
      windowsManagedPurgeDisconnectArgv(),
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

  // A bin directory exposing only the named tools, so the plant script sees exactly these.
  function restrictedBin(dir: string, tools: readonly string[]): string {
    mkdirSync(dir, { recursive: true });
    for (const tool of tools) {
      const found = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"].map(d => join(d, tool)).find(p => existsSync(p));
      if (!found) throw new Error("missing host tool " + tool);
      symlinkSync(found, join(dir, tool));
    }
    return dir;
  }
  const PLANT_BASE_TOOLS = ["uname", "mkdir", "chmod", "cat", "wc", "awk", "rm", "mv"] as const;

  test("POSIX plant refuses to install or execute a binary when no SHA-256 tool can verify it", () => {
    if (process.platform === "win32") return;
    const fakeHome = join(scratch, "nohash-home");
    mkdirSync(fakeHome, { recursive: true, mode: 0o700 });
    const marker = join(scratch, "nohash-executed");
    const payload = Buffer.from("#!/bin/sh\necho ran > '" + marker + "'\necho \"opencodex 2.98.0\"\n", "utf8");
    const sha = createHash("sha256").update(payload).digest("hex");
    const argv = remotePlantChildArgv("posix", payload.byteLength, sha);
    const env = { HOME: fakeHome, PATH: restrictedBin(join(scratch, "nohash-bin"), PLANT_BASE_TOOLS) };
    const res = Bun.spawnSync(["/bin/sh", ...argv.slice(1)], { env, stdin: payload });
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr.toString("utf8")).toContain("ocx-plant-error:hash_tool_unavailable");
    const binDir = join(fakeHome, ".cache", "opencodex", "bin");
    expect(existsSync(join(binDir, "ocx-child"))).toBe(false);
    expect(existsSync(binDir) ? readdirSync(binDir) : []).toEqual([]);
    expect(existsSync(marker)).toBe(false);
  });

  // Every record ocx-child keeps while an attach, sync, or detach still needs the binary to finish.
  const RECOVERY_RECORDS: ReadonlyArray<{ readonly name: string; readonly path: (homes: { readonly ocx: string; readonly codex: string }) => string }> = [
    { name: "child state", path: h => join(h.ocx, "child", "state.json") },
    { name: "undo journal", path: h => join(h.ocx, "child", "codex-journal.json") },
    { name: "attach rollback snapshot", path: h => join(h.ocx, "child", "attach-rollback.json") },
    { name: "CODEX_HOME ownership record", path: h => join(h.codex, ".ocx-child-owner.json") },
  ];

  test("POSIX rollback purge keeps an unrunnable planted binary and fails while any recovery record exists", () => {
    if (process.platform === "win32") return;
    const argv = remotePurgePlantedChildArgv("posix");
    let n = 0;
    const runPurge = (binary: "unrunnable" | "absent", record: (typeof RECOVERY_RECORDS)[number] | null, explicitHomes: boolean) => {
      const home = join(scratch, "recovery-home-" + n++);
      const homes = explicitHomes
        ? { ocx: join(scratch, "custom-ocx-" + n), codex: join(scratch, "custom-codex-" + n) }
        : { ocx: join(home, ".opencodex"), codex: join(home, ".codex") };
      const dest = join(home, ".cache", "opencodex", "bin", "ocx-child");
      mkdirSync(join(home, ".cache", "opencodex", "bin"), { recursive: true, mode: 0o700 });
      if (binary === "unrunnable") writeFileSync(dest, "not an executable", { mode: 0o600 });
      if (record) {
        mkdirSync(join(record.path(homes), ".."), { recursive: true });
        writeFileSync(record.path(homes), "{}");
      }
      const env: Record<string, string> = { HOME: home, PATH: "/usr/bin:/bin" };
      if (explicitHomes) Object.assign(env, { OPENCODEX_HOME: homes.ocx, CODEX_HOME: homes.codex });
      const res = Bun.spawnSync(["/bin/sh", ...argv.slice(1)], { env });
      return { code: res.exitCode, kept: existsSync(dest), stderr: res.stderr.toString("utf8") };
    };
    const observed: unknown[] = [], expected: unknown[] = [];
    for (const explicitHomes of [false, true]) {
      expect(runPurge("unrunnable", null, explicitHomes)).toEqual({ code: 0, kept: false, stderr: "" });
      for (const record of RECOVERY_RECORDS) {
        for (const binary of ["unrunnable", "absent"] as const) {
          const res = runPurge(binary, record, explicitHomes);
          observed.push({ record: record.name, binary, explicitHomes, failed: res.code !== 0, kept: res.kept, reported: res.stderr.includes("recovery") });
          expected.push({ record: record.name, binary, explicitHomes, failed: true, kept: binary === "unrunnable", reported: true });
        }
      }
    }
    expect(observed).toEqual(expected);
  });

  test("Windows rollback purge checks every recovery record in both homes before deleting the binary", () => {
    const outer = Buffer.from(windowsPurgePlantedChildArgv()[5]!, "base64").toString("utf16le");
    const packed = /\$ocxPacked='([^']+)'/.exec(outer);
    expect(packed).not.toBeNull();
    const script = inflateRawSync(Buffer.from(Array.from(packed![1]!, ch => ch.charCodeAt(0) - 256))).toString("utf8");
    for (const name of ["state.json", "codex-journal.json", "attach-rollback.json", ".ocx-child-owner.json"]) expect(script).toContain(name);
    expect(script).toContain("$env:CODEX_HOME");
    expect(script).toContain("\\.codex");
  });

  test("POSIX plant verifies the digest with openssl when sha256sum and shasum are absent", () => {
    if (process.platform === "win32" || !["/usr/bin/openssl", "/bin/openssl"].some(p => existsSync(p))) return;
    const payload = Buffer.from("#!/bin/sh\necho \"opencodex 2.98.0\"\n", "utf8");
    const sha = createHash("sha256").update(payload).digest("hex");
    const bin = restrictedBin(join(scratch, "openssl-bin"), [...PLANT_BASE_TOOLS, "openssl"]);
    const goodHome = join(scratch, "openssl-home");
    mkdirSync(goodHome, { recursive: true, mode: 0o700 });
    const good = Bun.spawnSync(["/bin/sh", ...remotePlantChildArgv("posix", payload.byteLength, sha).slice(1)], { env: { HOME: goodHome, PATH: bin }, stdin: payload });
    expect(good.exitCode).toBe(0);
    expect(existsSync(join(goodHome, ".cache", "opencodex", "bin", "ocx-child"))).toBe(true);
    const badHome = join(scratch, "openssl-bad-home");
    mkdirSync(badHome, { recursive: true, mode: 0o700 });
    const wrongSha = createHash("sha256").update("other").digest("hex");
    const bad = Bun.spawnSync(["/bin/sh", ...remotePlantChildArgv("posix", payload.byteLength, wrongSha).slice(1)], { env: { HOME: badHome, PATH: bin }, stdin: payload });
    expect(bad.exitCode).not.toBe(0);
    expect(existsSync(join(badHome, ".cache", "opencodex", "bin", "ocx-child"))).toBe(false);
  });

  test("POSIX purge disconnect runs only the managed planted binary and needs its purged report", () => {
    if (process.platform === "win32") return;
    const fakeHome = join(scratch, "purge-target-home");
    const localBin = join(fakeHome, ".local", "bin");
    mkdirSync(localBin, { recursive: true });
    const recorded = join(scratch, "purge-target-args");
    writeFileSync(join(localBin, "ocx-child"), "#!/bin/sh\necho local >> '" + recorded + "'\necho '{\"purged\":false}'\n", { mode: 0o755 });
    const argv = remoteManagedPurgeDisconnectArgv("posix");
    const env = { HOME: fakeHome, PATH: localBin + ":/usr/bin:/bin" };
    const missing = Bun.spawnSync(["/bin/sh", ...argv.slice(1)], { env });
    expect(missing.exitCode).toBe(1);
    expect(missing.stderr.toString("utf8")).toContain("ocx-purge-error:managed_child_missing");
    expect(existsSync(recorded)).toBe(false);

    const managedBin = join(fakeHome, ".cache", "opencodex", "bin");
    mkdirSync(managedBin, { recursive: true });
    writeFileSync(join(managedBin, "ocx-child"), "#!/bin/sh\necho \"$@\" >> '" + recorded + "'\necho '{\"restored\":true,\"outcome\":\"NotAttached\",\"daemonRunning\":false,\"purged\":true}'\n", { mode: 0o755 });
    const ran = Bun.spawnSync(["/bin/sh", ...argv.slice(1)], { env });
    expect(ran.exitCode).toBe(0);
    expect(readFileSync(recorded, "utf8")).toBe("disconnect --purge --json\n");
    expect(parsePurgeDisconnectReport(ran.stdout.toString("utf8"))).toBe(true);
    expect(parsePurgeDisconnectReport('{"restored":true,"purged":false}\n')).toBe(false);
    expect(parsePurgeDisconnectReport("Disconnected (purged=true)\n")).toBeNull();
  });
});
