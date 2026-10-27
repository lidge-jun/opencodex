import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { posix, win32 } from "node:path";
import { getConfigDir } from "../config";
import { parseStrictSemver } from "../lib/strict-semver";
import { CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS } from "../update/codex-cli-update-launch-policy.mjs";
import { isSpawnableCodexCandidate } from "./exec-invocation";
import {
  codexRuntimeStatePath,
  parsePersistedCodexRuntime,
  resolveCodexRuntime,
  type ResolveCodexRuntimeDeps,
  type ResolveCodexRuntimeResult,
} from "./runtime";
import {
  inspectCodexShimBackingForCommand,
  isLocalAbsoluteInspectionPath,
  isVersionManagerOwnedCodexPath,
  type CodexShimBackingForCommand,
} from "./shim";

const CODEX_PACKAGE = "@openai/codex";
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_RUNTIME_STATE_BYTES = 256 * 1024;
const MAX_MANIFEST_ANCESTORS = 12;
/** The published package entrypoint is a few KB; 1 MiB leaves wide headroom. */
const MAX_PACKAGE_ENTRYPOINT_BYTES = 1024 * 1024;
/**
 * The native companion binary is streamed in HELD_READ_CHUNK_BYTES chunks and
 * never buffered whole, so this bound limits read time, not memory. Published
 * backings outgrew the former 256 MiB: `@openai/codex@0.163.0-linux-x64` ships a
 * 296,865,480-byte binary, in platform packages of 341-430 MB unpacked. 1 GiB
 * leaves more than 3x headroom over that binary while staying finite; larger
 * files are refused by fstat before any read.
 */
export const MAX_NATIVE_BACKING_BYTES = 1024 * 1024 * 1024;
const HELD_READ_CHUNK_BYTES = 1024 * 1024;

export type CodexCliInstallKind =
  | "npm-global"
  | "app-bundle"
  | "version-manager"
  | "standalone-unverified"
  | "unknown";

export type CodexCliInstallReason =
  | "candidate_unavailable"
  | "candidate_path_unavailable"
  | "candidate_path_unsafe"
  | "windows_inspection_deferred"
  | "shim_state_unknown"
  | "shim_update_deferred"
  | "app_bundle"
 | "version_manager_owned"
 | "npm_global_unverified"
  | "managed_npm_global"
 | "selection_unattested"
 | "version_mismatch"
 | "unverified_standalone"
 | "inspection_failed";

export type CodexCliCandidateSource = "environment" | "persisted";
export type CodexCliInstallEvidence =
  | "canonical_path"
  | "app_bundle_path"
  | "version_manager_path"
  | "package_manifest"
  | "package_manifest_digest"
  | "install_content_digest"
  | "shim_backing"
  | "global_npm_layout";

export interface ReadOnlyCodexRuntimeCandidate {
  readonly command: string;
  readonly version: string | null;
  readonly evidence: CodexCliCandidateSource;
}

export interface CodexCliInstallReport {
  readonly schemaVersion: 1;
  readonly candidateAvailable: boolean;
  readonly candidateVersion: string | null;
  readonly candidateSource: CodexCliCandidateSource | null;
  readonly selectionAttested: boolean;
  readonly versionEvidence: Readonly<{
    kind: "package-manifest" | "advisory-runtime" | "unavailable";
  }>;
  readonly provenance: CodexCliInstallKind;
  readonly managed: boolean;
  readonly reason: CodexCliInstallReason;
  readonly location: string | null;
  /**
   * sha256 digest of the canonical package manifest root when one was observed,
   * otherwise null. Digest-only so the public report still carries no path; plan
   * identity binds this value so two different install roots cannot share a plan.
   */
  readonly installDigest: string | null;
  /**
   * sha256 digest over the bounded content observation of the versioned file
   * set the supported npm-global layout defines: the package manifest, its
   * declared bin/codex.js entrypoint, and the platform backing package manifest
   * plus vendored binary at the locations the layout's modeled Node lookup
   * produces. This binds the bytes that were actually read under a
   * held-identity window; it is not an execution guarantee. It does not prove
   * which bytes a launcher run would execute, that the files are authentic
   * upstream artifacts, or that the rest of the install tree is unchanged — a
   * later apply phase must re-observe under its own held handles rather than
   * treating this plan-time digest as durable proof. Null when the caller did
   * not request the observation or when the required set could not be bound.
   */
  readonly installContentDigest: string | null;
  readonly packageVersion: string | null;
  readonly shim: Readonly<{
    status: "not-tracked" | "matched" | "unknown";
    backingKind: "backup" | "real" | null;
  }>;
  readonly evidence: readonly CodexCliInstallEvidence[];
}

export interface CodexCliInstallProvenanceDeps {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly configDir?: string;
  readonly exists?: (path: string) => boolean;
  readonly lstat?: typeof lstatSync;
  readonly stat?: typeof statSync;
  readonly readFile?: (path: string) => Buffer;
  readonly boundedFileReadMode?: "native-hardened" | "injected-test";
  readonly realpath?: (path: string) => string;
  /**
   * The architecture the launcher would report for its own interpreter. The
   * published entrypoint picks its native backing by (platform, arch); the
   * value is recorded inside the content digest so a different launcher
   * architecture can never silently share a plan.
   */
  readonly arch?: NodeJS.Architecture;
  /**
   * Opt-in switch for the bounded install-content observation. Reading the
   * required file set can stream a vendored binary of up to
   * MAX_NATIVE_BACKING_BYTES, so a caller that only needs the ownership
   * classification leaves this unset and receives a null installContentDigest;
   * the update-plan path sets it because its planId binds the digest.
   */
  readonly observeInstallContent?: boolean;
  readonly inspectShim?: (
    command: string,
    platform: NodeJS.Platform,
    configDir: string,
  ) => CodexShimBackingForCommand;
  /**
   * Caller assertion that `env.CODEX_CLI_PATH` is the runtime the launcher actually
   * selected, not merely a configured name. Only a proof-bound caller may set this;
   * a persisted selection and an arbitrary environment stay unattested.
   */
  readonly selectionAttested?: boolean;
  /**
   * The command the runtime resolver actually selected under the same evidence.
   * Attestation additionally requires its canonical path to match the inspected
   * candidate, so a snapshot candidate the resolver would have rejected cannot
   * turn a different installation managed.
   */
  readonly selectedCommand?: string | null;
}

interface PackageManifestEvidence {
  readonly path: string;
  readonly root: string;
  readonly binPath: string;
  readonly version: string;
  readonly digest: string;
}

