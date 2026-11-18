/**
 * Headless Windows Desktop update (`ocx update --desktop`, #8246).
 *
 * One pass: read the published channel, and when it announces a newer version, download the
 * Windows MSI under the acquisition contract, verify it with the GUI updater's embedded key,
 * stage it where nothing with fewer rights than the installer can change it (`./staging.ts`) and
 * verify the staged copy again, install it non-interactively and wait for the installer's exit
 * code, read the installed `ocx.exe` version back, then make the serving
 * runtime that version. When nothing newer is published, the same pass still finishes an
 * earlier install whose old runtime is still serving. Every dependency is injected; the
 * production wiring is in `./cli.ts`.
 */
import { DESKTOP_ACQUIRE_LIMITS, DESKTOP_UPDATE_FEED_URL } from "./trust";
import { DesktopAcquireError, type AcquireTimers } from "./acquire";
import { compareToInstalled, DesktopUpdateRefusal, parseDesktopFeed, verifyDesktopInstaller } from "./release";
import { describeMsiOutcome, isInstalled, runMsiInstall, type InstallerSpawn, type MsiOutcome } from "./msi";
import { settleRuntime, type RuntimeOutcome, type RuntimeReplaceDeps } from "./runtime";
import { desktopUpdateCommand, type WindowsDesktopInstall } from "./install";
import { computeVersionSkew } from "../cli/version-skew";

export const HEADLESS_RESULT_SCHEMA = "ocx.desktop.headless-update/1";

/** 0 done; 1 nothing installed; 2 installed but the old runtime still serves; 3 uncertain; 64 usage. */
export const HEADLESS_EXIT = Object.freeze({ ok: 0, unchanged: 1, runtimeStale: 2, uncertain: 3, usage: 64 });

export type HeadlessOutcome =
  | "up-to-date"
  | "available"
  | "updated"
  | "runtime-replaced"
  | "installed-stopped"
  | "refused"
  | "failed"
  | "installer-failed"
  | "installer-uncertain"
  | "reboot-required"
  | "installed-version-mismatch"
  | "old-runtime-serving";

export interface HeadlessResult {
  schema: typeof HEADLESS_RESULT_SCHEMA;
  outcome: HeadlessOutcome;
  exitCode: number;
  installedVersion: string;
  targetVersion: string | null;
  runtime: { pid: number | null; port: number; version: string | null } | null;
  installer: { exitCode: number | null; log: string | null; rebootRequired: boolean } | null;
  reason: string | null;
  message: string;
}

export interface StagingArea {
  /** Create a private, operation-owned directory and return its path. */
  create(): string;
  write(path: string, bytes: Uint8Array): void;
  read(path: string): Uint8Array;
  join(dir: string, name: string): string;
  /** Remove this operation's directory, keeping only the named files when any are given. */
  discard(dir: string, keep: readonly string[]): void;
}

export interface HeadlessDeps {
  install: WindowsDesktopInstall;
  /** The version of the `ocx.exe` running this command, which is the installed version. */
  currentVersion: string;
  fetch(url: string, maxBytes: number): Promise<Uint8Array>;
  staging: StagingArea;
  /**
   * Rename the running `ocx.exe` image aside inside the installation (Windows allows renaming a
   * running executable) and return its new path, or null when this process is not running the
   * installed image. Without this, Windows Installer's Restart Manager closes this very process,
   * and everything sharing its console, to replace the file, and the install rolls back. Throws
   * when the image cannot be moved.
   */
  moveAsideOwnImage(): string | null;
  /**
   * After an install that did not complete, make sure the installed path holds an `ocx.exe`:
   * true when it already does or the moved image was put back.
   */
  restoreOwnImage(moved: string): boolean;
  /** Best effort: delete images earlier runs moved aside, and schedule `current` for deletion. */
  retireMovedImages(current: string | null): void;
  msiexecPath(): string;
  spawnInstaller: InstallerSpawn;
  timers: AcquireTimers;
  installerTimeoutMs?: number;
  runtimeDeadlineMs?: number;
  readInstalledVersion(ocxExe: string): Promise<string | null>;
  runtime: RuntimeReplaceDeps;
  log(line: string): void;
  /** Fixture key for tests only; the production composition never sets it and uses the embedded key. */
  fixturePublicKey?: string;
}

