#!/usr/bin/env bun
/**
 * Unsigned local bundle build.
 *
 * `tauri build` always produces the updater archive, because `bundle.createUpdaterArtifacts` is
 * true and `plugins.updater.pubkey` is set. Without `TAURI_SIGNING_PRIVATE_KEY` it then refuses to
 * finish:
 *
 *     Finished 2 bundles at: .../OpenCodex.app, .../OpenCodex_2.61.0_aarch64.dmg
 *     A public key has been found, but no private key.
 *     Error failed to build app
 *
 * Both bundles exist at that point. The non-zero exit is correct for a release — an unsigned
 * updater artifact reaching users is worse than a failed build — but for someone building on their
 * own machine it reports a failure for a signing step they were never meant to perform, and a
 * wrapper script cannot tell it apart from a real failure.
 *
 * So this does not relax the check. It turns the updater artifact off for this one invocation, so
 * there is nothing to sign and nothing is skipped unsigned. Selecting bundle targets is not enough:
 * `createUpdaterArtifacts` is a config flag, so `--bundles app,dmg` still produces
 * `OpenCodex.app.tar.gz (updater)` and still fails. The override has to reach the config itself.
 *
 * Two more local-only behaviours, learned from a real GNOME desktop (devlog plan 260921,
 * 120_install_verification.md):
 *
 * - Formats build in SEPARATE invocations. A single `--bundles appimage,deb` call dies on the
 *   first failing format, so a host that cannot bundle an AppImage (a missing linuxdeploy
 *   dependency) also lost the deb it could have built. Each format is attempted, and the
 *   summary at the end names every format's outcome; the exit code is non-zero if any of
 *   them failed, and the artifacts that DID build are printed either way.
 * - A failing format is retried once with `--verbose`. At the bundler's default log level
 *   the error is a bare "failed to run linuxdeploy" with the tool's own diagnostics
 *   discarded; the verbose pass is the branch where that stderr actually reaches the
 *   terminal, so the failure says WHY instead of naming a tool nobody invoked.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** Bundle targets per host platform that carry no updater archive. */
const LOCAL_BUNDLES: Record<string, readonly string[]> = {
  darwin: ["app", "dmg"],
  win32: ["msi", "nsis"],
  linux: ["appimage", "deb"],
};

/**
 * Config merged over `tauri.conf.json` for this invocation only.
 *
 * Turning the artifact off is what makes the signing key unnecessary, rather than leaving it
 * required and unmet. The committed config keeps `createUpdaterArtifacts: true`, so the release
 * build is untouched.
 */
function localConfig(platform: string): string {
  return JSON.stringify({ bundle: {
    createUpdaterArtifacts: false,
    // Sign nested executables and the bundle even without a Developer ID. Leaving
    // their old linker signatures in place creates an app that macOS kills at launch.
    ...(platform === "darwin" ? { macOS: { signingIdentity: "-" } } : {}),
  } });
}

export interface SpawnResult {
  status: number | null;
  error?: Error;
}

export interface ArtifactEntry {
  path: string;
  mtimeMs: number;
}

export interface BuildLocalDeps {
  spawn(args: string[]): SpawnResult;
  log(line: string): void;
  error(line: string): void;
  listArtifacts(): ArtifactEntry[];
  argv: string[];
  platform: string;
}

export interface FormatAttempt {
  format: string;
  status: number;
}

export function summarizeAttempts(attempts: FormatAttempt[]): { exitCode: number; lines: string[] } {
  const lines = attempts.map(
    attempt => `[build:local] ${attempt.format}: ${attempt.status === 0 ? "ok" : `FAILED (exit ${attempt.status})`}`,
  );
  return { exitCode: attempts.every(attempt => attempt.status === 0) ? 0 : 1, lines };
}

export function runBuildLocal(deps: BuildLocalDeps): number {
  const bundles = LOCAL_BUNDLES[deps.platform];
  if (!bundles) {
    deps.error(`[build:local] unsupported host platform: ${deps.platform}`);
    return 1;
  }
  // Snapshot before building: a bundle directory that already holds last week's AppImage
  // must not be reported as this run's output when this run's AppImage attempt fails.
  const baseline = new Map(deps.listArtifacts().map(entry => [entry.path, entry.mtimeMs]));
  const attempts: FormatAttempt[] = [];
  for (const format of bundles) {
    // One invocation per format: a format this host cannot build must not destroy the
    // artifacts of formats it can.
    const args = ["tauri", "build", "--ci", "--bundles", format, "--config", localConfig(deps.platform), ...deps.argv];
    const first = deps.spawn(args);
    let status = first.status ?? 1;
    if (first.error) {
      deps.error(`[build:local] could not start tauri: ${first.error.message}`);
      status = 1;
    } else if (status !== 0) {
      // The bundler reports a bare "failed to run <tool>" at its default log level; the
      // verbose pass is where the tool's own stderr reaches the terminal. The retry is
      // diagnostics only — the recorded status stands either way.
      deps.error(`[build:local] ${format} failed; rerunning with --verbose for the bundler's diagnostics`);
      const retry = deps.spawn(["tauri", "--verbose", "build", "--ci", "--bundles", format, "--config", localConfig(deps.platform), ...deps.argv]);
      if (retry.error) deps.error(`[build:local] could not start tauri: ${retry.error.message}`);
    }
    attempts.push({ format, status });
  }
  // Name what THIS run produced even when something failed: an error line at the end is
  // the least visible place for artifacts that already built.
  const produced = deps.listArtifacts().filter(
    entry => !baseline.has(entry.path) || baseline.get(entry.path) !== entry.mtimeMs,
  );
  for (const entry of produced) deps.log(`[build:local] ${entry.path}`);
  const summary = summarizeAttempts(attempts);
  for (const line of summary.lines) deps.log(line);
  if (summary.exitCode === 0) {
    deps.log("[build:local] updater artifacts skipped; release signing is unchanged.");
  }
  return summary.exitCode;
}

function main(): void {
  const status = runBuildLocal({
    spawn: args => spawnSync("bunx", args, { cwd: desktopDir, stdio: "inherit" }),
    log: line => console.log(line),
    error: line => console.error(line),
    listArtifacts: () => {
      const bundleRoot = join(desktopDir, "src-tauri", "target", "release", "bundle");
      const artifacts: ArtifactEntry[] = [];
      for (const dir of ["macos", "dmg", "msi", "nsis", "appimage", "deb"]) {
        const directory = join(bundleRoot, dir);
        if (!existsSync(directory)) continue;
        for (const name of readdirSync(directory)) {
          if (/\.(app|dmg|msi|exe|AppImage|deb)$/i.test(name)) {
            const full = join(directory, name);
            artifacts.push({ path: full, mtimeMs: statSync(full).mtimeMs });
          }
        }
      }
      return artifacts;
    },
    argv: process.argv.slice(2),
    platform: process.platform,
  });
  process.exit(status);
}

if (import.meta.main) {
  main();
}
