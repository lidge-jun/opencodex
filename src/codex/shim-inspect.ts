import { lstatSync } from "node:fs";
import { extname, join, posix, win32 } from "node:path";
import { getConfigDir } from "../config";
import { fileErrorCode, readStateResult, stateFiles } from "./shim-state-file";
import {
  isHealthyShimProbe,
  isVersionManagerOwnedCodexPath,
  shimPathFingerprint,
  stableShimPathProbe,
  statFingerprint,
  type ShimPathFingerprint,
} from "./shim-fingerprint";
import { gitBashPath, psString, shQuote, windowsBatchSet } from "./shim-templates";

export type CodexShimBackingForCommand =
  | Readonly<{ status: "not-tracked" }>
  | Readonly<{
      status: "matched";
      selectedRole: "wrapper" | "backing";
      backingPath: string;
      backingKind: "backup" | "real";
    }>
  | Readonly<{
      status: "unknown";
      reason:
        | "state_invalid"
        | "platform_mismatch"
        | "ambiguous_match"
        | "preserve_only"
        | "backing_missing"
        | "backing_mismatch"
        | "binding_unavailable"
        | "wrapper_unhealthy"
        | "version_manager_refused";
    }>;

export function isLocalAbsoluteInspectionPath(path: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return posix.isAbsolute(path);
  const normalized = path.replace(/\//g, "\\");
  // UNC and device namespaces can initiate remote I/O while a nominally local
  // inspection is resolving user-controlled paths. Root-relative paths are
  // drive-context dependent, so require an explicit local drive as well.
  return win32.isAbsolute(path)
    && /^[a-z]:\\/i.test(normalized)
    && !normalized.startsWith("\\\\");
}

function windowsShimInspectionIsDeferred(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/** Resolve one selected command through already-recorded shim state, without repair. */
export function inspectCodexShimBackingForCommand(
  selectedCommand: string,
  platform: NodeJS.Platform = process.platform,
  configDir: string = getConfigDir(),
): CodexShimBackingForCommand {
  // Pathname prechecks cannot prevent a writable Windows ancestor from being
  // replaced with a remote reparse point before the later state/fingerprint
  // reads. Keep the exported read-only helper fail-closed until those reads are
  // performed through a handle-bound Windows provenance layer.
  if (windowsShimInspectionIsDeferred(platform)) {
    return Object.freeze({ status: "unknown" as const, reason: "binding_unavailable" as const });
  }
  if (!isLocalAbsoluteInspectionPath(configDir, platform)) {
    return Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const });
  }
  const stateFile = join(configDir, "codex-shim.json");
  try {
    const stateEntry = lstatSync(stateFile);
    if (stateEntry.isSymbolicLink()) {
      return Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const });
    }
  } catch (error) {
    if (fileErrorCode(error) !== "ENOENT") {
      return Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const });
    }
  }
  const result = readStateResult(stateFile);
  if (!result.state) {
    return result.present
      ? Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const })
      : Object.freeze({ status: "not-tracked" as const });
  }
  const pathApi = platform === "win32" ? win32 : posix;
  const samePath = (left: string, right: string): boolean => {
    const normalizedLeft = pathApi.resolve(left);
    const normalizedRight = pathApi.resolve(right);
    return platform === "win32"
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  };
  const files = stateFiles(result.state);
  if (files.some(file => !file.wrapperPath || !file.originalPath || !file.backupPath
    || ![file.wrapperPath, file.originalPath, file.backupPath, file.realPath]
      .filter((path): path is string => typeof path === "string")
      .every(path => isLocalAbsoluteInspectionPath(path, platform)))) {
    return Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const });
  }
  const wrapperKeys = files.map(file => platform === "win32"
    ? pathApi.resolve(file.wrapperPath).toLowerCase()
    : pathApi.resolve(file.wrapperPath));
  if (new Set(wrapperKeys).size !== wrapperKeys.length) {
    return Object.freeze({ status: "unknown" as const, reason: "state_invalid" as const });
  }
  const selectedFingerprint = shimPathFingerprint(selectedCommand);
  if (!selectedFingerprint) {
    return Object.freeze({ status: "unknown" as const, reason: "binding_unavailable" as const });
  }
  const selectedIdentity = selectedFingerprint.target ?? selectedFingerprint;
  const sameEffectiveIdentity = (fingerprint: ShimPathFingerprint | null): boolean => {
    if (!fingerprint) return false;
    const identity = fingerprint.target ?? fingerprint;
    return identity.dev === selectedIdentity.dev && identity.ino === selectedIdentity.ino;
  };
  const matches = files.flatMap(file => {
    const backingPath = file.realPath ?? file.backupPath;
    const roles: Array<"wrapper" | "backing"> = [];
    if (samePath(file.wrapperPath, selectedCommand)
      || sameEffectiveIdentity(shimPathFingerprint(file.wrapperPath))) {
      roles.push("wrapper");
    }
    if (samePath(backingPath, selectedCommand)
      || sameEffectiveIdentity(shimPathFingerprint(backingPath))) {
      roles.push("backing");
    }
    return roles.map(selectedRole => ({ file, backingPath, selectedRole }));
  });
  if (matches.length === 0) return Object.freeze({ status: "not-tracked" as const });
  if (result.state.platform !== platform) {
    return Object.freeze({ status: "unknown" as const, reason: "platform_mismatch" as const });
  }
  if (matches.length !== 1) {
    return Object.freeze({ status: "unknown" as const, reason: "ambiguous_match" as const });
  }
  const { file, backingPath, selectedRole } = matches[0]!;
  if (file.preserveOnly === true) {
    return Object.freeze({ status: "unknown" as const, reason: "preserve_only" as const });
  }
  const backing = statFingerprint(backingPath, true);
  if (!backing || backing.size <= 0 || samePath(backingPath, file.wrapperPath)) {
    return Object.freeze({ status: "unknown" as const, reason: "backing_missing" as const });
  }
  const wrapperProbe = stableShimPathProbe(file.wrapperPath);
  if (!wrapperProbe || !isHealthyShimProbe(wrapperProbe, result.state.platform)) {
    return Object.freeze({
      status: "unknown" as const,
      reason: isVersionManagerOwnedCodexPath(file.wrapperPath)
        ? "version_manager_refused" as const
        : "wrapper_unhealthy" as const,
    });
  }
  const wrapperIdentity = wrapperProbe.fingerprint.target ?? wrapperProbe.fingerprint;
  if (backing.dev === wrapperIdentity.dev && backing.ino === wrapperIdentity.ino) {
    return Object.freeze({ status: "unknown" as const, reason: "backing_mismatch" as const });
  }
  const wrapperExt = extname(file.wrapperPath).toLowerCase();
  const invokesBacking = platform !== "win32"
    ? wrapperProbe.prefix.includes(`exec ${shQuote(backingPath)} "$@"`)
    : wrapperExt === ".cmd" || wrapperExt === ".bat"
      ? wrapperProbe.prefix.includes(windowsBatchSet("OCX_REAL_CODEX", backingPath))
        && wrapperProbe.prefix.includes('"%OCX_REAL_CODEX%" %*')
      : wrapperExt === ".ps1"
        ? wrapperProbe.prefix.includes(`& ${psString(backingPath)} @args`)
        : wrapperProbe.prefix.includes(`exec ${shQuote(gitBashPath(backingPath))} "$@"`);
  if (!invokesBacking) {
    return Object.freeze({ status: "unknown" as const, reason: "backing_mismatch" as const });
  }
  return Object.freeze({
    status: "matched" as const,
    selectedRole,
    backingPath,
    backingKind: file.realPath !== undefined ? "real" as const : "backup" as const,
  });
}
