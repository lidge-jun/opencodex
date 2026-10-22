import { describe, expect, test } from "bun:test";
import { codexCliArtifactSet, codexCliArtifactSetDigest, MAX_CODEX_ARCHIVE_BYTES, MAX_CODEX_MEMBER_BYTES, verifyCodexCliArchive, verifiedCodexCliContent } from "../../src/codex/cli-update-artifacts";
import { codexCliUpdatePlanId } from "../../src/codex/cli-update-plan";
import { fixtureArtifact, fixtureArtifactSet, fixtureTar } from "../helpers/codex-cli-apply-artifact";
import { applyCodexCliUpdate, verifyInstalledCodexVersion } from "../../src/codex/cli-update-apply";
import { parseCodexCliUpdateArgs, handleCodexCliUpdateCommand } from "../../src/cli/codex-cli-update";
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexCliApplyFixture } from "../helpers/codex-cli-apply-fixture";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { sameCodexCliFiles, type CodexCliFileSet } from "../../src/codex/cli-update-files";

describe("Codex CLI apply artifacts", () => {
  test("real npm installs main and platform aliases from local tarballs into a private prefix offline", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-apply-alias-"));
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
  test("an oversized tar member refuses from its header before reading or allocating its body", async () => {
    const tar = gunzipSync(fixtureTar({ "package.json": "{}" }));
    tar.write((MAX_CODEX_MEMBER_BYTES + 1).toString(8).padStart(11, "0") + "\0", 124, 12);
    tar.fill(32, 148, 156);
    tar.write(tar.subarray(0, 512).reduce((sum, byte) => sum + byte, 0).toString(8).padStart(7, "0") + "\0", 148, 8);
    const bytes = gzipSync(tar);
    await expect(verifyCodexCliArchive(bytes, fixtureArtifact(bytes))).rejects.toThrow("artifact_tar_invalid");
  });
  test("an oversized compressed file refuses from fstat without reading its sparse body", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-apply-archive-bound-"));
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
  test("the owned version probe waits for terminal exit and rejects unrelated version output", async () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-apply-version-"));
    try {
      const result = await verifyInstalledCodexVersion(process.execPath, "9.9.9", root, process.env);
      expect(result).toEqual({ terminal: true, ok: false, pid: null });
    } finally { removeTreeWithRetry(root); }
  });
  test("requires explicit exact plan and confirmation, and accepts shared JSON positions", () => {
    const planId = "a".repeat(32);
    expect(parseCodexCliUpdateArgs(["--json", "apply", `--plan-id=${planId}`, "--yes"]))
      .toEqual({ action: "apply", planId, json: true });
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
  test("confirmed apply reaches its consumer with the exact plan ID and prints its public result", async () => {
    const planId = "a".repeat(32); let calls = 0; const logs: string[] = [], log = console.log;
    const report = { outcome: "not_applied" as const, reason: "original_install_unchanged", planId,
      installedVersion: "1.0.0", targetVersion: "1.1.0", installerExitCode: 0, leaseRetained: false, verificationPid: null };
    try {
      console.log = value => { logs.push(String(value)); };
      expect(await handleCodexCliUpdateCommand(["apply", "--plan-id", planId, "--yes", "--json"], {
        applyUpdate: async (id, deps) => { calls++; expect(id).toBe(planId); expect(deps.inspectionDeps).toBeDefined(); return report; },
      })).toBe(0);
      expect(calls).toBe(1); expect(logs).toHaveLength(1); expect(JSON.parse(logs[0]!)).toEqual(report);
    } finally { console.log = log; }
  });
  test("Windows apply refuses before inspecting or installing", async () => {
    let calls = 0;
    const result = await applyCodexCliUpdate("a".repeat(32), { platform: "win32", inspect: async () => { calls++; throw new Error("not reached"); } });
    expect(result.reason).toBe("windows_inspection_deferred"); expect(calls).toBe(0);
  });
});
