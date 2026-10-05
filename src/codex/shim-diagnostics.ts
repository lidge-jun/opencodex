import { existsSync, lstatSync, readFileSync } from "node:fs";
import { SHIM_MARKER, UNIX_SHIM_REVISION_MARKER } from "./shim-templates";
import { readStateResult, stateFiles, statePath } from "./shim-state-file";
import { overlayDiagnostic } from "./shim-overlay";

export function isShim(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

function isHealthyShim(path: string, platform: NodeJS.Platform): boolean {
  try {
    const content = readFileSync(path, "utf8");
    if (content.length < 180 || !content.includes(SHIM_MARKER) || !content.includes("ensure")) return false;
    if (platform !== "win32" && !content.includes(UNIX_SHIM_REVISION_MARKER)) return false;
    if (platform !== "win32" && (lstatSync(path).mode & 0o111) === 0) return false;
    return true;
  } catch {
    return false;
  }
}

export interface CodexShimDiagnostic {
  installed: boolean;
  healthy: boolean;
  summary: string;
  runnable?: boolean;
  active?: boolean | null;
}

/** Structured, secret-free shim state for CLI/GUI lifecycle diagnostics. */
export function diagnoseCodexShim(): CodexShimDiagnostic {
  const result = readStateResult();
  const state = result.state;
  if (!state) {
    if (result.present) {
      return {
        installed: true,
        healthy: false,
        runnable: false,
        active: null,
        summary: result.warning ?? `Codex autostart shim state is invalid or corrupt at ${statePath()}. Reinstall or remove the shim.`,
      };
    }
    return {
      installed: false,
      healthy: false,
      summary: "Codex autostart shim is not installed.",
    };
  }
  if (state.mode === "path-overlay") return overlayDiagnostic(state);
  const files = stateFiles(state);
  const healthy = files.length > 0 && files.every(file => file.preserveOnly
    ? existsSync(file.backupPath) && !existsSync(file.originalPath)
    : existsSync(file.wrapperPath)
      && (existsSync(file.backupPath) || (file.realPath ? existsSync(file.realPath) : false))
      && isHealthyShim(file.wrapperPath, state.platform));
  const summary = files.map(file => {
    const wrapper = existsSync(file.wrapperPath)
      ? isShim(file.wrapperPath)
        ? "shim present"
        : "present but not an opencodex shim"
      : "missing";
    const backup = existsSync(file.backupPath) ? "present" : "missing";
    return `Codex autostart shim: wrapper ${wrapper} at ${file.wrapperPath}; original backup ${backup} at ${file.backupPath}.`;
  }).join("\n");
  // Presence alone is not health: a damaged wrapper still reads "shim present", so state the verdict.
  const migration = healthy && state.platform !== "win32"
    ? " Legacy Unix shim installed in place; automatic repair does not migrate it. Run ocx codex-shim install, then source the printed codex-shell-env.sh path and add that line after PATH setup in your shell startup file."
    : "";
  return { installed: true, healthy, summary: healthy ? `${summary}${migration}`
    : `${summary}\nCodex autostart shim is unhealthy. Run ocx codex-shim install to repair it.` };
}

export function codexShimStatus(): string {
  return diagnoseCodexShim().summary;
}
