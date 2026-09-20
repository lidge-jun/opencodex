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
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopDir = dirname(dirname(fileURLToPath(import.meta.url)));

/** Bundle targets that carry no updater archive. */
const LOCAL_BUNDLES = ["app", "dmg"] as const;

/**
 * Config merged over `tauri.conf.json` for this invocation only.
 *
 * Turning the artifact off is what makes the signing key unnecessary, rather than leaving it
 * required and unmet. The committed config keeps `createUpdaterArtifacts: true`, so the release
 * build is untouched.
 */
const LOCAL_CONFIG = JSON.stringify({ bundle: { createUpdaterArtifacts: false } });

function run(): number {
  const extra = process.argv.slice(2);
  const args = [
    "tauri", "build", "--ci",
    "--bundles", LOCAL_BUNDLES.join(","),
    "--config", LOCAL_CONFIG,
    ...extra,
  ];
  const result = spawnSync("bunx", args, { cwd: desktopDir, stdio: "inherit" });
  if (result.error) {
    console.error(`[build:local] could not start tauri: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const status = run();
if (status === 0) {
  const bundleRoot = join(desktopDir, "src-tauri", "target", "release", "bundle");
  const app = join(bundleRoot, "macos", "OpenCodex.app");
  // Naming what exists is the point of the script: the previous output ended on an error line, so
  // the artifacts it had already written were the least visible thing in it.
  if (existsSync(app)) console.log(`[build:local] ${app}`);
  console.log("[build:local] updater artifacts skipped; release signing is unchanged.");
}
process.exit(status);
