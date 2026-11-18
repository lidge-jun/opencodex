import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { getConfigDir } from "../config/paths";
import { packageVersion } from "../lib/package-version";

export const CHILD_TARGET_TRIPLES = [
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "linux-arm64",
  "windows-x64",
] as const;

export type ChildTargetTriple = typeof CHILD_TARGET_TRIPLES[number];
export type ChildBinarySourceKind = "env" | "sidecar" | "local-release" | "cache";
export type PlantUnavailableReason = "unsupported_target" | "artifact_not_found" | "checksum_mismatch";

export interface VerifiedChildBinaryArtifact {
  readonly targetTriple: ChildTargetTriple;
  readonly bytes: Uint8Array;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly source: ChildBinarySourceKind;
}

export type ChildBinaryResolution =
  | { readonly ok: true; readonly artifact: VerifiedChildBinaryArtifact }
  | { readonly ok: false; readonly reason: PlantUnavailableReason };

export interface ResolveChildBinaryOptions {
  readonly env?: Record<string, string | undefined>;
  readonly hostPlatform?: NodeJS.Platform;
  readonly hostArch?: string;
  readonly opencodexHome?: string;
  readonly version?: string;
  readonly execPath?: string;
  readonly repoRoot?: string;
  readonly allowLocalRelease?: boolean;
}

const MAX_CHILD_BINARY_BYTES = 32 * 1024 * 1024;
const MAX_SHA256SUMS_BYTES = 256 * 1024;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export function isChildTargetTriple(value: unknown): value is ChildTargetTriple {
  return typeof value === "string" && (CHILD_TARGET_TRIPLES as readonly string[]).includes(value);
}

export function hostChildTargetTriple(
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): ChildTargetTriple | null {
  if (platform === "darwin" && architecture === "arm64") return "darwin-arm64";
  if (platform === "darwin" && architecture === "x64") return "darwin-x64";
  if (platform === "linux" && architecture === "x64") return "linux-x64";
  if (platform === "linux" && architecture === "arm64") return "linux-arm64";
  if (platform === "win32" && architecture === "x64") return "windows-x64";
  return null;
}

export function childArtifactFilename(targetTriple: ChildTargetTriple): string {
  return targetTriple.startsWith("windows-") ? `ocx-child-${targetTriple}.exe` : `ocx-child-${targetTriple}`;
}

export function childPlainExecutableName(targetTriple: ChildTargetTriple): string {
  return targetTriple.startsWith("windows-") ? "ocx-child.exe" : "ocx-child";
}

