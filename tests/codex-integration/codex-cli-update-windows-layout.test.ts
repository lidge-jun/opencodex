import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync, gzipSync } from "node:zlib";
import { fixturePath } from "../helpers/repo-root";
import { fixtureArtifact, fixtureArtifactSet, fixtureTar } from "../helpers/codex-cli-apply-artifact";
import { verifiedCodexCliContent, verifyCodexCliArchive, type CodexCliArtifactSet } from "../../src/codex/cli-update-artifacts";
import { matchesWindowsCodexCliLayout, verifyWindowsCodexCliLayout } from "../../src/codex/cli-update-windows-layout";

const MAIN = "node_modules/@openai/codex", BACKING = "node_modules/@openai/codex-win32-x64";
const NATIVE = "vendor/x86_64-pc-windows-msvc/bin/codex.exe", PACKAGE = "@openai/codex-win32-x64";
const fileDigest = (bytes: string | Buffer) => createHash("sha256").update("codex-cli-observed-file-v1\0").update(bytes).digest("hex");
function pe(machine = 0x8664, size = 65539): Buffer {
  const bytes = Buffer.alloc(size, 0x61);
  bytes.write("MZ"); bytes.writeUInt32LE(128, 60); bytes.write("PE\0\0", 128);
  bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150); bytes.writeUInt16LE(0x20b, 152);
  return bytes;
}
function fixture(alias = true) {
  const version = "1.2.3", backingVersion = alias ? `${version}-win32-x64` : version;
  const backingName = alias ? "@openai/codex" : PACKAGE;
  const mainFiles: Record<string, string | Buffer> = {
    "package.json": JSON.stringify({ name: "@openai/codex", version, bin: { codex: "bin/codex.js" },
      optionalDependencies: { [PACKAGE]: alias ? `npm:@openai/codex@${backingVersion}` : version } }),
    "bin/codex.js": "#!/usr/bin/env node\n// Synthetic entrypoint; never executed.\n",
    "README.md": "main auxiliary\n",
  };
  const backingFiles: Record<string, string | Buffer> = {
    "package.json": JSON.stringify({ name: backingName, version: backingVersion, os: ["win32"], cpu: ["x64"] }),
    [NATIVE]: pe(), "vendor/auxiliary.txt": "backing auxiliary\n",
  };
  const build = () => {
    const main = fixtureTar(mainFiles), backing = fixtureTar(backingFiles);
    const set: CodexCliArtifactSet = { platform: "win32", arch: "x64", main: fixtureArtifact(main, version),
      backing: fixtureArtifact(backing, backingVersion, PACKAGE, backingName) };
    return { main, backing, set };
  };
  return { mainFiles, backingFiles, build };
}
const verify = (f: ReturnType<typeof fixture>) => {
  const input = f.build(); return verifyWindowsCodexCliLayout(input.set, input.main, input.backing);
};
function editManifest(files: Record<string, string | Buffer>, change: (manifest: Record<string, any>) => void) {
  const value = JSON.parse(String(files["package.json"])); change(value); files["package.json"] = JSON.stringify(value);
}
function rewriteTar(bytes: Buffer, change: (header: Buffer, name: string) => void): Buffer {
  const tar = gunzipSync(bytes);
  for (let offset = 0; offset < tar.length && tar[offset];) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, "");
    const size = parseInt(header.subarray(124, 136).toString(), 8);
    change(header, name);
    header.fill(32, 148, 156);
    header.write(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(7, "0") + "\0", 148, 8);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return gzipSync(tar);
}

