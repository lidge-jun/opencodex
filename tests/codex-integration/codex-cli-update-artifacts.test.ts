import { createCodexCliTestRoot } from "../helpers/codex-cli-fixture-root";
import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { codexCliArtifactSet, codexCliArtifactSetDigest, MAX_CODEX_ARCHIVE_BYTES, MAX_CODEX_MEMBER_BYTES, verifyCodexCliArchive, verifiedCodexCliContent } from "../../src/codex/cli-update-artifacts";
import { codexCliUpdatePlanId } from "../../src/codex/cli-update-plan";
import { fixtureArtifact, fixtureArtifactSet, fixtureTar } from "../helpers/codex-cli-apply-artifact";
import { applyCodexCliUpdate, cleanupCodexCliApply, verifyInstalledCodexVersion } from "../../src/codex/cli-update-apply";
import { acquireCodexCliApplyLease } from "../../src/codex/cli-update-lease";
import { parseCodexCliUpdateArgs, handleCodexCliUpdateCommand } from "../../src/cli/codex-cli-update";
import { chmodSync, closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { join } from "node:path";
import { createCodexCliApplyFixture, waitForApplyAdmission } from "../helpers/codex-cli-apply-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { observeCodexCliPreimage, sameCodexCliPreimage, sameCodexCliFiles, type CodexCliFileSet } from "../../src/codex/cli-update-files";

describe("Codex CLI apply artifacts", () => {
  test("real npm installs main and platform aliases from local tarballs into a private prefix offline", () => {
    const root = createCodexCliTestRoot("ocx-apply-alias-");
    try {
      const f = createCodexCliApplyFixture(root, "linux", "x64");
      const modules = join(f.prefix, ...(process.platform === "win32" ? [] : ["lib"]), "node_modules");
      expect(JSON.parse(readFileSync(join(modules, "@openai", "codex", "package.json"), "utf8")).version).toBe("1.0.0");
      expect(JSON.parse(readFileSync(join(modules, "@openai", "codex-linux-x64", "package.json"), "utf8")).version).toBe("1.0.0-linux-x64");
      expect(Object.keys(f.target.mainManifest.optionalDependencies)).toHaveLength(6);
      f.privateNpm(["install", "-g", "--prefix", f.prefix, "--package-lock=false",
        `${f.target.artifacts.main.installName}@file:${f.target.main.path}`,
        `${f.target.artifacts.backing.installName}@file:${f.target.backing.path}`]);
      expect(JSON.parse(readFileSync(join(modules, "@openai", "codex", "package.json"), "utf8")).version).toBe("1.1.0");
      expect(JSON.parse(readFileSync(join(modules, "@openai", "codex-linux-x64", "package.json"), "utf8")).version).toBe("1.1.0-linux-x64");
      expect(readFileSync(join(modules, "@openai", "codex", "package.json"), "utf8")).toBe(JSON.stringify(f.target.mainManifest) + "\n");
    } finally { removeTreeWithRetry(root); }
  }, 120_000);
  test("verifies the exact main and aliased platform manifest/entrypoint/native bytes", async () => {
    const f = fixtureArtifactSet();
    expect(verifiedCodexCliContent(f.artifacts, await verifyCodexCliArchive(f.main, f.artifacts.main),
      await verifyCodexCliArchive(f.backing, f.artifacts.backing))).toMatch(/^[0-9a-f]{64}$/);
    const metadata = (artifact: typeof f.artifacts.main) => ({ name: artifact.name, version: artifact.version,
      dist: { integrity: artifact.integrity, tarball: artifact.tarball } });
    const set = codexCliArtifactSet({ ...f.mainManifest, ...metadata(f.artifacts.main) },
      spec => { expect(spec).toBe("@openai/codex@1.1.0-linux-x64"); return metadata(f.artifacts.backing); }, "linux", "x64");
    expect(set).toEqual(f.artifacts);
    const observed = await verifyCodexCliArchive(f.backing, f.artifacts.backing);
    expect([...observed].find(([name]) => name.endsWith("/bin/codex"))![1].bytes).toBeNull();
  });
  test("explicit inspection architecture selects the backing independently of the Bun host architecture", () => {
    const f = fixtureArtifactSet("linux", "arm64");
    const set = codexCliArtifactSet({ ...f.mainManifest, dist: { integrity: f.artifacts.main.integrity, tarball: f.artifacts.main.tarball } },
      spec => { expect(spec).toBe("@openai/codex@1.1.0-linux-arm64"); return { name: "@openai/codex", version: f.artifacts.backing.version,
        dist: { integrity: f.artifacts.backing.integrity, tarball: f.artifacts.backing.tarball } }; }, "linux", "arm64");
    expect(set.backing.installName).toBe("@openai/codex-linux-arm64");
  });
  test("readback catches executable-bit loss and preserves exact original modes", () => {
    const target: CodexCliFileSet = new Map([["native", { size: 1, digest: "same", executable: true }]]);
    const observed: CodexCliFileSet = new Map([["native", { size: 1, digest: "same", executable: false, mode: 0o644 }]]);
    expect(sameCodexCliFiles(target, observed)).toBe(false);
    const original: CodexCliFileSet = new Map([["data", { size: 1, digest: "same", executable: false, mode: 0o644 }]]);
    expect(sameCodexCliFiles(original, new Map([["data", { size: 1, digest: "same", executable: false, mode: 0o600 }]]))).toBe(false);
  });
  test("preimage tracks absent target roots in addition to the unchanged selected main/nested backing", () => {
    const root = createCodexCliTestRoot("ocx-apply-preimage-");
    try {
      const main = join(root, "main"), nested = join(main, "node_modules", "backing"), target = join(root, "new-backing");
      mkdirSync(nested, { recursive: true }); writeFileSync(join(main, "package.json"), "old main\n");
      writeFileSync(join(nested, "native"), "old native\n");
      const roots = [main, nested, main, target];
      const before = observeCodexCliPreimage(roots);
      expect(before.absentRoots).toEqual([target]); expect(before.presentRoots).toEqual([main, nested]);
      expect(sameCodexCliPreimage(before, observeCodexCliPreimage(roots))).toBe(true);
      mkdirSync(target); // Even an empty newly created root is a partial mutation.
      expect(sameCodexCliPreimage(before, observeCodexCliPreimage(roots))).toBe(false);
      writeFileSync(join(target, "native"), "new native\n");
      expect(sameCodexCliPreimage(before, observeCodexCliPreimage(roots))).toBe(false);
    } finally { removeTreeWithRetry(root); }
  });
  test("same-version backing integrity drift changes the approved plan identity", () => {
    const f = fixtureArtifactSet();
    const bound = { platform: "linux" as const, provenance: "npm-global" as const, installedVersion: "1.0.0",
      installDigest: "a", installContentDigest: "b", channel: "latest" as const, targetVersion: "1.1.0", targetIntegrity: f.artifacts.main.integrity };
    const digest = (set: typeof f.artifacts) => codexCliUpdatePlanId({ ...bound, targetArtifactsDigest: codexCliArtifactSetDigest(set) });
    expect(digest(f.artifacts)).not.toBe(digest({ ...f.artifacts, backing: { ...f.artifacts.backing, integrity: "changed" } }));
    expect(codexCliArtifactSetDigest(f.artifacts)).toBe(codexCliArtifactSetDigest({ arch: f.artifacts.arch, platform: f.artifacts.platform,
      backing: { ...f.artifacts.backing }, main: { tarball: f.artifacts.main.tarball, integrity: f.artifacts.main.integrity,
        name: f.artifacts.main.name, installName: f.artifacts.main.installName, version: f.artifacts.main.version } }));
  });
  test("archive byte tampering is refused", async () => {
    const f = fixtureArtifactSet(); const changed = Buffer.from(f.main); changed[changed.length - 1] ^= 1;
    await expect(verifyCodexCliArchive(changed, f.artifacts.main)).rejects.toThrow();
  });
  test.each(["valid", "corrupt"] as const)("real-file archive %s closes its stream before return and preserves a reused sentinel fd", async kind => {
    const root = createCodexCliTestRoot("ocx-archive-lifetime-");
    const f = fixtureArtifactSet(), path = join(root, "artifact.tgz"), sentinelPath = join(root, "sentinel");
    writeFileSync(path, kind === "valid" ? f.main : Buffer.from("not gzip")); writeFileSync(sentinelPath, "sentinel");
    const create = fs.createReadStream;
    let captured: { fd: number; closed: boolean; heldAtEnd: boolean; close: Promise<void> } | undefined;
    const spy = spyOn(fs, "createReadStream").mockImplementation((...args) => {
      const stream = create(...args);
      const observed = { fd: Number((args[1] as { fd: number }).fd), closed: false, heldAtEnd: false, close: Promise.resolve() };
      observed.close = new Promise<void>(resolve => stream.once("close", () => { observed.closed = true; resolve(); }));
      stream.once("end", () => { try { observed.heldAtEnd = fs.fstatSync(observed.fd).isFile(); } catch { /* assertion below */ } });
      captured = observed;
      return stream;
    });
    let sentinel: number | undefined;
    let sentinelIdentity: { dev: number; ino: number } | undefined;
    try {
      const verified = await verifyCodexCliArchive(path, f.artifacts.main).then(() => true, () => false);
      const observed = captured!;
      expect(observed).toBeDefined();
      const closedAtReturn = observed.closed;
      // A stale asynchronous archive close used to target this immediately reused fd.
      sentinel = openSync(sentinelPath, "r");
      sentinelIdentity = fs.fstatSync(sentinel);
      await observed.close;
      await new Promise<void>(resolve => setImmediate(resolve));
      let sentinelAlive = false;
      try {
        const after = fs.fstatSync(sentinel), bytes = Buffer.alloc(8);
        sentinelAlive = after.dev === sentinelIdentity.dev && after.ino === sentinelIdentity.ino
          && fs.readSync(sentinel, bytes, 0, 8, 0) === 8 && bytes.toString() === "sentinel";
      } catch { /* assertion below */ }
      expect({ kind, verified, closedAtReturn, sentinelAlive, sentinelReused: sentinel === observed.fd })
        .toEqual({ kind, verified: kind === "valid", closedAtReturn: true, sentinelAlive: true, sentinelReused: true });
      if (kind === "valid") expect(observed.heldAtEnd).toBe(true);
    } finally {
      spy.mockRestore();
      if (captured) await captured.close;
      if (sentinel !== undefined) {
        try {
          const owned = fs.fstatSync(sentinel);
          if (owned.dev === sentinelIdentity?.dev && owned.ino === sentinelIdentity?.ino) closeSync(sentinel);
        } catch { /* old implementation may have closed the sentinel; no unknown fd is closed */ }
      }
      removeTreeWithRetry(root);
    }
  });
  test.skipIf(process.platform === "win32")("real-file archive closure precedes repeated lease acquire/release without touching a sentinel fd", async () => {
    const root = createCodexCliTestRoot("ocx-archive-lease-");
    const f = fixtureArtifactSet(), path = join(root, "artifact.tgz"); writeFileSync(path, f.main);
    const sentinel = openSync(join(root, "sentinel"), "wx+");
    try {
      fs.writeSync(sentinel, "sentinel");
      for (let index = 0; index < 12; index++) {
        await verifyCodexCliArchive(path, f.artifacts.main);
        const lease = acquireCodexCliApplyLease(root); expect(lease.kind).toBe("acquired");
        if (lease.kind !== "acquired") throw new Error("fixture lease unavailable");
        expect(lease.release()).toBe(true);
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(fs.fstatSync(sentinel).size).toBe(8);
      }
    } finally { closeSync(sentinel); removeTreeWithRetry(root); }
  });
  test.skipIf(process.platform === "win32")("lease descriptor-close failure is structured and still permits staging cleanup", () => {
    const root = createCodexCliTestRoot("ocx-lease-close-failure-");
    const stage = join(root, "stage"); mkdirSync(stage);
    const lease = acquireCodexCliApplyLease(root); expect(lease.kind).toBe("acquired");
    if (lease.kind !== "acquired") throw new Error("fixture lease unavailable");
    const close = fs.closeSync;
    const spy = spyOn(fs, "closeSync").mockImplementation(fd => {
      close(fd); throw Object.assign(new Error("injected post-close failure"), { code: "EBADF" });
    });
    try {
      expect(cleanupCodexCliApply(lease, stage)).toEqual({ leaseRetained: true, cleanupErrors: ["lease_release_unverified"] });
      expect(fs.existsSync(stage)).toBe(false);
    } finally { spy.mockRestore(); removeTreeWithRetry(root); }
  });
  test("an oversized tar member refuses from its header before reading or allocating its body", async () => {
    const tar = gunzipSync(fixtureTar({ "package.json": "{}" }));
    tar.write((MAX_CODEX_MEMBER_BYTES + 1).toString(8).padStart(11, "0") + "\0", 124, 12);
    tar.fill(32, 148, 156);
    tar.write(tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(7, "0") + "\0", 148, 8);
    const bytes = gzipSync(tar);
    await expect(verifyCodexCliArchive(bytes, fixtureArtifact(bytes))).rejects.toThrow("artifact_tar_invalid");
  });
  test("an oversized compressed file refuses from fstat without reading its sparse body", async () => {
    const root = createCodexCliTestRoot("ocx-apply-archive-bound-");
    try {
      const path = join(root, "oversize.tgz"), fd = openSync(path, "wx");
      try { ftruncateSync(fd, MAX_CODEX_ARCHIVE_BYTES + 1); } finally { closeSync(fd); }
      await expect(verifyCodexCliArchive(path, fixtureArtifact(Buffer.alloc(0)))).rejects.toThrow("artifact_file_unverified");
    } finally { removeTreeWithRetry(root); }
  });
  test.each(["../escape", "/absolute", "dir/../escape", "bad\\path"])("unsafe archive entry %s is refused", async name => {
    const bytes = fixtureTar({ "package.json": JSON.stringify({ name: "@openai/codex", version: "1.1.0" }), [name]: "x" });
    await expect(verifyCodexCliArchive(bytes, fixtureArtifact(bytes))).rejects.toThrow();
  });
  test("a missing backing binary refuses a verified manifest-only archive", async () => {
    const f = fixtureArtifactSet();
    const bytes = fixtureTar({ "package.json": f.backingFiles["package.json"] });
    const main = await verifyCodexCliArchive(f.main, f.artifacts.main);
    const backing = await verifyCodexCliArchive(bytes, fixtureArtifact(bytes, f.artifacts.backing.version, f.artifacts.backing.installName));
    expect(() => verifiedCodexCliContent(f.artifacts, main, backing)).toThrow();
  });
  test("dependency-bearing archives cannot trigger an installer resolution", async () => {
    const bytes = fixtureTar({ "package.json": JSON.stringify({ name: "@openai/codex", version: "1.1.0", dependencies: { unexpected: "latest" } }) });
    await expect(verifyCodexCliArchive(bytes, fixtureArtifact(bytes))).rejects.toThrow("artifact_dependency_unverified");
  });
});
describe("Codex CLI apply consumer", () => {
  test("admission observes early outcomes and rejections without waiting for an unentered installer", async () => {
    const never = new Promise<void>(() => {});
    const result = { outcome: "refused" as const, reason: "installation_busy", planId: "a".repeat(32), installedVersion: null,
      targetVersion: null, installerExitCode: 17, leaseRetained: false, verificationPid: null, cleanupErrors: [] };
    await expect(waitForApplyAdmission(never, Promise.resolve(result))).rejects.toThrow("outcome=refused reason=installation_busy installerExitCode=17");
    await expect(waitForApplyAdmission(never, Promise.reject(new TypeError("fixture rejection")))).rejects.toThrow("apply rejected before admission: TypeError");
  });
  test("a lease cleanup exception is structured and cannot prevent staging cleanup", () => {
    const root = createCodexCliTestRoot("ocx-apply-cleanup-");
    const stage = join(root, "stage"); mkdirSync(stage); writeFileSync(join(stage, "artifact"), "owned fixture");
    try {
      const cleanup = cleanupCodexCliApply({ release: () => { throw new Error("private native error"); } }, stage);
      expect(cleanup).toEqual({ leaseRetained: true, cleanupErrors: ["lease_release_exception"] });
      expect(fs.existsSync(stage)).toBe(false);
      expect(Object.isFrozen(cleanup.cleanupErrors)).toBe(true);
    } finally { removeTreeWithRetry(root); }
  });
  test("lease and staging cleanup failures are both retained without native error text", () => {
    const root = createCodexCliTestRoot("ocx-apply-cleanup-");
    const stage = join(root, "stage"); mkdirSync(stage);
    const remove = fs.rmSync;
    const spy = spyOn(fs, "rmSync").mockImplementation((path, options) => {
      if (path === stage) throw new Error("private stage path"); return remove(path, options);
    });
    try {
      expect(cleanupCodexCliApply({ release: () => false }, stage)).toEqual({
        leaseRetained: true, cleanupErrors: ["lease_release_unverified", "staging_cleanup_failed"],
      });
      expect(fs.existsSync(stage)).toBe(true);
    } finally { spy.mockRestore(); removeTreeWithRetry(root); }
  });
  test("the owned version probe waits for terminal exit and rejects unrelated version output", async () => {
    const root = createCodexCliTestRoot("ocx-apply-version-");
    try {
      const result = await verifyInstalledCodexVersion(process.execPath, "9.9.9", root, process.env);
      expect(result).toEqual({ terminal: true, ok: false, pid: null });
    } finally { removeTreeWithRetry(root); }
  });
  test("requires explicit exact plan and confirmation, and accepts shared JSON positions", () => {
    const planId = "a".repeat(32);
    const requestId = "apply-parser-test-0001";
    expect(parseCodexCliUpdateArgs(["--json", "apply", `--plan-id=${planId}`, "--yes", "--request-id", requestId]))
      .toEqual({ action: "apply", planId, requestId, json: true });
    for (const args of [["apply"], ["apply", "--yes"], ["apply", "--plan-id", planId],
      ["apply", "--yes", "--yes", "--plan-id", planId], ["apply", "--yes", "--plan-id", "latest"]]) {
      expect(() => parseCodexCliUpdateArgs(args)).toThrow();
    }
  });
  test("malformed apply cannot reach its handler", async () => {
    let calls = 0;
    expect(await handleCodexCliUpdateCommand(["apply", "--yes"], { applyUpdate: async () => { calls++; throw new Error("not reached"); } })).toBe(2);
    expect(calls).toBe(0);
  });
  test.skipIf(process.platform === "win32" || process.geteuid?.() === undefined)("confirmed apply reaches its consumer with the exact plan ID and prints its public result", async () => {
    const planId = "a".repeat(32); let calls = 0; const logs: string[] = [], log = console.log;
    const outer = createCodexCliTestRoot("ocx-apply-cli-job-");
    const previousHome = process.env.OPENCODEX_HOME;
    const report = { outcome: "not_applied" as const, reason: "original_install_unchanged", planId,
      installedVersion: "1.0.0", targetVersion: "1.1.0", installerExitCode: 0, leaseRetained: false, verificationPid: null, cleanupErrors: [] };
    try {
      chmodSync(outer, 0o700);
      const parent = join(outer, "private-parent");
      mkdirSync(parent, { mode: 0o700 });
      chmodSync(parent, 0o700);
      const configPath = join(parent, "ocx");
      mkdirSync(configPath, { mode: 0o700 });
      chmodSync(configPath, 0o700);
      const configDir = realpathSync.native(configPath);
      chmodSync(configDir, 0o700);
      process.env.OPENCODEX_HOME = configDir;
      console.log = value => { logs.push(String(value)); };
      expect(await handleCodexCliUpdateCommand(["apply", "--plan-id", planId, "--yes", "--json"], {
        applyUpdate: async (id, deps) => { calls++; expect(id).toBe(planId); expect(deps.inspectionDeps).toBeDefined(); return report; },
      })).toBe(1);
      expect(calls).toBe(1); expect(logs).toHaveLength(1);
      expect(fs.existsSync(join(configDir, "codex-cli-update-jobs", "jobs.json"))).toBe(true);
      const dto = JSON.parse(logs[0]!) as Record<string, unknown>;
      const matcherDto = structuredClone(dto);
      expect(typeof dto.jobId).toBe("string");
      expect(dto.jobId).toMatch(/^[0-9a-f-]{36}$/);
      expect(matcherDto).toMatchObject({ jobId: expect.stringMatching(/^[0-9a-f-]{36}$/), status: "not_applied",
        ownerState: "finished", lifetimeUncertain: false, childState: "terminal",
        leaseState: "not_acquired_or_released", planId, outcome: "not_applied",
        reason: "original_install_unchanged", cleanupErrors: [],
        createdAt: expect.any(String), updatedAt: expect.any(String) });
      const isIsoUtcTimestamp = (value: unknown) => typeof value === "string"
        && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        && Number.isFinite(Date.parse(value));
      expect(isIsoUtcTimestamp(dto.createdAt)).toBe(true);
      expect(isIsoUtcTimestamp(dto.updatedAt)).toBe(true);
      expect(Object.keys(dto).sort()).toEqual([
        "childState", "cleanupErrors", "createdAt", "jobId", "leaseState", "lifetimeUncertain",
        "outcome", "ownerState", "planId", "reason", "status", "updatedAt",
      ]);
      for (const field of ["requestKey", "payloadHash", "generation", "ownerPid", "verificationPid", "environment", "token", "leaseRetained"]) {
        expect(Object.hasOwn(dto, field)).toBe(false);
      }
    } finally {
      console.log = log;
      if (previousHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previousHome;
      removeTreeWithRetry(outer);
    }
  });
  test("Windows apply never installs when production inspection cannot establish evidence", async () => {
    let calls = 0, installs = 0;
    const result = await applyCodexCliUpdate("a".repeat(32), { platform: "win32", inspect: async () => { calls++; throw new Error("unverified"); },
      install: async () => { installs++; return { terminal: true, exitCode: 0 }; } });
    const supported = process.platform === "win32" && process.arch === "x64";
    expect(result.outcome).toBe("refused"); expect(installs).toBe(0);
    expect(result.reason).toBe(supported ? "preparation_failed" : "windows_inspection_deferred"); expect(calls).toBe(supported ? 1 : 0);
  });
});