function isSafeDirectory(dirPath: string): boolean {
  try {
    const st = lstatSync(dirPath);
    return st.isDirectory() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function readSafeRegularFile(filePath: string, maxBytes: number, hostPlatform: NodeJS.Platform): Uint8Array | null {
  let st;
  try {
    st = lstatSync(filePath);
  } catch {
    return null;
  }
  if (!st.isFile() || st.isSymbolicLink()) return null;
  if (st.size <= 0 || st.size > maxBytes) return null;
  if (hostPlatform !== "win32" && (st.mode & 0o022) !== 0) return null;
  let buf: Buffer;
  try {
    buf = readFileSync(filePath);
  } catch {
    return null;
  }
  if (buf.byteLength <= 0 || buf.byteLength > maxBytes) return null;
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export function parseSha256Sums(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^([0-9A-Fa-f]{64})\s+\*?([^\s/\\]+)$/.exec(line);
    if (!match) continue;
    entries.set(match[2]!, match[1]!.toLowerCase());
  }
  return entries;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifyManifestCandidate(
  candidatePath: string,
  targetTriple: ChildTargetTriple,
  source: ChildBinarySourceKind,
  hostPlatform: NodeJS.Platform,
): ChildBinaryResolution | null {
  let rawStat;
  try {
    rawStat = lstatSync(candidatePath);
  } catch {
    return null;
  }
  const dir = dirname(candidatePath);
  if (!isSafeDirectory(dir) || !rawStat.isFile() || rawStat.isSymbolicLink()) {
    return { ok: false, reason: "checksum_mismatch" };
  }
  const sumsBytes = readSafeRegularFile(join(dir, "SHA256SUMS"), MAX_SHA256SUMS_BYTES, hostPlatform);
  if (!sumsBytes) return { ok: false, reason: "checksum_mismatch" };
  const sums = parseSha256Sums(new TextDecoder("utf-8").decode(sumsBytes));
  const expected = sums.get(basename(candidatePath));
  if (!expected || !SHA256_HEX.test(expected)) return { ok: false, reason: "checksum_mismatch" };
  const bytes = readSafeRegularFile(candidatePath, MAX_CHILD_BINARY_BYTES, hostPlatform);
  if (!bytes) return { ok: false, reason: "checksum_mismatch" };
  const actual = sha256Hex(bytes);
  if (actual !== expected) return { ok: false, reason: "checksum_mismatch" };
  return {
    ok: true,
    artifact: { targetTriple, bytes, sizeBytes: bytes.byteLength, sha256: actual, source },
  };
}

/** What an operator must do when Home cannot plant ocx-child, for the CLI and the API message. */
export function plantUnavailableGuidance(reason: string | undefined, targetTriple: string | null, version: string = packageVersion("0.0.0")): string {
  if (reason === "artifact_not_found" && targetTriple && isChildTargetTriple(targetTriple)) {
    const file = childArtifactFilename(targetTriple);
    return "No verified ocx-child build for " + targetTriple + " is available on this Home. Put " + file + " and a SHA256SUMS file that lists it in the directory named by OPENCODEX_CHILD_BIN_DIR, or in $OPENCODEX_HOME/cache/ocx-child/" + version + "/, then try again.";
  }
  if (reason === "checksum_mismatch") {
    return "An ocx-child build for " + (targetTriple ?? "this target") + " was found on this Home but failed verification: it needs a matching SHA256SUMS entry, must not be a symlink, and must not be group- or world-writable.";
  }
  return "ocx-child has no build for this Child's platform (" + (targetTriple ?? "unknown target") + ").";
}

export function resolveChildBinarySource(
  targetTriple: ChildTargetTriple | null,
  options: ResolveChildBinaryOptions = {},
): ChildBinaryResolution {
  if (!targetTriple || !isChildTargetTriple(targetTriple)) return { ok: false, reason: "unsupported_target" };
  const env = options.env ?? process.env;
  const hostPlatform = options.hostPlatform ?? process.platform;
  const hostArch = options.hostArch ?? process.arch;
  const hostTriple = hostChildTargetTriple(hostPlatform, hostArch);
  const artifactFile = childArtifactFilename(targetTriple);
  const plainExe = childPlainExecutableName(targetTriple);
  const repoRoot = options.repoRoot ?? resolve(import.meta.dir, "..", "..");

  const envDir = env.OPENCODEX_CHILD_BIN_DIR?.trim();
  if (envDir) {
    if (!isSafeDirectory(envDir)) {
      try { lstatSync(envDir); return { ok: false, reason: "checksum_mismatch" }; } catch { /* absent */ }
    } else {
      const envCandidates = [
        join(envDir, artifactFile),
        join(envDir, targetTriple, plainExe),
        ...(targetTriple === hostTriple ? [join(envDir, plainExe)] : []),
      ];
      for (const candidate of envCandidates) {
        const res = verifyManifestCandidate(candidate, targetTriple, "env", hostPlatform);
        if (res) return res;
      }
    }
  }

  const execDir = dirname(options.execPath ?? process.execPath);
  const sidecarCandidates = [
    join(repoRoot, "native-bin", targetTriple, plainExe),
    join(repoRoot, "native-bin", artifactFile),
    join(execDir, artifactFile),
    join(execDir, "native-bin", targetTriple, plainExe),
  ];
  for (const candidate of sidecarCandidates) {
    const res = verifyManifestCandidate(candidate, targetTriple, "sidecar", hostPlatform);
    if (res) return res;
  }

  if (options.allowLocalRelease !== false && targetTriple === hostTriple) {
    const localRelease = join(repoRoot, "native", "ocx-child", "target", "release", plainExe);
    if (existsSync(localRelease)) {
      const relDir = dirname(localRelease);
      const bytes = isSafeDirectory(relDir) ? readSafeRegularFile(localRelease, MAX_CHILD_BINARY_BYTES, hostPlatform) : null;
      if (!bytes) return { ok: false, reason: "checksum_mismatch" };
      return {
        ok: true,
        artifact: {
          targetTriple,
          bytes,
          sizeBytes: bytes.byteLength,
          sha256: sha256Hex(bytes),
          source: "local-release",
        },
      };
    }
  }

  // With no Home and no environment passed, the Home is the one the rest of OpenCodex uses (getConfigDir:
  // trimmed, ~ expanded, resolved), which is where the startup fill writes ocx-child-builds/. An injected
  // environment keeps its literal reading. An empty OPENCODEX_HOME counts as unset, as in ocx-child.
  const ocxHome = options.opencodexHome
    || (options.env ? env.OPENCODEX_HOME?.trim() || join(env.HOME || homedir(), ".opencodex") : getConfigDir());
  const version = options.version ?? packageVersion("0.0.0");
  // A build an operator placed in cache/ocx-child/ first, then the one the Home filled after an update
  // (ocx-child-builds/, src/link/child-binary-cache-fill.mjs); both need a SHA256SUMS that lists them.
  for (const dir of [join(ocxHome, "cache", "ocx-child"), join(ocxHome, "ocx-child-builds")]) {
    const cacheRes = verifyManifestCandidate(join(dir, version, artifactFile), targetTriple, "cache", hostPlatform);
    if (cacheRes) return cacheRes;
  }

  return { ok: false, reason: "artifact_not_found" };
}