function sha256(domain: string, value: string | Uint8Array): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(value)
    .digest("hex");
}

function validatedVersion(value: string | null | undefined): string | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  return parseStrictSemver(value, 96)?.raw ?? null;
}

function publicExecutableLocation(path: string, platform: NodeJS.Platform): string {
  const raw = pathTools(platform).basename(path).toLowerCase();
  const safe = ["codex", "codex.exe", "codex.cmd", "codex.bat", "codex.com", "codex.js"].includes(raw)
    ? raw : "codex";
  return `<path>/${safe}`;
}

function freezeReport(report: CodexCliInstallReport): CodexCliInstallReport {
  Object.freeze(report.shim);
  Object.freeze(report.evidence);
  return Object.freeze(report);
}

function unknownReport(
  reason: CodexCliInstallReason,
  candidate?: ReadOnlyCodexRuntimeCandidate,
  extra: Partial<Pick<CodexCliInstallReport, "location">> = {},
): CodexCliInstallReport {
  return freezeReport({
    schemaVersion: 1,
    candidateAvailable: Boolean(candidate),
    candidateVersion: candidate?.version ?? null,
    candidateSource: candidate?.evidence ?? null,
    selectionAttested: false,
    versionEvidence: Object.freeze({
      kind: candidate?.version ? "advisory-runtime" as const : "unavailable" as const,
    }),
    provenance: "unknown",
    managed: false,
    reason,
    location: extra.location ?? null,
    installDigest: null,
    installContentDigest: null,
    packageVersion: null,
    shim: Object.freeze({ status: "not-tracked", backingKind: null }),
    evidence: Object.freeze([]),
  });
}

function unknownWindowsReport(
  reason: CodexCliInstallReason,
  candidate?: ReadOnlyCodexRuntimeCandidate,
  extra: Partial<Pick<CodexCliInstallReport, "location">> = {},
): CodexCliInstallReport {
  return freezeReport({
    ...unknownReport(reason, candidate, extra),
    shim: Object.freeze({ status: "unknown", backingKind: null }),
  });
}

function readPersistedCandidate(
  deps: CodexCliInstallProvenanceDeps,
): ReadOnlyCodexRuntimeCandidate | null {
  // A pathname-only Windows read cannot prove that a writable ancestor stayed
  // local and non-reparse between validation and open. PR1 therefore accepts
  // only the proof-captured environment candidate on Windows; persisted-state
  // inspection requires the later handle-bound Windows provenance layer.
  if ((deps.platform ?? process.platform) === "win32") return null;
  const configDir = deps.configDir ?? getConfigDir();
  if (!isSafeLocalInspectionPath(configDir, deps)) return null;
  try {
    const statePath = codexRuntimeStatePath(configDir);
    const bytes = readBoundedFile(statePath, MAX_RUNTIME_STATE_BYTES, deps);
    if (!bytes) return null;
    const parsed = parsePersistedCodexRuntime(
      bytes,
    );
    if (!parsed) return null;
    return {
      command: parsed.command,
      version: validatedVersion(parsed.selectedVersion),
      evidence: "persisted",
    };
  } catch {
    return null;
  }
}

/**
 * Observe configured candidate evidence without launching Codex, creating a
 * probe home, or persisting a replacement selection.
 */
export function observeCodexRuntimeCandidateReadOnly(
  deps: CodexCliInstallProvenanceDeps = {},
): ReadOnlyCodexRuntimeCandidate | null {
  const env = deps.env ?? process.env;
  const configured = env.CODEX_CLI_PATH?.trim();
  if (configured) {
    return {
      command: configured,
      version: null,
      evidence: "environment",
    };
  }
  return readPersistedCandidate(deps);
}

function pathTools(platform: NodeJS.Platform): typeof posix | typeof win32 {
  return platform === "win32" ? win32 : posix;
}

function isWindowsPlatform(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

function isSafeLocalInspectionPath(
  path: string,
  deps: CodexCliInstallProvenanceDeps,
): boolean {
  const platform = deps.platform ?? process.platform;
  return isLocalAbsoluteInspectionPath(path, platform);
}

function caseInsensitiveEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const entry = Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1];
}

