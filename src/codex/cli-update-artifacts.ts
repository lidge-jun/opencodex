import { createHash } from "node:crypto";
import { createGunzip } from "node:zlib";
import { closeSync, constants, createReadStream, fstatSync, lstatSync, openSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseStrictSemver } from "../lib/strict-semver";
import { codexCliContentFileDigest, codexCliContentSetDigest, codexCliPlatformBacking } from "./cli-install-provenance";
import { windowsArchivePathValidator, WINDOWS_CODEX_HEADER_BYTES, WINDOWS_CODEX_NATIVE_MEMBER } from "./cli-update-windows-paths";

export const CODEX_CLI_REGISTRY = "https://registry.npmjs.org";
export interface CodexCliArtifact {
  readonly name: string;
  readonly installName: string;
  readonly version: string;
  readonly integrity: string;
  readonly tarball: string;
}
export interface CodexCliArtifactSet {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly main: CodexCliArtifact;
  readonly backing: CodexCliArtifact;
}
export function isSha512Integrity(token: string): boolean {
  if (!/^sha512-[A-Za-z0-9+/]{86}==$/.test(token)) return false;
  const digest = Buffer.from(token.slice(7), "base64");
  return digest.length === 64 && "sha512-" + digest.toString("base64") === token;
}
export function officialCodexTarball(value: string): boolean {
  try {
    const url = new URL(value);
    return url.origin === CODEX_CLI_REGISTRY && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}
type Metadata = Record<string, any>;
function artifact(meta: Metadata, installName: string): CodexCliArtifact {
  if (typeof meta.name !== "string" || typeof meta.version !== "string" || !parseStrictSemver(meta.version)
    || typeof meta.dist?.integrity !== "string" || !isSha512Integrity(meta.dist.integrity)
    || typeof meta.dist?.tarball !== "string" || !officialCodexTarball(meta.dist.tarball)) throw new Error("artifact_metadata_unverified");
  return Object.freeze({ name: meta.name, installName, version: meta.version,
    integrity: meta.dist.integrity, tarball: meta.dist.tarball });
}
/** Only exact optional-package versions or the publisher's exact npm alias are modeled. */
export function backingReference(main: Metadata, installName: string): { name: string; version: string; spec: string } {
  const dependency = main.optionalDependencies?.[installName];
  const direct = dependency === main.version;
  const alias = `npm:@openai/codex@${main.version}-${installName.slice("@openai/codex-".length)}`;
  if (!direct && dependency !== alias) throw new Error("backing_reference_unverified");
  const name = direct ? installName : "@openai/codex";
  const version = direct ? main.version : alias.slice("npm:@openai/codex@".length);
  return { name, version, spec: `${name}@${version}` };
}
/** Main-metadata guard + reference derivation shared by the sync and async set builders. */
function codexCliArtifactMain(main: Metadata, platform: NodeJS.Platform, arch: string) {
  const layout = codexCliPlatformBacking(platform, arch);
  if (!layout || main.name !== "@openai/codex") throw new Error("artifact_platform_unverified");
  const mainArtifact = artifact(main, "@openai/codex");
  const reference = backingReference(main, layout.package);
  return { layout, mainArtifact, reference };
}
function codexCliArtifactFinish(mainArtifact: CodexCliArtifact,
  reference: { name: string; version: string; spec: string },
  layout: { package: string }, backingMeta: Metadata,
  platform: NodeJS.Platform, arch: string): CodexCliArtifactSet {
  const backing = artifact(backingMeta, layout.package);
  if (backing.name !== reference.name || backing.version !== reference.version) throw new Error("backing_metadata_unverified");
  return Object.freeze({ platform, arch, main: mainArtifact, backing });
}
export function codexCliArtifactSet(main: Metadata, query: (spec: string) => Metadata,
  platform: NodeJS.Platform, arch: string): CodexCliArtifactSet {
  // Main integrity is refused BEFORE the backing query is issued — the tarball query
  // must never run on already-unverified metadata (integrity gate, 2 queries total).
  const { layout, mainArtifact, reference } = codexCliArtifactMain(main, platform, arch);
  return codexCliArtifactFinish(mainArtifact, reference, layout, query(reference.spec), platform, arch);
}
/**
 * The request-path twin of {@link codexCliArtifactSet}: the backing query resolves off the
 * event loop, so a waiting registry child cannot stall the proxy. The platform guard and
 * main-artifact check still run before any backing query is issued.
 */
export async function codexCliArtifactSetAsync(main: Metadata, query: (spec: string) => Promise<Metadata>,
  platform: NodeJS.Platform, arch: string): Promise<CodexCliArtifactSet> {
  const { layout, mainArtifact, reference } = codexCliArtifactMain(main, platform, arch);
  return codexCliArtifactFinish(mainArtifact, reference, layout, await query(reference.spec), platform, arch);
}
export function codexCliArtifactSetDigest(set: CodexCliArtifactSet): string {
  return createHash("sha256").update(JSON.stringify([set.platform, set.arch,
    ...[set.main, set.backing].map(file => [file.name, file.installName, file.version, file.integrity, file.tarball])])).digest("hex");
}

export const MAX_CODEX_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_CODEX_UNPACKED_BYTES = 512 * 1024 * 1024;
export const MAX_CODEX_MEMBER_BYTES = 384 * 1024 * 1024;
export interface CodexArchiveFile { readonly size: number; readonly mode: number; readonly digest: string; readonly bytes: Buffer | null;
  /** Optional bounded prefix from the same integrity-verified member stream, never a second path read. */
  readonly nativePrefix?: Buffer }
export type CodexArchiveFiles = Map<string, CodexArchiveFile>;
/** Stream gzip and tar. Only package.json (256 KiB) and the JS entrypoint (1 MiB)
 * are retained; native binaries and other files contribute a streaming digest.
 * Windows x64 opt-in additionally retains at most 4 KiB of its native member.
 * Official 0.163.0 linux-x64: 162,055,867 compressed, 429,938,138 unpacked,
 * largest member 296,865,480 bytes. Limits are independent, not a heap budget.
 */
export async function verifyCodexCliArchive(source: Buffer | string, target: CodexCliArtifact,
  options: { windowsX64?: boolean } = {}): Promise<CodexArchiveFiles> {
  if (!isSha512Integrity(target.integrity)) throw new Error("artifact_integrity_mismatch");
  let fd: number | undefined;
  let before: ReturnType<typeof fstatSync> | undefined;
  if (typeof source === "string") {
    fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { before = fstatSync(fd); } catch (error) { closeSync(fd); throw error; }
    if (!before.isFile() || before.size > MAX_CODEX_ARCHIVE_BYTES) { closeSync(fd); throw new Error("artifact_file_unverified"); }
  }
  let input: Readable;
  try {
    input = typeof source === "string" ? createReadStream(source, { fd, autoClose: false, emitClose: true, highWaterMark: 64 * 1024 }) : Readable.from([source]);
  } catch (error) { if (fd !== undefined) closeSync(fd); throw error; }
  // The stream exclusively owns fd after construction. In Bun destroy closes
  // even with autoClose:false; that option keeps the fd held through our final
  // identity check, not through an explicit destroy. Never close the raw fd too.
  let inputError: Error | undefined;
  input.on("error", error => { inputError = error; });
  const inputClosed = new Promise<void>(resolve => input.once("close", resolve));
  const archiveHash = createHash("sha512");
  let compressed = 0, unpacked = 0, count = 0, headerSize = 0, padding = 0, trailer = 0;
  let ended = false;
  const header = Buffer.alloc(512);
  const files: CodexArchiveFiles = new Map();
  const names = new Set<string>();
  const windowsName = options.windowsX64 ? windowsArchivePathValidator() : undefined;
  let current: { name: string; size: number; mode: number; remaining: number; keep: boolean;
    chunks: Buffer[]; prefix?: Buffer; hash: ReturnType<typeof createHash> } | undefined;
  let tracker: Transform | undefined, gunzip: ReturnType<typeof createGunzip> | undefined, pumping: Promise<void> | undefined;
  let verified = false;
  try {
    tracker = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      compressed += chunk.length;
      if (compressed > MAX_CODEX_ARCHIVE_BYTES) return callback(new Error("artifact_compressed_limit"));
      archiveHash.update(chunk); callback(null, chunk);
    } });
    gunzip = createGunzip({ chunkSize: 64 * 1024 });
    pumping = pipeline(input, tracker, gunzip);
    void pumping.catch(() => {});
    for await (const data of gunzip) {
      const chunk = Buffer.from(data);
      unpacked += chunk.length;
      if (unpacked > MAX_CODEX_UNPACKED_BYTES) throw new Error("artifact_unpacked_limit");
      let position = 0;
      while (position < chunk.length) {
        if (ended) {
          const tail = chunk.subarray(position);
          if (!tail.every(byte => byte === 0)) throw new Error("artifact_tar_trailing_data");
          trailer += tail.length; break;
        }
        if (padding) { const take = Math.min(padding, chunk.length - position); padding -= take; position += take; continue; }
        if (current) {
          const take = Math.min(current.remaining, chunk.length - position);
          const bytes = chunk.subarray(position, position + take);
          current.hash.update(bytes);
          if (current.keep) current.chunks.push(Buffer.from(bytes));
          const offset = current.size - current.remaining;
          if (current.prefix && offset < current.prefix.length) bytes.copy(current.prefix, offset, 0, current.prefix.length - offset);
          current.remaining -= take; position += take;
          if (!current.remaining) {
            files.set(current.name, { size: current.size, mode: current.mode, digest: current.hash.digest("hex"),
              bytes: current.keep ? Buffer.concat(current.chunks) : null,
              ...(current.prefix ? { nativePrefix: current.prefix } : {}) });
            padding = (512 - current.size % 512) % 512; current = undefined;
          }
          continue;
        }
        const take = Math.min(512 - headerSize, chunk.length - position);
        chunk.copy(header, headerSize, position, position + take); position += take; headerSize += take;
        if (headerSize < 512) continue;
        headerSize = 0;
        if (header.every(byte => byte === 0)) { ended = true; continue; }
        const field = (start: number, length: number) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/s, "");
        const octal = (start: number, length: number) => {
          const value = field(start, length).trim();
          if (!/^[0-7]+$/.test(value)) throw new Error("artifact_tar_invalid");
          return parseInt(value, 8);
        };
        const sum = header.reduce((total, byte, index) => total + (index >= 148 && index < 156 ? 32 : byte), 0);
        if (sum !== octal(148, 8)) throw new Error("artifact_tar_invalid");
        const prefix = field(345, 155);
        const name = (prefix ? prefix + "/" : "") + field(0, 100);
        const type = field(156, 1), size = octal(124, 12), mode = octal(100, 8);
        if (++count > 4096 || !name.startsWith("package/") || /[\\\x00-\x1f]/.test(name)
          || name.replace(/\/$/, "").split("/").some(part => !part || part === ".." || part === ".") || names.has(name)
          || !["", "0", "5"].includes(type) || (type === "5" && size !== 0)
          || (type !== "5" && name.endsWith("/")) || size > MAX_CODEX_MEMBER_BYTES) throw new Error("artifact_tar_invalid");
        names.add(name);
        windowsName?.(name, type === "5");
        if (type === "5") continue;
        const relative = name.slice(8);
        const keep = relative === "package.json" || relative === "bin/codex.js";
        if (keep && size > (relative === "package.json" ? 256 * 1024 : 1024 * 1024)) throw new Error("artifact_metadata_limit");
        current = { name: relative, size, mode, remaining: size, keep, chunks: [],
          ...(options.windowsX64 && relative === WINDOWS_CODEX_NATIVE_MEMBER
            ? { prefix: Buffer.alloc(Math.min(size, WINDOWS_CODEX_HEADER_BYTES)) } : {}),
          hash: createHash("sha256").update("codex-cli-observed-file-v1\0") };
        if (!size) {
          files.set(relative, { size, mode, digest: current.hash.digest("hex"), bytes: keep ? Buffer.alloc(0) : null }); current = undefined;
        }
      }
    }
    await pumping;
    if (!ended || trailer < 512 || current || padding || headerSize) throw new Error("artifact_tar_truncated");
    if ("sha512-" + archiveHash.digest("base64") !== target.integrity) throw new Error("artifact_integrity_mismatch");
    if (fd !== undefined && before && typeof source === "string") {
      const after = fstatSync(fd), lexical = lstatSync(source);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || lexical.isSymbolicLink()
        || lexical.dev !== before.dev || lexical.ino !== before.ino) throw new Error("artifact_file_changed");
    }
    verified = true;
  } finally {
    input.destroy(); tracker?.destroy(); gunzip?.destroy();
    await pumping?.catch(() => {});
    // Reawaiting the pipeline alone does not wait for ReadStream's async close.
    await inputClosed;
    if (verified && inputError) throw new Error("artifact_close_unverified");
  }
  const manifestBytes = files.get("package.json")?.bytes;
  if (!manifestBytes || manifestBytes.length > 256 * 1024 || files.has("npm-shrinkwrap.json") || files.has("package-lock.json")) throw new Error("artifact_manifest_unverified");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.name !== target.name || manifest.version !== target.version) throw new Error("artifact_manifest_unverified");
  for (const key of ["dependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"]) {
    if (manifest[key] && Object.keys(manifest[key]).length) throw new Error("artifact_dependency_unverified");
  }
  return files;
}
export function verifiedCodexCliContent(set: CodexCliArtifactSet, main: CodexArchiveFiles, backing: CodexArchiveFiles): string {
  const layout = codexCliPlatformBacking(set.platform, set.arch);
  if (!layout) throw new Error("artifact_platform_unverified");
  const manifest = JSON.parse(main.get("package.json")!.bytes!.toString("utf8"));
  const ref = backingReference(manifest, layout.package);
  for (const name of Object.keys(manifest.optionalDependencies ?? {})) {
    if (!/^@openai\/codex-(linux|darwin|win32)-(x64|arm64)$/.test(name)) throw new Error("artifact_dependency_unverified");
    backingReference(manifest, name);
  }
  if (ref.name !== set.backing.name || ref.version !== set.backing.version
    || (typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.codex)?.replace(/^\.\//, "") !== "bin/codex.js") throw new Error("artifact_backing_unverified");
  const files = [
    { role: "manifest" as const, file: main.get("package.json") },
    { role: "entrypoint" as const, file: main.get("bin/codex.js") },
    { role: "backing-manifest" as const, file: backing.get("package.json") },
    { role: "backing-binary" as const, file: backing.get(`vendor/${layout.triple}/bin/codex`) },
  ];
  const backingManifest = JSON.parse(backing.get("package.json")!.bytes!.toString("utf8"));
  if (backingManifest.exports || backingManifest.bin || Object.keys(backingManifest.optionalDependencies ?? {}).length
    || files.some(file => !file.file) || !(main.get("bin/codex.js")!.mode & 0o111)
    || !(backing.get(`vendor/${layout.triple}/bin/codex`)!.mode & 0o111)) throw new Error("artifact_backing_unverified");
  return codexCliContentSetDigest(set.platform, set.arch, layout.triple, "optional-package",
    files.map(file => ({ role: file.role, digest: file.role === "manifest" || file.role === "backing-manifest"
      ? codexCliContentFileDigest(file.role, file.file!.bytes!) : file.file!.digest })));
}
