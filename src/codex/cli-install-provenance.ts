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
} from "node:fs";
import { posix, win32 } from "node:path";
import { getConfigDir } from "../config";
import { parseStrictSemver } from "../lib/strict-semver";
import { CODEX_CLI_VERSION_MANAGER_ROOT_ENV_SLOTS } from "../update/codex-cli-update-launch-policy.mjs";
import { isSpawnableCodexCandidate } from "./exec-invocation";
import {
  codexRuntimeStatePath,
  parsePersistedCodexRuntime,
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
  readonly inspectShim?: (
    command: string,
    platform: NodeJS.Platform,
    configDir: string,
  ) => CodexShimBackingForCommand;
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

/** Inspect ownership of one configured Codex CLI candidate, without mutation. */
export async function inspectCodexCliInstall(
  deps: CodexCliInstallProvenanceDeps = {},
): Promise<CodexCliInstallReport> {
  const platform = deps.platform ?? process.platform;
  const candidate = observeCodexRuntimeCandidateReadOnly(deps);
  if (!candidate) {
    return isWindowsPlatform(platform)
      ? unknownWindowsReport("candidate_unavailable")
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
  const inspectShim = deps.inspectShim ?? inspectCodexShimBackingForCommand;
  const shim = inspectShim(candidatePath, platform, configDir);
  if (shim.status === "unknown") {
    return freezeReport({
      ...unknownReport("shim_state_unknown", candidate, {
        location: publicExecutableLocation(canonicalCandidatePath, platform),
      }),
      shim: shimReport(shim),
    });
  }
  if (shim.status === "matched") {
    return freezeReport({
      ...unknownReport("shim_update_deferred", candidate, {
        location: publicExecutableLocation(canonicalCandidatePath, platform),
      }),
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
      selectionAttested: false,
      versionEvidence: Object.freeze({
        kind: candidate.version ? "advisory-runtime" as const : "unavailable" as const,
      }),
      provenance: "app-bundle",
      managed: false,
      reason: "app_bundle",
      location,
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
      selectionAttested: false,
      versionEvidence: Object.freeze({
        kind: candidate.version ? "advisory-runtime" as const : "unavailable" as const,
      }),
      provenance: "version-manager",
      managed: false,
      reason: "version_manager_owned",
      location,
      packageVersion: null,
      shim: shimReport(shim),
      evidence: Object.freeze(["canonical_path", "version_manager_path"]),
    });
  }
  if (/codex[.]opencodex-real(?:[.](?:cmd|bat|exe))?$/i.test(pathTools(platform).basename(candidatePath))) {
    return freezeReport({
      ...unknownReport("shim_state_unknown", candidate, { location }),
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
    const versionMatches = candidate.version === null || candidate.version === manifest.version;
    const reason: CodexCliInstallReason = !global || !linked
      ? "npm_global_unverified"
      : !versionMatches ? "version_mismatch" : "selection_unattested";
    return freezeReport({
      schemaVersion: 1,
      candidateAvailable: true,
      candidateVersion: candidate.version,
      candidateSource: candidate.evidence,
      selectionAttested: false,
      versionEvidence: Object.freeze({
        kind: manifestOwned && candidate.version !== null && versionMatches
          ? "package-manifest" as const
          : candidate.version !== null ? "advisory-runtime" as const : "unavailable" as const,
      }),
      provenance: manifestOwned ? "npm-global" : "standalone-unverified",
      managed: false,
      reason,
      location,
      packageVersion: manifest.version,
      shim: shimReport(shim),
      evidence: Object.freeze<CodexCliInstallEvidence[]>([
        "canonical_path", "package_manifest", "package_manifest_digest",
        ...(manifestOwned ? ["global_npm_layout" as const] : []),
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
    selectionAttested: false,
    versionEvidence: Object.freeze({
      kind: candidate.version ? "advisory-runtime" as const : "unavailable" as const,
    }),
    provenance: "standalone-unverified",
    managed: false,
    reason: "unverified_standalone",
    location,
    packageVersion: null,
    shim: shimReport(shim),
    evidence: Object.freeze(["canonical_path"]),
  });
}