function resolveCandidateCommandPath(
  command: string,
  deps: CodexCliInstallProvenanceDeps,
): string | null {
  const platform = deps.platform ?? process.platform;
  // Windows inspection returns before this resolver until the next slice can
  // bind command resolution and wrapper reads to stable filesystem handles.
  if (isWindowsPlatform(platform)) return null;
  const exists = deps.exists ?? existsSync;
  const lstat = deps.lstat ?? lstatSync;
  const stat = deps.stat ?? statSync;
  const usable = (path: string): boolean => {
    if (!isSafeLocalInspectionPath(path, deps)) return false;
    try {
      const entry = lstat(path);
      if (!exists(path) || (!entry.isFile() && !entry.isSymbolicLink()) || !isSpawnableCodexCandidate(path, platform)) return false;
      if (platform !== "win32") {
        const target = stat(path);
        if (!target.isFile() || (target.mode & 0o111) === 0) return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  const env = deps.env ?? process.env;
  const tools = pathTools(platform);
  const explicit = tools.isAbsolute(command) || command.includes("/") || command.includes("\\");
  if (explicit) return usable(command) ? command : null;
  const pathValue = env.PATH ?? "";
  const names = [command];
  for (const entry of pathValue.split(tools.delimiter)) {
    // Empty and relative entries name the current working directory. Either can
    // shadow a later absolute hit and therefore makes the candidate path unknown.
    if (!entry || !isSafeLocalInspectionPath(entry, deps)) return null;
    for (const name of names) {
      const candidate = tools.join(entry, name);
      if (usable(candidate)) return candidate;
    }
  }
  return null;
}

/** Resolve selection under inspection's bounded, local-only filesystem policy. */
export function observeCodexCliSelectedCommand(
  deps: CodexCliInstallProvenanceDeps,
  resolve: (deps: ResolveCodexRuntimeDeps) => ResolveCodexRuntimeResult = resolveCodexRuntime,
): string | null {
  const platform = deps.platform ?? process.platform;
  // Even the general resolver's existence checks can touch a remote Windows
  // candidate. Deferred inspection must return before invoking it at all.
  if (platform === "win32") return null;
  const configDir = deps.configDir ?? getConfigDir();
  if (!isSafeLocalInspectionPath(configDir, deps)) return null;
  try {
    return resolve({
      platform,
      env: deps.env,
      configDir,
      discoverAlternatives: false,
      probeVersion: false,
      // Runtime and shim state must use the same no-follow, nonblocking,
      // size-bounded descriptor reads as provenance, including before selection.
      readFileSync: path => {
        const bytes = readBoundedFile(path, MAX_RUNTIME_STATE_BYTES, deps);
        if (!bytes) throw new Error("inspection_state_unavailable");
        return bytes.toString("utf8");
      },
      existsSync: path => resolveCandidateCommandPath(path, deps) !== null,
    }).runtime.command ?? null;
  } catch {
    return null;
  }
}

function canonicalize(path: string, deps: CodexCliInstallProvenanceDeps): string | null {
  if (!isSafeLocalInspectionPath(path, deps)) return null;
  try {
    const canonical = (deps.realpath ?? realpathSync.native)(path);
    return isSafeLocalInspectionPath(canonical, deps) ? canonical : null;
  } catch {
    return null;
  }
}

function normalizePath(path: string, platform: NodeJS.Platform): string {
  const slashNormalized = platform === "win32" ? path.replace(/\\/g, "/") : path;
  const normalized = platform !== "win32" && /^\/+$/u.test(slashNormalized)
    ? "/"
    : slashNormalized.replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  return normalizePath(left, platform) === normalizePath(right, platform);
}

export function isAppBundledCodexPath(path: string, platform: NodeJS.Platform): boolean {
  const normalized = normalizePath(path, platform);
  if (platform === "win32") {
    return normalized.includes("/windowsapps/")
      || normalized.includes("/microsoft/windowsapps/")
      || normalized.includes("/packages/openai.codex_");
  }
  if (platform === "darwin") return /[.]app\/contents\//i.test(normalized);
  return normalized.startsWith("/snap/") || normalized.includes("/flatpak/app/");
}

/** Updater ownership is intentionally broader than shim-repair refusal. */
export function isCodexCliUpdateVersionManagerPath(
  path: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = (platform === "win32"
    ? win32.normalize(path).replace(/\\/g, "/")
    : posix.normalize(path)).toLowerCase();
  if (isVersionManagerOwnedCodexPath(normalized, platform)) return true;
  return normalized.includes("/.nvm/")
    || normalized.includes("/nvm/versions/")
    || /\/nvm\/v?\d+(?:[.]\d+){1,2}(?:\/|$)/.test(normalized)
    || normalized.includes("/.proto/")
    || normalized.includes("/proto/tools/")
    || normalized.includes("/.nodenv/")
    || normalized.includes("/nodenv/versions/")
    || normalized.includes("/.nvs/")
    || normalized.includes("/nvs/node/")
    || normalized.includes("/.fnm/")
    || normalized.includes("/fnm/node-versions/")
    || normalized.includes("/fnm_multishells/")
    || (platform === "win32" && (
      normalized.includes("/scoop/apps/")
      || normalized.includes("/scoop/shims/")
    ));
}

function configuredVersionManagerRoots(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  deps: CodexCliInstallProvenanceDeps,
): readonly string[] {
  const roots: string[] = [];
  for (const name of CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS) {
    const raw = platform === "win32" ? caseInsensitiveEnv(env, name) : env[name];
    if (!raw || !isLocalAbsoluteInspectionPath(raw, platform)) continue;
    // Windows roots are advisory lexical labels only in this first slice. Do
    // not resolve or open them until the handle-bound Windows layer exists.
    if (platform === "win32") {
      roots.push(normalizePath(win32.normalize(raw), platform));
      continue;
    }
    const canonical = isSafeLocalInspectionPath(raw, deps) ? canonicalize(raw, deps) : null;
    if (canonical) roots.push(normalizePath(canonical, platform));
  }
  return Object.freeze([...new Set(roots)]);
}

function isWithinConfiguredVersionManagerRoot(path: string, roots: readonly string[], platform: NodeJS.Platform): boolean {
  const candidate = normalizePath(path, platform);
  return roots.some(root => {
    const filesystemRoot = root === "/" || (platform === "win32" && /^[a-z]:$/i.test(root));
    return candidate === root || (!filesystemRoot && candidate.startsWith(`${root}/`));
  });
}

function readBoundedFile(
  path: string,
  maxBytes: number,
  deps: CodexCliInstallProvenanceDeps,
): Buffer | null {
  if (!isSafeLocalInspectionPath(path, deps)) return null;
  // Production inspection accepts only a direct regular file. This prevents a
  // persisted-state or manifest symlink from silently redirecting a nominally
  // local check. Virtual filesystem tests may omit lstat and retain their
  // injected stat/read behavior.
  const inspectLexical = deps.lstat
    ?? (deps.stat === undefined && deps.readFile === undefined ? lstatSync : null);
  let lexicalBefore: ReturnType<typeof lstatSync> | null = null;
  if (inspectLexical) {
    try {
      lexicalBefore = inspectLexical(path);
      if (lexicalBefore.isSymbolicLink() || !lexicalBefore.isFile()) return null;
    } catch {
      return null;
    }
  }
  const useInjectedReader = deps.boundedFileReadMode === "injected-test";
  if (!useInjectedReader) {
    let fd: number | null = null;
    try {
      const flags = process.platform === "win32"
        ? fsConstants.O_RDONLY
        : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
      fd = openSync(path, flags);
      const before = fstatSync(fd);
      if (!before.isFile() || before.size > maxBytes) return null;
      const bytes = Buffer.allocUnsafe(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (count <= 0) return null;
        offset += count;
      }
      const extra = Buffer.allocUnsafe(1);
      if (readSync(fd, extra, 0, 1, offset) !== 0) return null;
      const after = fstatSync(fd);
      const lexicalAfter = inspectLexical ? inspectLexical(path) : null;
      if (lexicalAfter?.isSymbolicLink()) return null;
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
        || (lexicalBefore !== null && (lexicalAfter === null || lexicalAfter.isSymbolicLink()
          || lexicalBefore.dev !== before.dev || lexicalBefore.ino !== before.ino
          || lexicalAfter.dev !== after.dev || lexicalAfter.ino !== after.ino
          || lexicalAfter.size !== after.size || lexicalAfter.mtimeMs !== after.mtimeMs
          || lexicalAfter.ctimeMs !== after.ctimeMs))) return null;
      return bytes;
    } catch {
      return null;
    } finally {
      if (fd !== null) closeSync(fd);
    }
  }
  if (!deps.stat || !deps.readFile) return null;
  const stat = deps.stat;
  const read = deps.readFile;
  try {
    const before = stat(path);
    if (!before.isFile() || before.size > maxBytes) return null;
    const bytes = read(path);
    const after = stat(path);
    const lexicalAfter = inspectLexical ? inspectLexical(path) : null;
    if (
      bytes.byteLength !== before.size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || (lexicalBefore !== null && (lexicalAfter === null || lexicalAfter.isSymbolicLink()
        || lexicalBefore.dev !== before.dev || lexicalBefore.ino !== before.ino
        || lexicalAfter.dev !== after.dev || lexicalAfter.ino !== after.ino))
    ) return null;
    return bytes;
  } catch {
    return null;
  }
}

function manifestCandidates(
  logicalPath: string,
  canonicalPath: string,
  platform: NodeJS.Platform,
): string[] {
  const tools = pathTools(platform);
  const candidates: string[] = [];
  let cursor = tools.dirname(canonicalPath);
  for (let depth = 0; depth < MAX_MANIFEST_ANCESTORS; depth += 1) {
    candidates.push(tools.join(cursor, "package.json"));
    const parent = tools.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  const binDir = tools.dirname(logicalPath);
  if (platform === "win32") {
    candidates.push(tools.join(binDir, "node_modules", "@openai", "codex", "package.json"));
  } else {
    const prefix = tools.dirname(binDir);
    candidates.push(tools.join(prefix, "lib", "node_modules", "@openai", "codex", "package.json"));
    candidates.push(tools.join(prefix, "node_modules", "@openai", "codex", "package.json"));
  }
  return [...new Set(candidates)];
}

function manifestBinPath(bin: unknown): string | null {
  const raw = typeof bin === "string"
    ? bin
    : bin && typeof bin === "object" && !Array.isArray(bin)
      ? (bin as Record<string, unknown>).codex
      : null;
  if (typeof raw !== "string") return null;
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  return normalized === "bin/codex.js" ? normalized : null;
}

function findCodexPackageManifest(
  logicalPath: string,
  canonicalPath: string,
  deps: CodexCliInstallProvenanceDeps,
): PackageManifestEvidence | null {
  const platform = deps.platform ?? process.platform;
  for (const candidate of manifestCandidates(logicalPath, canonicalPath, platform)) {
    const bytes = readBoundedFile(candidate, MAX_MANIFEST_BYTES, deps);
    if (!bytes) continue;
    try {
      const value = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      const version = validatedVersion(typeof value.version === "string" ? value.version : null);
      if (value.name !== CODEX_PACKAGE || !version) continue;
      const binPath = manifestBinPath(value.bin);
      if (!binPath) continue;
      const root = canonicalize(pathTools(platform).dirname(candidate), deps);
      const path = canonicalize(candidate, deps);
      if (!root || !path) continue;
      return {
        path,
        root,
        binPath,
        version,
        digest: sha256("codex-cli-package-manifest-v1", bytes),
      };
    } catch {
      continue;
    }
  }
  return null;
}

function launcherIsLinkedToManifest(
  canonicalOwnershipPath: string,
  manifest: PackageManifestEvidence,
  deps: CodexCliInstallProvenanceDeps,
): boolean {
  const platform = deps.platform ?? process.platform;
  const tools = pathTools(platform);
  const entrypoint = canonicalize(tools.join(manifest.root, ...manifest.binPath.split("/")), deps);
  if (!entrypoint) return false;
  const normalizedRoot = normalizePath(manifest.root, platform);
  const normalizedEntrypoint = normalizePath(entrypoint, platform);
  if (!normalizedEntrypoint.startsWith(`${normalizedRoot}/`)) return false;
  if (samePath(canonicalOwnershipPath, entrypoint, platform)) return true;
  return false;
}

function isProvenGlobalNpmLayout(
  launcherPath: string,
  packageRoot: string,
  platform: NodeJS.Platform,
  deps: CodexCliInstallProvenanceDeps,
): boolean {
  const tools = pathTools(platform);
  const launcherName = tools.basename(launcherPath).toLowerCase();
  if (launcherName !== (platform === "win32" ? "codex.cmd" : "codex")) return false;
  const root = normalizePath(packageRoot, platform);
  // Keep the POSIX launcher itself lexical because npm commonly installs it as
  // a symlink into the package. Canonicalize only its parent so a symlinked or
  // case-aliased npm prefix is compared against the canonical manifest root.
  const launcherParent = tools.dirname(launcherPath);
  const canonicalLauncherParent = platform === "win32"
    ? launcherParent
    : canonicalize(launcherParent, deps);
  if (!canonicalLauncherParent) return false;
  const launcherDir = normalizePath(canonicalLauncherParent, platform);
  const suffix = "/node_modules/@openai/codex";
  if (!root.endsWith(suffix)) return false;
  const beforeNodeModules = root.slice(0, -suffix.length);
  if (platform === "win32") return launcherDir === beforeNodeModules;
  if (!beforeNodeModules.endsWith("/lib")) return false;
  const prefix = beforeNodeModules.slice(0, -"/lib".length);
  return launcherDir === `${prefix}/bin`;
}

function shimReport(shim: CodexShimBackingForCommand): CodexCliInstallReport["shim"] {
  if (shim.status === "matched") {
    return Object.freeze({ status: "matched" as const, backingKind: shim.backingKind });
  }
  if (shim.status === "unknown") {
    return Object.freeze({ status: "unknown" as const, backingKind: null });
  }
  return Object.freeze({ status: "not-tracked" as const, backingKind: null });
}

/**
 * The published @openai/codex bin/codex.js selection table, mirrored as layout
 * knowledge: the supported npm-global layout places the platform backing
 * package where Node's module lookup from the package's bin directory finds
 * "<package>/package.json", then "<package-dir>/vendor/<triple>/bin/codex"
 * (codex.exe on Windows), with an in-package "vendor/<triple>" fallback when
 * that resolve would throw. This table locates files for observation; it does
 * not prove which file a launcher run would select. A launcher following a
 * different rule simply produces different observed entrypoint bytes.
 */
const CODEX_PLATFORM_BACKING: Readonly<Record<string, Readonly<{ triple: string; package: string }>>> = {
  "linux:x64": { triple: "x86_64-unknown-linux-musl", package: "@openai/codex-linux-x64" },
  "linux:arm64": { triple: "aarch64-unknown-linux-musl", package: "@openai/codex-linux-arm64" },
  "android:x64": { triple: "x86_64-unknown-linux-musl", package: "@openai/codex-linux-x64" },
  "android:arm64": { triple: "aarch64-unknown-linux-musl", package: "@openai/codex-linux-arm64" },
  "darwin:x64": { triple: "x86_64-apple-darwin", package: "@openai/codex-darwin-x64" },
  "darwin:arm64": { triple: "aarch64-apple-darwin", package: "@openai/codex-darwin-arm64" },
  "win32:x64": { triple: "x86_64-pc-windows-msvc", package: "@openai/codex-win32-x64" },
  "win32:arm64": { triple: "aarch64-pc-windows-msvc", package: "@openai/codex-win32-arm64" },
};

/** Node's Module._nodeModulePaths: every ancestor's node_modules child, closest first. */
function nodeModuleDirs(fromDir: string, platform: NodeJS.Platform): string[] {
  const tools = pathTools(platform);
  const dirs: string[] = [];
  let cursor = fromDir;
  for (;;) {
    // A directory literally named "node_modules" contributes no nested
    // node_modules entry of its own in Node's lookup.
    if (tools.basename(cursor) !== "node_modules") dirs.push(tools.join(cursor, "node_modules"));
    const parent = tools.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return dirs;
}

/**
 * Node's global lookup list for the launcher process: NODE_PATH entries first,
 * then $HOME/.node_modules and $HOME/.node_libraries, then the lib/node directory
 * beside the install prefix of the node binary the captured PATH resolves.
 * 'complete' is false when any input cannot be modeled from the bound
 * environment — in that case 'require.resolve threw' cannot be proven and the
 * in-package vendor fallback lane stays unverifiable.
 */
function globalModuleDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  deps: CodexCliInstallProvenanceDeps,
): { dirs: string[]; complete: boolean } {
  const tools = pathTools(platform);
  const dirs: string[] = [];
  let complete = true;
  const nodePath = platform === "win32" ? caseInsensitiveEnv(env, "NODE_PATH") : env.NODE_PATH;
  if (nodePath) {
    for (const entry of nodePath.split(tools.delimiter)) {
      if (!entry) continue;
      // Node resolves a relative NODE_PATH entry against the launcher process's
      // cwd, which this read-only inspection cannot know.
      if (isSafeLocalInspectionPath(entry, deps)) dirs.push(tools.resolve(entry));
      else complete = false;
    }
  }
  const home = platform === "win32"
    ? caseInsensitiveEnv(env, "USERPROFILE") ?? caseInsensitiveEnv(env, "HOME")
    : env.HOME;
  if (home && isSafeLocalInspectionPath(home, deps)) {
    dirs.push(tools.join(home, ".node_modules"), tools.join(home, ".node_libraries"));
  } else {
    complete = false;
  }
  const nodeCommand = resolveCandidateCommandPath("node", deps);
  const canonicalNode = nodeCommand ? canonicalize(nodeCommand, deps) : null;
  if (canonicalNode) {
    // POSIX node lives at <prefix>/bin/node, so the lookup prefix is two levels
    // up; a Windows prefix sits beside the executable. The win32 arm is
    // unreachable today — inspection returns before any candidate I/O there.
    const prefix = platform === "win32"
      ? tools.dirname(canonicalNode)
      : tools.dirname(tools.dirname(canonicalNode));
    dirs.push(tools.join(prefix, "lib", "node"));
  } else {
    complete = false;
  }
  return { dirs, complete };
}

interface InstallContentFile {
  readonly role: "manifest" | "entrypoint" | "backing-manifest" | "backing-binary";
  readonly path: string;
  readonly maxBytes: number;
}

interface ObservedContentFile {
  readonly digest: string;
  /** Retained only for small role files; the streamed binary keeps none. */
  readonly bytes: Buffer | null;
}

function fileContentDomain(role: InstallContentFile["role"]): string {
  return role === "manifest" ? "codex-cli-package-manifest-v1" : "codex-cli-observed-file-v1";
}

/**
 * Hash every requested file under one observation window. Native POSIX mode
 * opens all files first (O_NOFOLLOW | O_NONBLOCK), streams each digest, then
 * re-verifies every descriptor's identity and each canonical path's linkage
 * before returning. Injected-test mode performs the equivalent stat -> read ->
 * stat sequence per file plus a final identity pass over the whole set. The
 * optional finalize hook runs its own checks while the held set is still open,
 * so linkage and selector re-verification completes inside the window rather
 * than after the descriptors close. Any read, size, identity or finalize
 * failure inside the window fails the set closed.
 */
function observeHeldFileSet(
  requests: readonly InstallContentFile[],
  deps: CodexCliInstallProvenanceDeps,
  finalize?: () => boolean,
): Map<string, ObservedContentFile> | null {
  const keepBytes = (role: InstallContentFile["role"]): boolean => role !== "backing-binary";
  if (deps.boundedFileReadMode === "injected-test") {
    const stat = deps.stat;
    const read = deps.readFile;
    if (!stat || !read) return null;
    const results = new Map<string, ObservedContentFile>();
    const identities: { before: Stats; req: InstallContentFile }[] = [];
    try {
      for (const req of requests) {
        const before = stat(req.path);
        if (!before.isFile() || before.size > req.maxBytes) return null;
        const bytes = read(req.path);
        const after = stat(req.path);
        if (bytes.byteLength !== before.size
          || before.dev !== after.dev || before.ino !== after.ino
          || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return null;
        identities.push({ before, req });
        results.set(req.role, {
          digest: sha256(fileContentDomain(req.role), bytes),
          bytes: keepBytes(req.role) ? bytes : null,
        });
      }
      // A replacement that slipped in after a file's own read still failed.
      for (const { before, req } of identities) {
        const now = stat(req.path);
        if (before.dev !== now.dev || before.ino !== now.ino
          || before.size !== now.size || before.mtimeMs !== now.mtimeMs) return null;
      }
      if (finalize && !finalize()) return null;
      return results;
    } catch {
      return null;
    }
  }
  const held: { fd: number; req: InstallContentFile; before: Stats }[] = [];
  const openedFds: number[] = [];
  try {
    const flags = process.platform === "win32"
      ? fsConstants.O_RDONLY
      : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    for (const req of requests) {
      if (!isSafeLocalInspectionPath(req.path, deps)) return null;
      const fd = openSync(req.path, flags);
      // The descriptor joins the close set before any check that can bail, so
      // an fstat failure or a refused type/size cannot leak it.
      openedFds.push(fd);
      const before = fstatSync(fd);
      // O_NONBLOCK keeps a FIFO open nonblocking, so the type check must come
      // first: anything that is not a regular file is refused before a read.
      if (!before.isFile() || before.size > req.maxBytes) return null;
      held.push({ fd, req, before });
    }
    const results = new Map<string, ObservedContentFile>();
    for (const { fd, req, before } of held) {
      const hasher = createHash("sha256")
        .update(fileContentDomain(req.role), "utf8")
        .update("\0", "utf8");
      const bytes = keepBytes(req.role) ? Buffer.allocUnsafe(before.size) : null;
      const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(HELD_READ_CHUNK_BYTES, before.size)));
      let offset = 0;
      while (offset < before.size) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
        if (count <= 0) return null;
        hasher.update(chunk.subarray(0, count));
        if (bytes) chunk.copy(bytes, offset, 0, count);
        offset += count;
      }
      // A file that grew inside the window is a different file than was hashed.
      if (readSync(fd, chunk, 0, 1, offset) !== 0) return null;
      results.set(req.role, { digest: hasher.digest("hex"), bytes });
    }
    for (const { fd, req, before } of held) {
      const after = fstatSync(fd);
      const lexical = lstatSync(req.path);
      const followed = statSync(req.path);
      if (before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs
        || lexical.isSymbolicLink() || !lexical.isFile()
        || lexical.dev !== before.dev || lexical.ino !== before.ino
        || followed.dev !== before.dev || followed.ino !== before.ino) return null;
    }
    if (finalize && !finalize()) return null;
    return results;
  } catch {
    return null;
  } finally {
    for (const fd of openedFds) {
      try { closeSync(fd); } catch { /* the observation already failed */ }
    }
  }
}

/**
 * Bind the versioned file set the supported npm-global layout defines: the
 * manifest, its declared bin/codex.js entrypoint, and the platform backing
 * (manifest plus vendored binary) at the locations the layout's modeled Node
 * lookup produces. The bound set is deliberately small and versioned; this is
 * not an execution proof, an artifact-authenticity claim, or a
 * whole-tree-integrity claim.
 */
function observeInstallContent(
  manifest: PackageManifestEvidence,
  npmPrefix: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  deps: CodexCliInstallProvenanceDeps,
  selection: { readonly lexical: string; readonly canonical: string },
): string | null {
  const arch = deps.arch ?? process.arch;
  const backing = CODEX_PLATFORM_BACKING[platform + ":" + arch];
  if (!backing) return null;
  const tools = pathTools(platform);
  const normalizedPrefix = normalizePath(npmPrefix, platform);
  // A filesystem-root prefix cannot bound anything; treat it as unsupported.
  if (!normalizedPrefix || normalizedPrefix === "/") return null;
  const withinPrefix = (path: string): boolean => {
    const normalized = normalizePath(path, platform);
    return normalized === normalizedPrefix || normalized.startsWith(normalizedPrefix + "/");
  };
  // Every lexical path that produced a bound canonical target — the selected
  // launcher included — is re-resolved at the window's final observed boundary.
  // Held descriptors do not prevent link mutation; this check observes whether
  // the selection still reaches the bound files at that instant.
  const links: { readonly lexical: string; readonly canonical: string }[] = [
    { lexical: selection.lexical, canonical: selection.canonical },
  ];
  const canonicalBound = (path: string): string | null => {
    const canonical = canonicalize(path, deps);
    if (!canonical || !withinPrefix(canonical)) return null;
    links.push({ lexical: path, canonical });
    return canonical;
  };
  const entrypoint = canonicalBound(tools.join(manifest.root, ...manifest.binPath.split("/")));
  if (!entrypoint) return null;

  const globals = globalModuleDirs(env, platform, deps);
  const lstat = deps.lstat ?? lstatSync;
  // Probe one modeled lookup lane in order; the first hit wins.
  const probeDirs = (
    dirs: readonly string[],
  ): { kind: "none" } | { kind: "hit"; path: string; dir: string } | { kind: "refuse" } => {
    for (const dir of dirs) {
      const probe = tools.join(dir, ...backing.package.split("/"), "package.json");
      let entry;
      try {
        entry = lstat(probe);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") continue;
        return { kind: "refuse" };
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      // First hit wins, matching the lookup order the layout models.
      const canonical = canonicalize(probe, deps);
      if (!canonical || !withinPrefix(canonical)) return { kind: "refuse" };
      links.push({ lexical: probe, canonical });
      return { kind: "hit", path: canonical, dir: tools.dirname(canonical) };
    }
    return { kind: "none" };
  };
  const probeBacking = (): ReturnType<typeof probeDirs> => {
    const local = probeDirs(nodeModuleDirs(tools.dirname(entrypoint), platform));
    if (local.kind !== "none") return local;
    // Missing lookup seeds leave unknown earlier global lanes. Even an
    // observed in-prefix global hit cannot prove which package wins there.
    if (!globals.complete) return { kind: "refuse" };
    return probeDirs(globals.dirs);
  };
  const selectedBacking = probeBacking();
  if (selectedBacking.kind === "refuse") return null;
  const backingManifestPath = selectedBacking.kind === "hit" ? selectedBacking.path : null;
  const backingPackageDir = selectedBacking.kind === "hit" ? selectedBacking.dir : null;

  const binName = platform === "win32" ? "codex.exe" : "codex";
  const backingBinary = canonicalBound(backingPackageDir
    ? tools.join(backingPackageDir, "vendor", backing.triple, "bin", binName)
    : tools.join(manifest.root, "vendor", backing.triple, "bin", binName));
  // The launcher cannot run without the vendored binary; a missing one makes
  // the required set incomplete, not merely shorter.
  if (!backingBinary) return null;

  const requests: InstallContentFile[] = [
    { role: "manifest", path: manifest.path, maxBytes: MAX_MANIFEST_BYTES },
    { role: "entrypoint", path: entrypoint, maxBytes: MAX_PACKAGE_ENTRYPOINT_BYTES },
    ...(backingManifestPath
      ? [{ role: "backing-manifest" as const, path: backingManifestPath, maxBytes: MAX_MANIFEST_BYTES }]
      : []),
    { role: "backing-binary", path: backingBinary, maxBytes: MAX_NATIVE_BACKING_BYTES },
  ];
  const observed = observeHeldFileSet(requests, deps, () => {
    // Re-run the selector after the final file identity pass, while native
    // descriptors remain open. An earlier lane gaining a package or the
    // selected one disappearing makes the bound set ambiguous.
    const selectedAgain = probeBacking();
    if (selectedAgain.kind !== selectedBacking.kind
      || (selectedAgain.kind === "hit" && selectedBacking.kind === "hit"
        && selectedAgain.path !== selectedBacking.path)) return false;
    // A canonical-path lstat cannot see a retargeted lexical selection link.
    for (const link of links) {
      const resolved = canonicalize(link.lexical, deps);
      if (!resolved || !samePath(resolved, link.canonical, platform)) return false;
    }
    return true;
  });
  if (!observed) return null;
  // The manifest was already hashed once while provenance was being decided.
  // If the bytes read now differ, ownership answered a different file than the
  // content claim would describe.
  if (observed.get("manifest")?.digest !== manifest.digest) return null;
  const backingManifest = observed.get("backing-manifest");
  if (backingManifest?.bytes) {
    // A backing manifest carrying an exports map can make the real
    // require.resolve throw instead of returning this file; without modeling
    // export conditions the resolution lane would be ambiguous, so it is refused.
    try {
      const value: unknown = JSON.parse(backingManifest.bytes.toString("utf8"));
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      if ("exports" in value) return null;
    } catch {
      return null;
    }
  }
  const record = {
    layout: "npm-global" as const,
    platform,
    arch,
    triple: backing.triple,
    backingKind: backingManifestPath ? "optional-package" as const : "package-vendor" as const,
    files: requests.map(req => ({ role: req.role, digest: observed.get(req.role)?.digest })),
  };
  return sha256("codex-cli-install-content-v1", JSON.stringify(record));
}

/** Inspect ownership of one configured Codex CLI candidate, without mutation. */
export async function inspectCodexCliInstall(
  deps: CodexCliInstallProvenanceDeps = {},
): Promise<CodexCliInstallReport> {
  const platform = deps.platform ?? process.platform;
  const candidate = observeCodexRuntimeCandidateReadOnly(deps);
  if (!candidate) {
    // This slice reads no candidate or configuration file on Windows, so an
    // absent proof-captured environment candidate does not establish that no
    // Codex CLI exists: a persisted selection is simply never consulted there.
    // Report the deferral that actually happened instead of the stronger claim
    // that the candidate is unavailable. POSIX retains its existing result
    // when no candidate is observed.
    return isWindowsPlatform(platform)
      ? unknownWindowsReport("windows_inspection_deferred")
      : unknownReport("candidate_unavailable");
  }

  const env = deps.env ?? process.env;
  if (platform === "win32") {
    // This first slice never opens a candidate-controlled Windows pathname.
    // A boolean precheck followed by lstat/realpath/open is raceable when an
    // ancestor can be replaced with a remote reparse point. Preserve only
    // lexical, report-only classifications until a handle-bound inspector is
    // introduced; every result remains unattested and unmanaged.
    const lexicalCandidatePath = win32.isAbsolute(candidate.command)
      && isLocalAbsoluteInspectionPath(candidate.command, platform)
      ? win32.normalize(candidate.command)
      : null;
    if (!lexicalCandidatePath) {
      return unknownWindowsReport("candidate_path_unavailable", candidate);
    }
    const managerRoots = configuredVersionManagerRoots(env, platform, deps);
    const appBundle = isAppBundledCodexPath(lexicalCandidatePath, platform);
    const versionManager = isCodexCliUpdateVersionManagerPath(lexicalCandidatePath, platform)
      || isWithinConfiguredVersionManagerRoot(lexicalCandidatePath, managerRoots, platform);
    if (appBundle || versionManager) {
      return freezeReport({
        schemaVersion: 1,
        candidateAvailable: true,
        candidateVersion: candidate.version,
        candidateSource: candidate.evidence,
        selectionAttested: false,
        versionEvidence: Object.freeze({
          kind: candidate.version ? "advisory-runtime" as const : "unavailable" as const,
        }),
        provenance: appBundle ? "app-bundle" : "version-manager",
        managed: false,
        reason: appBundle ? "app_bundle" : "version_manager_owned",
        location: publicExecutableLocation(lexicalCandidatePath, platform),
        installDigest: null,
        installContentDigest: null,
        packageVersion: null,
        shim: Object.freeze({ status: "unknown", backingKind: null }),
        evidence: Object.freeze([appBundle ? "app_bundle_path" : "version_manager_path"]),
      });
    }
   return unknownWindowsReport("windows_inspection_deferred", candidate, {
     location: publicExecutableLocation(lexicalCandidatePath, platform),
   });
 }
  const configDir = deps.configDir ?? getConfigDir();
  if (!isSafeLocalInspectionPath(configDir, deps)) {
    return unknownReport("shim_state_unknown", candidate);
  }
  const candidatePath = resolveCandidateCommandPath(candidate.command, deps);
  if (!candidatePath) {
    return unknownReport("candidate_path_unavailable", candidate);
  }
  const canonicalCandidatePath = canonicalize(candidatePath, deps);
  if (!canonicalCandidatePath) {
    return unknownReport("candidate_path_unsafe", candidate);
  }
  // Only a proof-bound caller may attest that the environment candidate is the
  // runtime it actually selected, and only when the runtime resolver picked the
  // same canonical path under the same evidence. A persisted selection records
  // intent, not the resolved binary, and an arbitrary environment is ambient —
  // neither can become managed here; a resolver that would choose a different
  // executable cannot attest the snapshot's installation either.
  const resolverPicked = deps.selectedCommand
    ? canonicalize(
        resolveCandidateCommandPath(deps.selectedCommand, deps) ?? deps.selectedCommand,
        deps,
      )
    : null;
  const selectionAttested =
    deps.selectionAttested === true
    && candidate.evidence === "environment"
    && resolverPicked !== null
    && samePath(resolverPicked, canonicalCandidatePath, platform);
  const inspectShim = deps.inspectShim ?? inspectCodexShimBackingForCommand;
  const shim = inspectShim(candidatePath, platform, configDir);
  if (shim.status === "unknown") {
    return freezeReport({
      ...unknownReport("shim_state_unknown", candidate, {
        location: publicExecutableLocation(canonicalCandidatePath, platform),
      }),
      selectionAttested,
      shim: shimReport(shim),
    });
  }
  if (shim.status === "matched") {
    return freezeReport({
      ...unknownReport("shim_update_deferred", candidate, {
        location: publicExecutableLocation(canonicalCandidatePath, platform),
      }),
      selectionAttested,
      provenance: "standalone-unverified",
      shim: shimReport(shim),
      evidence: Object.freeze(["canonical_path", "shim_backing"] as const),
    });
  }

  const ownershipPath = candidatePath;
  const canonicalOwnershipPath = canonicalize(ownershipPath, deps);
  if (!canonicalOwnershipPath) {
    return unknownReport("candidate_path_unsafe", candidate);
  }
  const location = publicExecutableLocation(canonicalCandidatePath, platform);
  const canonicalPathSet = [canonicalCandidatePath, canonicalOwnershipPath];
  if (canonicalPathSet.some(path => isAppBundledCodexPath(path, platform))) {
    return freezeReport({
      schemaVersion: 1,
      candidateAvailable: true,
      candidateVersion: candidate.version,
      candidateSource: candidate.evidence,
      selectionAttested,
      versionEvidence: Object.freeze({
        kind: candidate.version ? "advisory-runtime" as const : "unavailable" as const,
      }),
      provenance: "app-bundle",
      managed: false,
      reason: "app_bundle",
      location,
      installDigest: null,
      installContentDigest: null,
      packageVersion: null,
      shim: shimReport(shim),
      evidence: Object.freeze(["canonical_path", "app_bundle_path"]),
    });
  }
  const configuredManagerRoots = configuredVersionManagerRoots(env, platform, deps);
  if (canonicalPathSet.some(path => isCodexCliUpdateVersionManagerPath(path, platform)
    || isWithinConfiguredVersionManagerRoot(path, configuredManagerRoots, platform))) {
    return freezeReport({
      schemaVersion: 1,
      candidateAvailable: true,
      candidateVersion: candidate.version,
      candidateSource: candidate.evidence,
      selectionAttested,
      versionEvidence: Object.freeze({
        kind: candidate.version ? "advisory-runtime" as const : "unavailable" as const,
      }),
      provenance: "version-manager",
      managed: false,
      reason: "version_manager_owned",
      location,
      installDigest: null,
      installContentDigest: null,
      packageVersion: null,
      shim: shimReport(shim),
      evidence: Object.freeze(["canonical_path", "version_manager_path"]),
    });
  }
  if (/codex[.]opencodex-real(?:[.](?:cmd|bat|exe))?$/i.test(pathTools(platform).basename(candidatePath))) {
    return freezeReport({
      ...unknownReport("shim_state_unknown", candidate, { location }),
      selectionAttested,
      shim: shimReport(shim),
    });
  }

  const manifest = findCodexPackageManifest(ownershipPath, canonicalOwnershipPath, deps);
  if (manifest) {
    // POSIX npm launchers are commonly symlinks into the package, so their
    // lexical prefix is the ownership evidence instead.
    const global = isProvenGlobalNpmLayout(
      ownershipPath,
      manifest.root,
      platform,
      deps,
    );
    const linked = launcherIsLinkedToManifest(
      canonicalOwnershipPath,
      manifest,
      deps,
    );
    const manifestOwned = global && linked;
    // The npm-global prefix bounds every content path this observation may
    // follow: it is the manifest root minus the fixed package suffix. An
    // install that cannot prove the layout keeps a null digest.
    const npmPrefix = manifestOwned
      ? manifest.root.slice(0, manifest.root.length - "/lib/node_modules/@openai/codex".length)
      : "";
    const installContentDigest = manifestOwned && deps.observeInstallContent === true
      // The selection's own lexical->canonical link is part of the claim:
      // verified again at the end of the observation so a retargeted launcher
      // cannot leave the digest bound to bytes it no longer selects.
      ? observeInstallContent(manifest, npmPrefix, platform, env, deps, {
        lexical: ownershipPath,
        canonical: canonicalOwnershipPath,
      })
      : null;
    const versionMatches = candidate.version === null || candidate.version === manifest.version;
    const reason: CodexCliInstallReason = !global || !linked
      ? "npm_global_unverified"
      : !versionMatches ? "version_mismatch"
        : selectionAttested ? "managed_npm_global" : "selection_unattested";
    return freezeReport({
      schemaVersion: 1,
      candidateAvailable: true,
      candidateVersion: candidate.version,
      candidateSource: candidate.evidence,
      selectionAttested,
      versionEvidence: Object.freeze({
        // The manifest is the on-disk record of what is installed. An absent advisory
        // version (the launcher snapshot carries no version) cannot contradict it,
        // while a reported one that disagrees already classified as version_mismatch.
        kind: manifestOwned && versionMatches
          ? "package-manifest" as const
          : candidate.version !== null ? "advisory-runtime" as const : "unavailable" as const,
      }),
      provenance: manifestOwned ? "npm-global" : "standalone-unverified",
      managed: manifestOwned && versionMatches && selectionAttested,
      reason,
      location,
      // Plan identity binds this digest, not the redacted display location: two
      // package roots that resolve to the same "<path>/codex" string must still
      // produce different plans.
      installDigest: sha256("codex-cli-install-root-v1", normalizePath(manifest.root, platform)),
      installContentDigest,
      packageVersion: manifest.version,
      shim: shimReport(shim),
      evidence: Object.freeze<CodexCliInstallEvidence[]>([
        "canonical_path", "package_manifest", "package_manifest_digest",
        ...(manifestOwned ? ["global_npm_layout" as const] : []),
        ...(installContentDigest ? ["install_content_digest" as const] : []),
      ]),
    });
  }

  const stat = deps.stat ?? statSync;
  if (!isSafeLocalInspectionPath(canonicalOwnershipPath, deps)) {
    return unknownReport("candidate_path_unsafe", candidate);
  }
  try {
    if (!stat(canonicalOwnershipPath).isFile()) {
      return unknownReport("candidate_path_unsafe", candidate);
    }
  } catch {
    return unknownReport("inspection_failed", candidate);
  }
  return freezeReport({
    schemaVersion: 1,
    candidateAvailable: true,
    candidateVersion: candidate.version,
    candidateSource: candidate.evidence,
    selectionAttested,
    versionEvidence: Object.freeze({
      kind: candidate.version ? "advisory-runtime" as const : "unavailable" as const,
    }),
    provenance: "standalone-unverified",
    managed: false,
    reason: "unverified_standalone",
    location,
    installDigest: null,
    installContentDigest: null,
    packageVersion: null,
    shim: shimReport(shim),
    evidence: Object.freeze(["canonical_path"]),
  });
}
