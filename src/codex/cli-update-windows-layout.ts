import { createHash } from "node:crypto";
import { backingReference, codexCliArtifactSet, codexCliArtifactSetDigest, verifyCodexCliArchive,
  type CodexArchiveFiles, type CodexCliArtifactSet } from "./cli-update-artifacts";
import { WINDOWS_CODEX_HEADER_BYTES, WINDOWS_CODEX_NATIVE_MEMBER } from "./cli-update-windows-paths";

export interface WindowsCodexExpectedFile { readonly relativePath: string; readonly size: number; readonly digest: string }
export interface WindowsCodexArchiveLayout {
  readonly schemaVersion: 1;
  readonly applicable: false;
  readonly mutationAuthority: false;
  readonly platform: "win32";
  readonly arch: "x64";
  readonly nativeHeader: "PE32+-AMD64";
  readonly shimContract: "npm-cmd-shim-8-node";
  readonly mainRoot: "node_modules/@openai/codex";
  readonly backingRoot: "node_modules/@openai/codex-win32-x64";
  readonly nativePath: string;
  readonly artifactsDigest: string;
  readonly contentDigest: string;
  readonly files: readonly WindowsCodexExpectedFile[];
}
const MAIN = "node_modules/@openai/codex", BACKING = "node_modules/@openai/codex-win32-x64";
const PACKAGE = "@openai/codex-win32-x64";
// Exact cmd-shim@8.0.0 (ISC) output for the supported node shebang/global-prefix linkage.
// Independent captured outputs live in tests/fixtures/codex-windows-npm-shims.json.
// This is a readback contract, not a shim writer or a claim about every npm version.
const SHIMS: readonly WindowsCodexExpectedFile[] = [
  { relativePath: "codex", size: 421, digest: "e4cfdce20603991a0cc30e79b7080277f934100a317f9c8b2779c0a2f8213ab2" },
  { relativePath: "codex.cmd", size: 341, digest: "0ea5e45d176e31ed39d5b9aad97b58afd6b41f40023508ae5362e151335db803" },
  { relativePath: "codex.ps1", size: 869, digest: "1f82c9b7d42cb3293d459d7304e67f9da76297d1cc33230a3f786c297ee0cc6a" },
];
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
function manifest(files: CodexArchiveFiles): Record<string, any> {
  const bytes = files.get("package.json")?.bytes;
  const value: unknown = bytes && JSON.parse(bytes.toString("utf8"));
  if (!object(value)) throw new Error("artifact_manifest_unverified");
  return value;
}
function validateNative(files: CodexArchiveFiles): void {
  const native = files.get(WINDOWS_CODEX_NATIVE_MEMBER), prefix = native?.nativePrefix;
  if (!native || !prefix || prefix.length !== Math.min(native.size, WINDOWS_CODEX_HEADER_BYTES)
    || prefix.length < 64 || prefix.toString("ascii", 0, 2) !== "MZ") throw new Error("artifact_windows_native_unverified");
  const pe = prefix.readUInt32LE(60);
  if (pe < 64 || pe > prefix.length - 26 || prefix.toString("ascii", pe, pe + 4) !== "PE\0\0"
    || prefix.readUInt16LE(pe + 4) !== 0x8664 || !prefix.readUInt16LE(pe + 6)
    || prefix.readUInt16LE(pe + 20) < 2 || pe + 24 + prefix.readUInt16LE(pe + 20) > native.size
    || !(prefix.readUInt16LE(pe + 22) & 2) || (prefix.readUInt16LE(pe + 22) & 0x2000)
    || prefix.readUInt16LE(pe + 24) !== 0x20b) throw new Error("artifact_windows_native_unverified");
}

/** Read-only artifact verification. Relative paths never select a live prefix or grant write authority.
 * Uses the existing Windows package/Node lookup contract's sibling optional-package lane only.
 * PE header evidence is not a signature, complete image validation or execution proof.
 */
