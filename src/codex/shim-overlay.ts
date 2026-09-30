import { chmodSync, linkSync, lstatSync, mkdirSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { durableBunRuntime } from "../lib/bun-runtime";
import { buildUnixCodexShim, shQuote, SHIM_MARKER } from "./shim-templates";
import { isCurrentUnixShimProbe, isHealthyShimProbe, sameFingerprint, sameFingerprintAfterRename, shimPathFingerprint, stableShimPathProbe } from "./shim-fingerprint";
import { probeUnixShimFiles } from "./shim-probe";
import { readStateResult, statePath, writeState, type ShimState } from "./shim-state-file";
import { tryAcquireShimRestoreLock } from "./shim-restore-lock";
import { migrateLegacyUnixShim } from "./shim-migration";

export const overlayPaths = () => ({ wrapper: join(getConfigDir(), "bin", "codex"), env: join(getConfigDir(), "codex-shell-env.sh") });
export function pathEntryExists(path: string): boolean {
  try { lstatSync(path); return true; } catch { return false; }
}
export function usableNativeLauncher(path: string): boolean {
  const probe = stableShimPathProbe(path);
  return !!probe && !probe.prefix.includes(SHIM_MARKER)
    && ((probe.fingerprint.target?.mode ?? probe.fingerprint.mode) & 0o111) !== 0;
}
function overlayStateValid(state: ShimState): boolean {
  return state.platform === process.platform && state.mode === "path-overlay"
    && resolve(state.wrapperPath) === resolve(overlayPaths().wrapper) && !!state.launcherPath;
}
function scriptFor(launcher: string): string {
  const runtime = durableBunRuntime();
  return buildUnixCodexShim(launcher, runtime.path, join(import.meta.dir, "..", "cli", "index.ts"), runtime.source);
}
function pathActive(wrapper: string): boolean {
  for (const dir of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    const candidate = join(dir, "codex");
    try {
      if ((lstatSync(candidate).mode & 0o111) === 0) continue;
      return realpathSync(candidate) === realpathSync(wrapper);
    } catch { /* next PATH entry */ }
  }
  return false;
}
export function overlayDiagnostic(state: ShimState) {
  const valid = overlayStateValid(state);
  const probe = valid ? stableShimPathProbe(state.wrapperPath) : null;
  const runnable = !!probe && probe.fingerprint.kind === "file" && isHealthyShimProbe(probe, state.platform)
    && isCurrentUnixShimProbe(probe) && usableNativeLauncher(state.launcherPath!)
    && probe.prefix.includes(`exec ${shQuote(state.launcherPath!)} "$@"`);
  const active = runnable && pathActive(state.wrapperPath);
  return { installed: true, healthy: active, runnable, active,
    summary: `Codex PATH shim: ${runnable ? "ready" : "unhealthy"} at ${state.wrapperPath}; launcher ${state.launcherPath}; PATH ${active ? "active" : "inactive"}. ${overlayActivationHint()}` };
}
export function overlayActivationHint(): string {
  const command = `. ${shQuote(overlayPaths().env)}`;
  return `For sh/bash/zsh, run ${command} and add that line after other PATH setup in your shell startup file. Absolute Codex paths and GUI launchers bypass this shim.`;
}
function writeShellEnv(): void {
  const { wrapper, env } = overlayPaths();
  // Source twice without duplicating PATH. Re-sourcing also restores first priority.
  const content = [
    "# opencodex managed Codex PATH",
    `ocx_shim_dir=${shQuote(dirname(wrapper))}`,
    'ocx_shim_rest="${PATH-}"',
    'ocx_shim_path="$ocx_shim_dir"',
    'ocx_shim_more=1',
    'while [ "$ocx_shim_more" = 1 ]; do',
    '  case "$ocx_shim_rest" in',
    '    *:*) ocx_shim_part="${ocx_shim_rest%%:*}"; ocx_shim_rest="${ocx_shim_rest#*:}" ;;',
    '    *) ocx_shim_part="$ocx_shim_rest"; ocx_shim_more=0 ;;',
    '  esac',
    '  if [ "$ocx_shim_part" != "$ocx_shim_dir" ]; then ocx_shim_path="$ocx_shim_path:$ocx_shim_part"; fi',
    'done',
    'export PATH="$ocx_shim_path"',
    'unset ocx_shim_dir ocx_shim_rest ocx_shim_path ocx_shim_more ocx_shim_part', "",
  ].join("\n");
  const envProbe = stableShimPathProbe(env);
  if (pathEntryExists(env) && (!envProbe || envProbe.fingerprint.kind !== "file" || !envProbe.prefix.startsWith("# opencodex managed Codex PATH\n"))) {
    throw new Error("Refusing to replace an unowned Codex shell environment file.");
  }
  recordOwnedConfigPath(getConfigDir(), env);
  const staged = `${env}.${randomUUID()}.tmp`;
  try {
    writeFileSync(staged, content, { flag: "wx", mode: 0o600 });
    renameSync(staged, env);
  } finally { try { unlinkSync(staged); } catch { /* published */ } }
}

/** Only private paths are written here. Native launchers remain package-manager owned. */
export function installUnixOverlay(discover: () => string | null, automatic = false): { installed: boolean; message: string } {
  const lock = tryAcquireShimRestoreLock();
  if (!lock) return { installed: false, message: "Codex shim operation is already in progress; retry later." };
  try {
    const result = readStateResult();
    const state = result.state;
    if (result.present && !state) return { installed: false, message: result.warning ?? "Invalid Codex shim state; refusing installation." };
    if (state && state.platform !== process.platform) return { installed: false, message: "Codex shim platform mismatch." };
    let launcher: string | null;
    if (state && state.mode !== "path-overlay") {
      if (automatic) return { installed: false, message: "Legacy Codex shim requires migration: run ocx codex-shim install." };
      const migration = migrateLegacyUnixShim(state);
      if (!migration.launcher) return { installed: false, message: migration.message };
      launcher = migration.launcher;
    } else {
      if (state && !overlayStateValid(state)) return { installed: false, message: "Invalid private Codex shim path." };
      launcher = state?.launcherPath ?? discover();
    }
    const { wrapper } = overlayPaths();
    if (!launcher || resolve(launcher) === resolve(wrapper) || !usableNativeLauncher(launcher)) {
      return { installed: false, message: "Native Codex launcher is missing or unusable. Repair Codex with its package manager, then run ocx codex-shim install." };
    }
    mkdirSync(dirname(wrapper), { recursive: true, mode: 0o700 });
    if (lstatSync(dirname(wrapper)).isSymbolicLink()) return { installed: false, message: "Refusing a symlinked private shim directory." };
    const before = shimPathFingerprint(wrapper);
    const previous = stableShimPathProbe(wrapper);
    if (pathEntryExists(wrapper) && (!previous || previous.fingerprint.kind !== "file" || !previous.prefix.includes(SHIM_MARKER))) {
      return { installed: false, message: "Refusing to replace an unowned private Codex launcher." };
    }
    const script = scriptFor(launcher);
    if (previous && previous.fingerprint.size === Buffer.byteLength(script) && previous.prefix === script && state?.mode === "path-overlay") {
      if (!automatic) writeShellEnv();
      return { installed: false, message: `Codex PATH shim already installed. ${overlayActivationHint()}` };
    }
    const staged = join(dirname(wrapper), `.codex.${randomUUID()}.tmp`);
    let published = false;
    try {
      writeFileSync(staged, script, { flag: "wx", mode: 0o600 });
      chmodSync(staged, 0o755);
      let stagedIdentity: ReturnType<typeof shimPathFingerprint> = null;
      // Probe with overlay PATH so dynamic redispatch cannot hide behind the native entry.
      const oldPath = process.env.PATH;
      // The actual wrapper must be reachable by name during probing. A temporary probe
      // directory provides that name without publishing an unvalidated wrapper.
      const probeDir = join(dirname(wrapper), `.probe-${randomUUID()}`);
      mkdirSync(probeDir, { mode: 0o700 });
      const probeWrapper = join(probeDir, "codex");
      let unsafe;
      try {
        linkSync(staged, probeWrapper);
        stagedIdentity = shimPathFingerprint(staged);
        process.env.PATH = `${probeDir}:${oldPath ?? ""}`;
        unsafe = probeUnixShimFiles([{ wrapperPath: probeWrapper, originalPath: launcher, backupPath: launcher, realPath: launcher }]);
      } finally {
        if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
        try { unlinkSync(probeWrapper); } finally { rmdirSync(probeDir); }
      }
      if (unsafe) return { installed: false, message: `Refusing Codex PATH shim: launcher --version probe ${typeof unsafe === "string" ? unsafe : `cleanup failed [phase=${unsafe.phase}; code=${unsafe.code}; status=${unsafe.status ?? "none"}; signal=${unsafe.signal}]`}. Native launcher was not replaced.` };
      const checkedStaging = shimPathFingerprint(staged);
      if (!stagedIdentity || !checkedStaging || !sameFingerprintAfterRename(stagedIdentity, checkedStaging)) return { installed: false, message: "Staged wrapper changed during validation; refusing publication." };
      const after = shimPathFingerprint(wrapper);
      if (before ? !after || !sameFingerprint(before, after) : pathEntryExists(wrapper)) {
        return { installed: false, message: "Private Codex wrapper changed during validation; retry later." };
      }
      if (before) renameSync(staged, wrapper);
      else { linkSync(staged, wrapper); unlinkSync(staged); }
      published = true;
      recordOwnedConfigPath(getConfigDir(), wrapper);
      writeState({ schemaVersion: 2, mode: "path-overlay", platform: process.platform, wrapperPath: wrapper, launcherPath: launcher });
      if (!automatic) writeShellEnv();
      return { installed: true, message: `Codex PATH shim installed at ${wrapper}. ${overlayActivationHint()}` };
    } finally { if (!published) { try { unlinkSync(staged); } catch { /* already removed */ } } }
  } finally { lock.release(); }
}

export function autoRestoreUnixOverlay(enabled: () => boolean) {
  const result = readStateResult();
  const state = result.state;
  if (!state) return { status: result.present ? "ineligible" as const : "not-installed" as const, ...(result.warning ? { message: result.warning } : {}) };
  if (state.platform !== process.platform) return { status: "ineligible" as const };
  if (state.mode !== "path-overlay") return { status: "ineligible" as const, message: "Legacy Codex shim requires migration: run ocx codex-shim install. Native launchers will not be re-wrapped automatically." };
  if (!overlayStateValid(state) || !usableNativeLauncher(state.launcherPath!)) return { status: "ineligible" as const, message: overlayDiagnostic(state).summary };
  const probe = stableShimPathProbe(state.wrapperPath);
  if (probe && probe.fingerprint.kind === "file" && probe.fingerprint.size === Buffer.byteLength(probe.prefix) && probe.prefix === scriptFor(state.launcherPath!)) return { status: "healthy" as const };
  if (!enabled()) return { status: "disabled" as const };
  const installed = installUnixOverlay(() => null, true);
  return installed.installed ? { status: "restored" as const, message: installed.message } : { status: "deferred" as const, message: installed.message };
}

export function uninstallUnixOverlay(state: ShimState): { removed: boolean; message: string } {
  if (!overlayStateValid(state)) return { removed: false, message: "Invalid private Codex shim state; refusing removal." };
  const lock = tryAcquireShimRestoreLock();
  if (!lock) return { removed: false, message: "Codex shim operation is already in progress." };
  try {
    const { wrapper, env } = overlayPaths();
    if (pathEntryExists(wrapper)) {
      const probe = stableShimPathProbe(wrapper);
      if (!probe || probe.fingerprint.kind !== "file" || !probe.prefix.includes(SHIM_MARKER)) return { removed: false, message: "Private Codex launcher is no longer owned; preserving it and its state." };
      unlinkSync(wrapper);
    }
    const envProbe = stableShimPathProbe(env);
    if (envProbe?.fingerprint.kind === "file" && envProbe.prefix.startsWith("# opencodex managed Codex PATH\n")) unlinkSync(env);
    unlinkSync(statePath());
    return { removed: true, message: "Codex PATH shim removed. Native Codex launcher was left unchanged. Remove the Codex shell-env source line from your shell startup file." };
  } finally { lock.release(); }
}
