import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { win32 } from "node:path";
import { SHIM_MARKER } from "./shim-templates";
import type { CodexCliInstallationIdentityInput } from "./cli-installation-identity";

/**
 * The proof-captured launcher snapshot used to identify the selected candidate.
 * Every field is optional because older launchers and direct Bun/source runs
 * supply no snapshot at all; derivation fails closed rather than reading the
 * ambient environment.
 */
export interface CodexCliInstallationSnapshot {
  readonly codexCliPath?: string | null;
  readonly path?: string | null;
  readonly pathExt?: string | null;
}

export type CodexCliInstallationTargetRefusal =
  | "unsupported_platform"
  | "candidate_unavailable"
  | "unsupported_layout"
  | "toolchain_unresolved";

export type CodexCliInstallationTargetDerivation =
  | { readonly kind: "derived"; readonly input: CodexCliInstallationIdentityInput }
  | { readonly kind: "unavailable"; readonly reason: CodexCliInstallationTargetRefusal };

export interface CodexCliInstallationTargetDeps {
  readonly platform?: NodeJS.Platform;
  readonly exists?: (path: string) => boolean;
  /** Bounded prefix read used only to recognize an OpenCodex-owned wrapper. */
  readonly fileContains?: (path: string, marker: string) => boolean;
}

const DEFAULT_PATH_EXT = ".COM;.EXE;.BAT;.CMD;.PS1";
const SHIM_PROBE_BYTES = 8 * 1024;
const CODEX_PACKAGE_SUFFIX = "\\node_modules\\@openai\\codex\\bin\\codex.js";

function defaultFileContains(path: string, marker: string): boolean {
  let descriptor: number | undefined;
  let contains = false;
  try {
    descriptor = openSync(path, "r");
    const bytes = Buffer.allocUnsafe(SHIM_PROBE_BYTES);
    const count = readSync(descriptor, bytes, 0, bytes.length, 0);
    contains = bytes.subarray(0, count).toString("utf8").includes(marker);
  } catch {
    contains = false;
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { contains = false; }
    }
  }
  return contains;
}

/**
 * First match wins, mirroring PATH resolution: directories in order, and within
 * each directory every PATHEXT suffix in order (or the exact name when it
 * already carries an extension). Skipping a hit to keep scanning would attest
 * something other than the launcher that actually resolves.
 */
function scanPath(
  name: string,
  pathValue: string | null | undefined,
  pathExt: string | null | undefined,
  exists: (path: string) => boolean,
): string | null {
  const extensions = (pathExt ?? DEFAULT_PATH_EXT).split(";").map(value => value.trim()).filter(Boolean);
  const names = /\.[a-z0-9]+$/i.test(name) ? [name] : extensions.map(ext => name + ext.toLowerCase());
  for (const entry of (pathValue ?? "").split(";")) {
    const dir = entry.trim().replace(/^"+|"+$/g, "");
    if (!dir) continue;
    for (const candidateName of names) {
      const candidate = win32.join(dir, candidateName);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * Derive the four attestation inputs from the proof-captured launcher snapshot.
 * Discovery only proposes candidate paths; the held-handle observation remains
 * the authority, so a stale or racing probe can only produce a refusal, never a
 * false identity. No ambient environment is read: without a snapshot the result
 * is unavailable rather than silently trusting the child's environment.
 */
export function deriveCodexCliInstallationInput(
  snapshot: CodexCliInstallationSnapshot,
  deps: CodexCliInstallationTargetDeps = {},
): CodexCliInstallationTargetDerivation {
  if ((deps.platform ?? process.platform) !== "win32") {
    return { kind: "unavailable", reason: "unsupported_platform" };
  }
  const exists = deps.exists ?? existsSync;
  const fileContains = deps.fileContains ?? defaultFileContains;
  const configured = snapshot.codexCliPath;

  let candidate: string | null;
  if (configured) {
    if (/^[a-z]:[\\/]/i.test(configured)) {
      if (!exists(configured)) return { kind: "unavailable", reason: "candidate_unavailable" };
      candidate = win32.normalize(configured);
    } else {
      if (configured.includes("/") || configured.includes("\\")) {
        return { kind: "unavailable", reason: "candidate_unavailable" };
      }
      candidate = scanPath(configured, snapshot.path, snapshot.pathExt, exists);
      if (!candidate) return { kind: "unavailable", reason: "candidate_unavailable" };
    }
  } else {
    candidate = scanPath("codex", snapshot.path, snapshot.pathExt, exists);
    if (!candidate) return { kind: "unavailable", reason: "candidate_unavailable" };
  }

  // An OpenCodex wrapper at the npm prefix is our own launcher, not the npm
  // artifact. The renamed original beside it is the file npm wrote.
  if (/\.cmd$/i.test(candidate) && fileContains(candidate, SHIM_MARKER)) {
    const backing = candidate.slice(0, -".cmd".length) + ".opencodex-real.cmd";
    if (!exists(backing)) return { kind: "unavailable", reason: "unsupported_layout" };
    candidate = backing;
  }

  const base = win32.basename(candidate).toLowerCase();
  let prefix: string;
  if (base === "codex.cmd" || base === "codex.opencodex-real.cmd") {
    prefix = win32.dirname(candidate);
  } else if (candidate.toLowerCase().endsWith(CODEX_PACKAGE_SUFFIX)) {
    prefix = candidate.slice(0, candidate.length - CODEX_PACKAGE_SUFFIX.length);
  } else {
    return { kind: "unavailable", reason: "unsupported_layout" };
  }
  if (!exists(win32.join(prefix, "node_modules", "@openai", "codex", "package.json"))) {
    return { kind: "unavailable", reason: "unsupported_layout" };
  }

  // The npm cmd-shim itself prefers %dp0%\node.exe before falling back to PATH.
  let node = win32.join(prefix, "node.exe");
  if (!exists(node)) {
    const resolved = scanPath("node.exe", snapshot.path, null, exists);
    if (!resolved) return { kind: "unavailable", reason: "toolchain_unresolved" };
    node = resolved;
  }
  const npmCli = win32.join(win32.dirname(node), "node_modules", "npm", "bin", "npm-cli.js");
  if (!exists(npmCli)) return { kind: "unavailable", reason: "toolchain_unresolved" };

  return {
    kind: "derived",
    input: Object.freeze({
      candidate,
      npmPrefix: prefix,
      npmCli,
      node,
      candidateSource: "selected",
    }),
  };
}