export const INSTALLER_TIMEOUT_MS = 15 * 60_000;
/**
 * Room for a connected client's 90-second restart budget, or a 75-second drain or service
 * restart, followed by the owner's respawn and the replacement's startup.
 */
export const RUNTIME_DEADLINE_MS = 240_000;

function runtimeView(live: { pid: number | null; port: number; version?: string } | null): HeadlessResult["runtime"] {
  return live ? { pid: live.pid, port: live.port, version: live.version ?? null } : null;
}

function staleMessage(outcome: Extract<RuntimeOutcome, { kind: "stale" }>, target: string, install: WindowsDesktopInstall): string {
  const live = outcome.live;
  const who = live ? `The proxy on port ${live.port}${live.pid !== null ? ` (pid ${live.pid})` : ""} still serves ${live.version ?? "an unknown version"}` : "No proxy answers with the installed version";
  const retry = `Replace it with: ${desktopUpdateCommand(install)} (or quit and reopen OpenCodex Desktop).`;
  switch (outcome.reason) {
    case "foreign-image":
      return `${who}; this installation is ${target}. It runs from ${outcome.detail ?? "another executable"}, not ${install.ocxExe}, so it was not stopped. Restart it from the installation that owns it.`;
    case "runtime-newer":
      return `${who}, which is newer than this installation (${target}); it was left running.`;
    case "unattested":
    case "unknown-version":
    case "incomparable":
      return `${who}; this installation is ${target}. Its identity or version could not be verified, so it was not stopped. Run 'ocx status', then restart it through its owner. ${retry}`;
    case "restart-refused":
      return `${who}; this installation is ${target}. The runtime refused a restart (${outcome.detail ?? "refused"}), so nothing was stopped. ${retry}`;
    case "drain-failed":
      return `${who}; this installation is ${target}. Stopping it for OpenCodex Desktop to restart did not complete (${outcome.detail ?? "unconfirmed"}). Run 'ocx status'. ${retry}`;
    case "service-restart-failed":
      return `${who}; this installation is ${target}. Its background service owns it, and '${install.ocxExe}' service restart did not replace it (${outcome.detail ?? "unconfirmed"}). `
        + `Nothing else was stopped; the installed version starts the next time that service starts the proxy, for example after Windows restarts. Run 'ocx service status'. ${retry}`;
    case "replacement-timeout":
      return `${who}; this installation is ${target}. A restart was requested but the new version was not observed answering in time. Run 'ocx status'. ${retry}`;
  }
}