describe("independent Windows x64 artifact layout", () => {
  test.each([true, false])("verified %s alias backing yields only relative whole-file expectations", async alias => {
    const f = fixture(alias), layout = await verify(f);
    expect(layout).toMatchObject({ applicable: false, mutationAuthority: false, platform: "win32", arch: "x64",
      mainRoot: MAIN, backingRoot: BACKING, nativePath: `${BACKING}/${NATIVE}`, nativeHeader: "PE32+-AMD64" });
    expect(layout.files).toHaveLength(9);
    expect(layout.files.find(file => file.relativePath === `${BACKING}/${NATIVE}`)).toMatchObject({
      size: 65539, digest: fileDigest(f.backingFiles[NATIVE]!),
    });
    expect(Object.isFrozen(layout)).toBe(true); expect(Object.isFrozen(layout.files)).toBe(true);
    expect(layout.files.every(file => Object.isFrozen(file) && !file.relativePath.includes(":"))).toBe(true);
    expect(matchesWindowsCodexCliLayout(layout, [...layout.files].reverse())).toBe(true);
  });
  test("three exact npm shim expectations match independently captured cmd-shim 8 output", async () => {
    // Offline byte-contract regression only. The fixture records the separately verified
    // registry artifact, raw source hashes and actual exported-function generation receipt.
    const capture = JSON.parse(readFileSync(fixturePath("codex-windows-npm-shims.json"), "utf8"));
    const layout = await verify(fixture());
    expect(capture.source).toContain("cmd-shim@8.0.0");
    for (const name of ["codex", "codex.cmd", "codex.ps1"]) {
      const bytes = Buffer.from(capture.files[name]);
      expect(layout.files.find(file => file.relativePath === name)).toEqual({ relativePath: name, size: bytes.length, digest: fileDigest(bytes) });
      const wrong = layout.files.map(file => file.relativePath === name ? { ...file,
        size: bytes.length + 1, digest: fileDigest(Buffer.concat([bytes, Buffer.from("x")])) } : file);
      expect(matchesWindowsCodexCliLayout(layout, wrong)).toBe(false);
    }
  });
  test("the full verified stream binds native hash and retains at most 4 KiB, with no second file read", async () => {
    const f = fixture(), input = f.build();
    const files = await verifyCodexCliArchive(input.backing, input.set.backing, { windowsX64: true });
    expect(files.get(NATIVE)!.bytes).toBeNull();
    expect(files.get(NATIVE)!.nativePrefix).toEqual((f.backingFiles[NATIVE] as Buffer).subarray(0, 4096));
    expect(files.get(NATIVE)!.digest).toBe(fileDigest(f.backingFiles[NATIVE]!));
    expect([...files].filter(([, file]) => file.nativePrefix !== undefined).map(([name]) => name)).toEqual([NATIVE]);
    const plain = await verifyCodexCliArchive(input.backing, input.set.backing);
    expect(plain.get(NATIVE)!.nativePrefix).toBeUndefined();
  });
  test.each(["arm64", "x86"])("other requested architecture %s is not admitted", async arch => {
    const f = fixture().build();
    await expect(verifyWindowsCodexCliLayout({ ...f.set, arch }, f.main, f.backing)).rejects.toThrow("artifact_platform_unverified");
  });
  test.each(["missing", "arm64", "x86", "not-pe", "header-outside-prefix", "dll", "pe32", "truncated"])("native %s refuses", async kind => {
    const f = fixture();
    if (kind === "missing") { delete f.backingFiles[NATIVE]; f.backingFiles[NATIVE.replace(/\.exe$/, "")] = pe(); }
    else {
      const bytes = pe(kind === "arm64" ? 0xaa64 : kind === "x86" ? 0x14c : 0x8664);
      if (kind === "not-pe") bytes.write("??");
      if (kind === "header-outside-prefix") bytes.writeUInt32LE(4096, 60);
      if (kind === "dll") bytes.writeUInt16LE(0x2002, 150);
      if (kind === "pe32") bytes.writeUInt16LE(0x10b, 152);
      f.backingFiles[NATIVE] = kind === "truncated" ? bytes.subarray(0, 150) : bytes;
    }
    await expect(verify(f)).rejects.toThrow("artifact_windows_native_unverified");
  });
  test.each(["wrong-bin", "extra-bin", "missing-js", "wrong-shebang", "wrong-link", "nested-package", "cpu", "exports"])("linkage %s refuses", async kind => {
    const f = fixture();
    if (kind === "wrong-bin") editManifest(f.mainFiles, pkg => pkg.bin.codex = "evil.js");
    if (kind === "extra-bin") editManifest(f.mainFiles, pkg => pkg.bin.extra = "evil.js");
    if (kind === "missing-js") delete f.mainFiles["bin/codex.js"];
    if (kind === "wrong-shebang") f.mainFiles["bin/codex.js"] = "#!/usr/bin/env node --eval evil\n";
    if (kind === "wrong-link") editManifest(f.mainFiles, pkg => pkg.optionalDependencies[PACKAGE] = "latest");
    if (kind === "nested-package") f.mainFiles[`bin/node_modules/${PACKAGE}/package.json`] = "{}";
    if (kind === "cpu") editManifest(f.backingFiles, pkg => pkg.cpu = ["arm64"]);
    if (kind === "exports") editManifest(f.backingFiles, pkg => pkg.exports = {});
    await expect(verify(f)).rejects.toThrow();
  });
  test.each(["README.MD", "BIN/extra", "bin", "name:stream", "NUL.txt", "COM1.log", "AUX/file", "CONIN$", "dir./file",
    "trailing /file", "name?", "non-ascii-한글", "../escape", "bad\\path"])("Windows ambiguous or unsafe member %s refuses", async name => {
    const f = fixture(); f.mainFiles[name] = "x";
    await expect(verify(f)).rejects.toThrow();
  });
  test("empty directory records receive the same Windows path validation", async () => {
    const f = fixture(); f.mainFiles["NUL"] = "";
    const input = f.build(), main = rewriteTar(input.main, (header, name) => { if (name === "package/NUL") header.write("5", 156); });
    await expect(verifyWindowsCodexCliLayout({ ...input.set, main: fixtureArtifact(main, "1.2.3") }, main, input.backing))
      .rejects.toThrow("artifact_windows_path_unverified");
  });
  test("Windows ignores POSIX executable bits without changing the POSIX content validator", async () => {
    const f = fixture().build(), clearMode = (header: Buffer) => { header.write("0000644\0", 100, 8); };
    const main = rewriteTar(f.main, clearMode), backing = rewriteTar(f.backing, clearMode);
    const set = { ...f.set, main: fixtureArtifact(main, "1.2.3"), backing: fixtureArtifact(backing, "1.2.3-win32-x64", PACKAGE) };
    expect((await verifyWindowsCodexCliLayout(set, main, backing)).nativeHeader).toBe("PE32+-AMD64");
    const posix = fixtureArtifactSet();
    const posixMain = await verifyCodexCliArchive(posix.main, posix.artifacts.main);
    expect(verifiedCodexCliContent(posix.artifacts, posixMain,
      await verifyCodexCliArchive(posix.backing, posix.artifacts.backing))).toMatch(/^[a-f0-9]{64}$/);
    const notExecutable = rewriteTar(posix.backing, clearMode);
    const files = await verifyCodexCliArchive(notExecutable, fixtureArtifact(notExecutable, posix.artifacts.backing.version, posix.artifacts.backing.installName));
    expect(() => verifiedCodexCliContent(posix.artifacts, posixMain, files)).toThrow();
  });
  test("auxiliary content, missing/extra files and duplicate readback paths cannot share a full match", async () => {
    const f = fixture(), before = await verify(f);
    f.backingFiles["vendor/auxiliary.txt"] = "changed auxiliary\n";
    const after = await verify(f);
    expect(before.contentDigest).not.toBe(after.contentDigest);
    expect(matchesWindowsCodexCliLayout(before, after.files)).toBe(false);
    expect(matchesWindowsCodexCliLayout(before, before.files.slice(1))).toBe(false);
    expect(matchesWindowsCodexCliLayout(before, [...before.files, before.files[0]!])).toBe(false);
    expect(matchesWindowsCodexCliLayout(before, [before.files[0]!, ...before.files.slice(0, -1)])).toBe(false);
  });
  test("archive corruption and non-registry metadata refuse before any layout is returned", async () => {
    const input = fixture().build(), corrupted = Buffer.from(input.backing); corrupted[corrupted.length - 1] ^= 1;
    await expect(verifyWindowsCodexCliLayout(input.set, input.main, corrupted)).rejects.toThrow();
    const foreign = { ...input.set, main: { ...input.set.main, tarball: "https://example.invalid/archive.tgz" } };
    await expect(verifyWindowsCodexCliLayout(foreign, input.main, input.backing)).rejects.toThrow("artifact_metadata_unverified");
  });
});
