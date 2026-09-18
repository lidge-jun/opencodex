import { createHash } from "node:crypto";
import { win32 } from "node:path";
import { parseStrictSemver } from "../lib/strict-semver";

/** Explicit observation, not runtime selection or authority to run an installer. */
export interface CodexCliInstallationIdentityInput {
  readonly candidate: string;
  readonly npmPrefix: string;
  readonly npmCli: string;
  readonly node: string;
  /** Where the candidate came from; defaults to an explicit CLI argument. */
  readonly candidateSource?: "explicit-cli" | "selected";
}

export interface CodexCliInstallationIdentityReport {
  readonly schemaVersion: 1;
  readonly candidateSource: "explicit-cli" | "selected";
  readonly status: "observed" | "refused";
  readonly reason: string;
  readonly installationIdentityObserved: boolean;
  readonly selectionAttested: false;
  readonly managed: false;
  readonly applyAllowed: false;
  readonly packageVersion: string | null;
  readonly npmVersion: string | null;
  readonly identityDigest: string | null;
  readonly proof: "windows-handle-bound" | null;
  readonly toolchain: "observed-only";
}

export interface InstallationFileRequest {
  readonly path: string;
  readonly maxBytes: number;
  readonly hashOnly?: boolean;
}

export interface ObservedInstallationFile {
  readonly path: string;
  readonly identity: {
    readonly volumeSerial: string;
    readonly fileId: string;
    readonly size: number;
    readonly lastWriteTime: string;
    readonly changeTime: string;
  };
  readonly bytes: Uint8Array;
  readonly digest?: string;
}

export type InstallationFilesResult =
  | { readonly kind: "observed"; readonly files: readonly ObservedInstallationFile[] }
  | { readonly kind: "refused"; readonly reason: string };

export interface CodexCliInstallationIdentityDeps {
  readonly platform?: NodeJS.Platform;
  readonly inspectFiles?: (requests: readonly InstallationFileRequest[]) => Promise<InstallationFilesResult>;
}

const TEXT_LIMIT = 256 * 1024;
const NODE_LIMIT = 256 * 1024 * 1024;
const hash = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
// NTFS can enable case-sensitive directory entries. Do not collapse different
// paths merely because ordinary Windows directories usually ignore case.
const key = (path: string): string => path[0]!.toUpperCase() + path.slice(1);

function localPath(value: string): string | null {
  if (typeof value !== "string" || value.length > 30_000 || !/^[a-z]:[\\/]/i.test(value)) return null;
  const path = value.replaceAll("/", "\\");
  const parts = path.slice(3).split("\\");
  if (!parts.length || parts.some(part => !part || part === "." || part === ".."
    || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) return null;
  return path;
}

function supportedLayoutPath(path: string): boolean {
  // This slice does not adopt package managers or packaged desktop applications.
  return !/(?:^|\\)(?:windowsapps|scoop|\.volta|\.nvm|\.asdf|\.mise|\.fnm|\.nvs|\.nodenv)(?:\\|$)|\.app(?:\\|$)/i.test(path);
}

function report(
  reason: string,
  versions?: { codex: string; npm: string; digest: string },
  candidateSource: CodexCliInstallationIdentityReport["candidateSource"] = "explicit-cli",
): CodexCliInstallationIdentityReport {
  return Object.freeze({
    schemaVersion: 1, candidateSource, status: versions ? "observed" : "refused",
    reason, installationIdentityObserved: !!versions, selectionAttested: false, managed: false,
    applyAllowed: false, packageVersion: versions?.codex ?? null, npmVersion: versions?.npm ?? null,
    identityDigest: versions?.digest ?? null, proof: versions ? "windows-handle-bound" : null,
    toolchain: "observed-only",
  });
}

/** A refusal before any observation ran, e.g. when no selected candidate can be identified. */
export function codexCliInstallationRefusal(
  reason: string,
  candidateSource: CodexCliInstallationIdentityReport["candidateSource"] = "explicit-cli",
): CodexCliInstallationIdentityReport {
  return report(reason, undefined, candidateSource);
}

function manifest(file: ObservedInstallationFile, name: string, bin: string, expected: string): string | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(file.bytes).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    const entry = typeof item.bin === "string" ? item.bin
      : item.bin && typeof item.bin === "object" ? (item.bin as Record<string, unknown>)[bin] : null;
    return item.name === name && typeof item.version === "string" && parseStrictSemver(item.version)
      && entry === expected ? item.version : null;
  } catch { return null; }
}

/** Only the standard npm cmd-shim is linked here; arbitrary wrappers remain unverified. */
function npmCodexCommandShim(bytes: Uint8Array): boolean {
  const expected = `@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\\node.exe" (
  SET "_prog=%dp0%\\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*`;
  const normalize = (text: string) => text.replaceAll("\r\n", "\n").trimEnd();
  return normalize(Buffer.from(bytes).toString("utf8")) === normalize(expected);
}

