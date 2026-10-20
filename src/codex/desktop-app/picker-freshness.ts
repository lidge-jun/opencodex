/**
 * Whether the Codex desktop app's model picker already shows the current catalog (#4761).
 *
 * `ocx system codex-restart` used to quit and relaunch the desktop shell every time, which
 * discards everything that lives only in the client: composer drafts, an unsent picker
 * selection, a pending approval prompt. Upstream's own restart (`codex app-server daemon
 * restart`) restarts only the app-server and lets clients reconnect, and the desktop app
 * already respawns its own app-server child when it exits.
 *
 * The one thing an app-server restart cannot refresh is the picker: the renderer builds
 * the roster once when the shell launches, and `model_catalog_json` is startup-only. So
 * the shell has to restart only when it launched before the catalog it should show was
 * written. The catalog writer skips byte-identical rewrites to keep this mtime honest
 * (`src/codex/catalog/retained-sync.ts`), which is what makes the comparison usable.
 *
 * The mtime only means something for the catalog `config.toml` actually binds. With no
 * `model_catalog_json` the shell shows Codex's own roster, which no local file dates, so
 * an unbound config is `unknown`. `config.toml`'s own mtime is no substitute: injection
 * rewrites it on every sync even when the bytes are identical. A binding changed by THIS
 * request's sync is caught by the caller comparing it across the sync; one changed by an
 * earlier sync over a byte-identical catalog file is not observable here.
 *
 * Anything we cannot read answers `unknown`, and the caller falls back to the full
 * desktop restart: a stale picker the operator asked us to fix is the failure this
 * command exists to prevent, so missing evidence never skips it.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { activeCodexConfigPath, resolveActiveCodexConfigPath } from "../catalog/parsing";
import { readRootTomlString } from "../paths";
import { readProcessStartMsBatch } from "../app-server-processes";
import { listCodexDesktopShellPids, type DesktopAppRestartIo } from "../desktop-app-restart";
import { isTestHomeGuardArmed } from "../../lib/test-home-guard";
import type { CodexDesktopPickerState } from "../../lib/codex-restart-contract";

export type DesktopPickerState = CodexDesktopPickerState;

/**
 * Pure decision. `shellStartsMs === null` means the shells could not be listed; a null
 * entry means one shell's start time was unreadable.
 *
 * Strictly later, never equal: macOS `ps lstart` has one-second granularity, so a shell
 * that started in the same second as the catalog write may predate it.
 */
export function classifyDesktopPicker(
  shellStartsMs: readonly (number | null)[] | null,
  catalogMtimeMs: number | null,
): DesktopPickerState {
  if (shellStartsMs === null) return "unknown";
  if (shellStartsMs.length === 0) return "not_running";
  if (catalogMtimeMs === null) return "unknown";
  if (shellStartsMs.some(start => start === null)) return "unknown";
  return shellStartsMs.every(start => start! > catalogMtimeMs) ? "current" : "stale";
}

export interface DesktopPickerIo extends DesktopAppRestartIo {
  readStartMs?: (pids: readonly number[]) => Map<number, number | null>;
  /** The catalog `config.toml` binds, or null when it binds none or cannot be read. */
  catalogBinding?: () => string | null;
  catalogMtimeMs?: (path: string) => number | null;
}

/** The resolved `model_catalog_json` path, or null when config.toml binds no catalog. */
export function readCodexCatalogBinding(): string | null {
  try {
    const configPath = activeCodexConfigPath();
    if (!existsSync(configPath)) return null;
    const path = readRootTomlString(readFileSync(configPath, "utf-8"), "model_catalog_json");
    return path ? resolveActiveCodexConfigPath(path) : null;
  } catch {
    return null;
  }
}

function defaultCatalogMtimeMs(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

export function readCodexDesktopPickerState(io: DesktopPickerIo = {}): DesktopPickerState {
  // An armed test process without an injected executor answers `unknown`, which keeps the
  // caller on the desktop-restart seam the test injected. Reading is harmless, but whether
  // the developer's own Codex is open must not decide which branch a test takes.
  if (!io.execFile && isTestHomeGuardArmed()) return "unknown";
  const platform = io.platform ?? process.platform;
  const pids = listCodexDesktopShellPids(io);
  if (pids === null || pids.length === 0) return classifyDesktopPicker(pids, null);
  const starts = (io.readStartMs ?? (list => readProcessStartMsBatch(list, platform)))(pids);
  const binding = (io.catalogBinding ?? readCodexCatalogBinding)();
  return classifyDesktopPicker(
    pids.map(pid => starts.get(pid) ?? null),
    binding === null ? null : (io.catalogMtimeMs ?? defaultCatalogMtimeMs)(binding),
  );
}