export async function verifyWindowsCodexCliLayout(set: CodexCliArtifactSet, mainSource: Buffer | string,
  backingSource: Buffer | string): Promise<WindowsCodexArchiveLayout> {
  if (set.platform !== "win32" || set.arch !== "x64" || set.main.name !== "@openai/codex"
    || set.main.installName !== "@openai/codex" || set.backing.installName !== PACKAGE) throw new Error("artifact_platform_unverified");
  const main = await verifyCodexCliArchive(mainSource, set.main, { windowsX64: true });
  const backing = await verifyCodexCliArchive(backingSource, set.backing, { windowsX64: true });
  const pkg = manifest(main), platform = manifest(backing);
  // Reuse metadata origin/version and exact direct/alias linkage checks, rather than trusting a structural DTO.
  codexCliArtifactSet({ ...pkg, dist: { integrity: set.main.integrity, tarball: set.main.tarball } },
    () => ({ ...platform, dist: { integrity: set.backing.integrity, tarball: set.backing.tarball } }), "win32", "x64");
  for (const name of Object.keys(pkg.optionalDependencies ?? {})) {
    if (!/^@openai\/codex-(linux|darwin|win32)-(x64|arm64)$/.test(name)) throw new Error("artifact_dependency_unverified");
    backingReference(pkg, name);
  }
  const bin = typeof pkg.bin === "string" ? pkg.bin
    : object(pkg.bin) && Object.keys(pkg.bin).length === 1 ? pkg.bin.codex : null;
  const entry = main.get("bin/codex.js")?.bytes;
  if (typeof bin !== "string" || bin.replace(/^\.\//, "") !== "bin/codex.js" || !entry
    || entry.toString("utf8").split(/\r?\n/, 1)[0] !== "#!/usr/bin/env node"
    || platform.exports !== undefined || platform.bin !== undefined || Object.keys(platform.optionalDependencies ?? {}).length
    || (platform.os !== undefined && (!Array.isArray(platform.os) || platform.os.length !== 1 || platform.os[0] !== "win32"))
    || (platform.cpu !== undefined && (!Array.isArray(platform.cpu) || platform.cpu.length !== 1 || platform.cpu[0] !== "x64"))) {
    throw new Error("artifact_backing_unverified");
  }
  validateNative(backing);
  const files: WindowsCodexExpectedFile[] = SHIMS.map(file => ({ ...file }));
  for (const [root, archive] of [[MAIN, main], [BACKING, backing]] as const) {
    for (const [relative, proof] of archive) {
      // npm aliases are installed as explicit sibling packages. No embedded package may shadow that lookup.
      if (relative.split("/").some(part => part.toLowerCase() === "node_modules")) throw new Error("artifact_backing_unverified");
      files.push({ relativePath: `${root}/${relative}`, size: proof.size, digest: proof.digest });
    }
  }
  files.sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
  const artifactsDigest = codexCliArtifactSetDigest(set);
  const contentDigest = createHash("sha256").update("codex-cli-windows-layout-v1\0")
    .update(JSON.stringify([artifactsDigest, files])).digest("hex");
  return Object.freeze({ schemaVersion: 1, applicable: false, mutationAuthority: false, platform: "win32", arch: "x64",
    nativeHeader: "PE32+-AMD64", shimContract: "npm-cmd-shim-8-node", mainRoot: MAIN, backingRoot: BACKING,
    nativePath: `${BACKING}/${WINDOWS_CODEX_NATIVE_MEMBER}`, artifactsDigest, contentDigest,
    files: Object.freeze(files.map(file => Object.freeze(file))) });
}

/** Compare the two package roots and three shim paths, not unrelated files in the global prefix.
 * No filesystem reads, mode guesses or partial matches.
 * The caller still owes held-file/linkage/selection proof; equal content is not mutation authority.
 */
export function matchesWindowsCodexCliLayout(expected: WindowsCodexArchiveLayout,
  observed: readonly WindowsCodexExpectedFile[]): boolean {
  if (expected.files.length !== observed.length) return false;
  const actual = new Map(observed.map(file => [file.relativePath, file]));
  return actual.size === observed.length && expected.files.every(file => {
    const other = actual.get(file.relativePath);
    return other?.size === file.size && other.digest === file.digest;
  });
}