function fileDigest(file: ObservedInstallationFile): string {
  return file.digest ?? hash(file.bytes);
}

function fileEvidence(file: ObservedInstallationFile): readonly (string | number)[] {
  const id = file.identity;
  return [key(file.path), id.volumeSerial, id.fileId, id.size, id.lastWriteTime, id.changeTime, fileDigest(file)];
}

/** No filesystem or native-library work occurs until this explicit operation is called. */
export async function inspectCodexCliInstallationIdentity(
  input: CodexCliInstallationIdentityInput,
  deps: CodexCliInstallationIdentityDeps = {},
): Promise<CodexCliInstallationIdentityReport> {
  const source = input.candidateSource ?? "explicit-cli";
  const refused = (reason: string) => report(reason, undefined, source);
  if ((deps.platform ?? process.platform) !== "win32") return refused("unsupported_platform");
  const candidate = localPath(input.candidate);
  const prefix = localPath(input.npmPrefix);
  const npmCli = localPath(input.npmCli);
  const node = localPath(input.node);
  if (!candidate || !prefix || !npmCli || !node) return refused("unsafe_path");
  if (![candidate, prefix, npmCli, node].every(supportedLayoutPath)) return refused("unsupported_layout");
  const packageRoot = win32.join(prefix, "node_modules", "@openai", "codex");
  const codexManifest = win32.join(packageRoot, "package.json");
  const codexBin = win32.join(packageRoot, "bin", "codex.js");
  const shim = win32.join(prefix, "codex.cmd");
  // A codex.opencodex-real.cmd backup is npm's renamed launcher: same grammar, same dir.
  const backingShim = win32.join(prefix, "codex.opencodex-real.cmd");
  const acceptedCandidates = source === "selected"
    ? [key(codexBin), key(shim), key(backingShim)]
    : [key(codexBin), key(shim)];
  if (!acceptedCandidates.includes(key(candidate))
    || !/\\node_modules\\npm\\bin\\npm-cli\.js$/i.test(npmCli)
    || win32.basename(node).toLowerCase() !== "node.exe") return refused("unsupported_layout");
  const npmManifest = win32.join(win32.dirname(win32.dirname(npmCli)), "package.json");
  try {
    const inspect = deps.inspectFiles ?? (await import("./windows-installation-files")).inspectWindowsInstallationFiles;
    // Read both manifests again with every linked file held open: first-pass bytes cannot
    // authorize links after a manifest replacement between the two observations.
    const first = await inspect([{ path: codexManifest, maxBytes: TEXT_LIMIT }, { path: npmManifest, maxBytes: TEXT_LIMIT }]);
    if (first.kind !== "observed") return refused("native_proof_unavailable");
    const initial = new Map(first.files.map(file => [key(file.path), file]));
    const codex = initial.get(key(codexManifest));
    const npm = initial.get(key(npmManifest));
    if (!codex || !npm) return refused("read_failed");
    const codexVersion = manifest(codex, "@openai/codex", "codex", "bin/codex.js");
    const npmVersion = manifest(npm, "npm", "npm", "bin/npm-cli.js");
    if (!codexVersion || !npmVersion) return refused("package_mismatch");
    const requests: InstallationFileRequest[] = [codexManifest, npmManifest, candidate, codexBin, npmCli]
      .filter((path, index, all) => all.findIndex(other => key(other) === key(path)) === index)
      .map(path => ({ path, maxBytes: TEXT_LIMIT }));
    requests.push({ path: node, maxBytes: NODE_LIMIT, hashOnly: true });
    const second = await inspect(requests);
    if (second.kind !== "observed") return refused("native_proof_unavailable");
    const files = new Map(second.files.map(file => [key(file.path), file]));
    if (requests.some(request => !files.has(key(request.path)))) return refused("read_failed");
    for (const before of [codex, npm]) {
      if (JSON.stringify(fileEvidence(before)) !== JSON.stringify(fileEvidence(files.get(key(before.path))!))) {
        return refused("identity_changed");
      }
    }
    if ([key(shim), key(backingShim)].includes(key(candidate))
      && !npmCodexCommandShim(files.get(key(candidate))!.bytes)) {
      return refused("launcher_mismatch");
    }
    const observed = [...files.values()].sort((a, b) => key(a.path) < key(b.path) ? -1 : key(a.path) > key(b.path) ? 1 : 0);
    if (observed.some(file => !/^[a-f0-9]{64}$/i.test(fileDigest(file)))) return refused("read_failed");
    const digest = hash(JSON.stringify(["opencodex-explicit-installation-observation-v1", key(prefix),
      key(candidate), key(npmCli), key(node), ...observed.map(fileEvidence)]));
    return report("identity_observed", { codex: codexVersion, npm: npmVersion, digest }, source);
  } catch { return refused("read_failed"); }
}