export async function runHeadlessDesktopUpdate(options: { check: boolean }, deps: HeadlessDeps): Promise<HeadlessResult> {
  const installed = deps.currentVersion;
  const base = { schema: HEADLESS_RESULT_SCHEMA, installedVersion: installed, installer: null, reason: null } as const;
  const finish = (fields: Partial<HeadlessResult> & Pick<HeadlessResult, "outcome" | "exitCode" | "message">): HeadlessResult =>
    ({ ...base, targetVersion: null, runtime: null, ...fields });

  // 1. The published channel.
  let candidate;
  try {
    candidate = parseDesktopFeed(await deps.fetch(DESKTOP_UPDATE_FEED_URL, DESKTOP_ACQUIRE_LIMITS.maxFeedBytes));
  } catch (error) {
    return failure(error, null);
  }
  const relation = compareToInstalled(installed, candidate.version);
  const runtimeDeadline = () => deps.runtime.now() + (deps.runtimeDeadlineMs ?? RUNTIME_DEADLINE_MS);

  // 2. Nothing newer: an earlier install may still have an old runtime serving.
  if (relation !== "newer") {
    if (relation === "unknown") {
      return finish({ outcome: "refused", exitCode: HEADLESS_EXIT.unchanged, targetVersion: candidate.version, reason: "version_unknown",
        message: `The installed version ${installed} cannot be compared with the published ${candidate.version}; nothing was changed.` });
    }
    const live = await deps.runtime.findLive();
    // Only this home's attested runtime, older than this installation, is one an install left behind.
    const stale = live?.source === "runtime" && live.version !== undefined
      && computeVersionSkew(installed, live.version).relation === "cli-newer";
    if (options.check || !stale) {
      return finish({
        outcome: stale ? "old-runtime-serving" : "up-to-date",
        exitCode: stale ? HEADLESS_EXIT.runtimeStale : HEADLESS_EXIT.ok,
        targetVersion: candidate.version, runtime: runtimeView(live),
        message: stale
          ? `OpenCodex Desktop ${installed} is installed, but the running proxy still serves ${live!.version}. Replace it with: ${desktopUpdateCommand(deps.install)}`
          : `OpenCodex Desktop is up to date (${installed}).`,
      });
    }
    deps.log(`OpenCodex Desktop ${installed} is installed, but the running proxy serves ${live!.version}; replacing it.`);
    const settled = await settleRuntime({ installedExe: deps.install.ocxExe, targetVersion: installed, deadlineAt: runtimeDeadline(), wasRunning: true, expectedPort: live!.port }, deps.runtime);
    return fromRuntime(settled, installed, null, "runtime-replaced");
  }

  if (options.check) {
    const live = await deps.runtime.findLive();
    return finish({ outcome: "available", exitCode: HEADLESS_EXIT.ok, targetVersion: candidate.version, runtime: runtimeView(live),
      message: `OpenCodex Desktop ${candidate.version} is available (installed: ${installed}). Install it with: ${desktopUpdateCommand(deps.install)}` });
  }

  // 3. Download and verify.
  const found = await deps.runtime.findLive();
  // A proxy without this home's runtime record is not the one this update must replace.
  const before = found?.source === "runtime" ? found : null;
  deps.log(`Downloading OpenCodex Desktop ${candidate.version}…`);
  let bytes: Uint8Array;
  try {
    bytes = await deps.fetch(candidate.url, DESKTOP_ACQUIRE_LIMITS.maxArtifactBytes);
    verifyDesktopInstaller(bytes, candidate, deps.fixturePublicKey);
  } catch (error) {
    return failure(error, candidate.version);
  }
  deps.log(`Verified the installer signature for ${candidate.version}.`);

  // 4. Stage privately, verify the staged bytes again, install.
  let dir: string | null = null;
  let logPath: string | null = null;
  let moved: string | null = null;
  let installer: MsiOutcome;
  // Best effort: a file still held open (msiexec, an indexer) stays in this operation's directory.
  const discard = (keep: readonly string[]) => {
    if (!dir) return;
    try { deps.staging.discard(dir, keep); } catch { /* left for the user or the next temp cleanup */ }
  };
  try {
    deps.retireMovedImages(null);
    dir = deps.staging.create();
    const msiPath = deps.staging.join(dir, `OpenCodex-${candidate.version}-windows-x64.msi`);
    logPath = deps.staging.join(dir, "msiexec.log");
    deps.staging.write(msiPath, bytes);
    verifyDesktopInstaller(deps.staging.read(msiPath), candidate, deps.fixturePublicKey);
    try { moved = deps.moveAsideOwnImage(); }
    catch (error) {
      throw new Error(`the running ${deps.install.ocxExe} could not be moved aside for the installer (${error instanceof Error ? error.message : String(error)}); run this from an elevated terminal`);
    }
    deps.log("Installing (Windows Installer, no UI)…");
    installer = await runMsiInstall({ msiexec: deps.msiexecPath(), msiPath, logPath, timeoutMs: deps.installerTimeoutMs ?? INSTALLER_TIMEOUT_MS },
      { spawn: deps.spawnInstaller, timers: deps.timers });
  } catch (error) {
    if (moved) deps.restoreOwnImage(moved);
    discard([]);
    return failure(error, candidate.version);
  }
  const installerView = { exitCode: installer.code, log: logPath, rebootRequired: installer.kind === "installed-reboot-required" };
  const previous = moved ? ` The previous ocx.exe is at ${moved}.` : "";
  if (!isInstalled(installer)) {
    // A finished, rolled-back install has restored the copy at the installed path; the moved image
    // goes back only if that path is empty. An installer that may still be running is left alone
    // with everything it may hold open: the package, the log and the moved image.
    const uncertain = installer.kind === "uncertain";
    const restored = moved && !uncertain ? deps.restoreOwnImage(moved) : false;
    const stranded = moved && !restored ? ` The previous ocx.exe is at ${moved}.` : "";
    if (!uncertain) discard(logPath ? [logPath] : []);
    return finish({ outcome: uncertain ? "installer-uncertain" : "installer-failed",
      exitCode: uncertain ? HEADLESS_EXIT.uncertain : HEADLESS_EXIT.unchanged,
      targetVersion: candidate.version, runtime: runtimeView(before), installer: installerView, reason: installer.kind,
      message: `${describeMsiOutcome(installer)} Log: ${logPath}${uncertain ? ` The staged installer is kept in ${dir}.` : ""}${stranded}` });
  }
  deps.log(describeMsiOutcome(installer));

  // 5. Read the installed binary back; the moved image is retired only once it matches.
  const readBack = await deps.readInstalledVersion(deps.install.ocxExe);
  if (readBack !== candidate.version) {
    discard(logPath ? [logPath] : []);
    const reboot = installer.kind === "installed-reboot-required";
    return finish({ outcome: reboot ? "reboot-required" : "installed-version-mismatch",
      exitCode: reboot ? HEADLESS_EXIT.runtimeStale : HEADLESS_EXIT.uncertain,
      targetVersion: candidate.version, runtime: runtimeView(before), installer: installerView, reason: "installed_version",
      message: reboot
        ? `The installer finished but ${deps.install.ocxExe} still reports ${readBack ?? "no version"}; restart Windows to complete the update to ${candidate.version}. Log: ${logPath}${previous}`
        : `The installer reported success but ${deps.install.ocxExe} reports ${readBack ?? "no version"}, not ${candidate.version}. Log: ${logPath}${previous}` });
  }
  deps.retireMovedImages(moved);
  discard([]);

  // 6. Replace the runtime that still serves the old version.
  const settled = await settleRuntime({ installedExe: deps.install.ocxExe, targetVersion: candidate.version, deadlineAt: runtimeDeadline(), wasRunning: before !== null, ...(before ? { expectedPort: before.port } : {}) }, deps.runtime);
  return fromRuntime(settled, candidate.version, { ...installerView, log: null }, "updated");

  function fromRuntime(settled: RuntimeOutcome, target: string, installerResult: HeadlessResult["installer"], done: "updated" | "runtime-replaced"): HeadlessResult {
    const reboot = installerResult?.rebootRequired ? " Windows still has to restart to replace some files." : "";
    if (settled.kind === "serving-target") {
      return finish({ outcome: installerResult || settled.replaced ? done : "up-to-date", exitCode: HEADLESS_EXIT.ok, targetVersion: target,
        runtime: runtimeView(settled.live), installer: installerResult,
        message: `OpenCodex Desktop ${target} is installed and the proxy on port ${settled.live.port} serves ${target}.${reboot}` });
    }
    if (settled.kind === "not-running") {
      return finish({ outcome: "installed-stopped", exitCode: HEADLESS_EXIT.ok, targetVersion: target, installer: installerResult,
        message: `OpenCodex Desktop ${target} is installed. No proxy for this home was found, so none was started.${reboot}` });
    }
    return finish({ outcome: "old-runtime-serving", exitCode: HEADLESS_EXIT.runtimeStale, targetVersion: target,
      runtime: runtimeView(settled.live), installer: installerResult, reason: settled.reason,
      message: staleMessage(settled, target, deps.install) });
  }

  function failure(error: unknown, target: string | null): HeadlessResult {
    if (error instanceof DesktopUpdateRefusal) {
      return finish({ outcome: "refused", exitCode: HEADLESS_EXIT.unchanged, targetVersion: target, reason: error.code,
        message: `Update refused: ${error.message}. Nothing was installed.` });
    }
    if (error instanceof DesktopAcquireError) {
      return finish({ outcome: "failed", exitCode: HEADLESS_EXIT.unchanged, targetVersion: target, reason: error.code,
        message: `Download failed: ${error.message}${error.retryable ? " (retryable)" : ""}. Nothing was installed.` });
    }
    return finish({ outcome: "failed", exitCode: HEADLESS_EXIT.unchanged, targetVersion: target, reason: "internal",
      message: `Update failed before installation: ${error instanceof Error ? error.message : String(error)}. Nothing was installed.` });
  }
}
