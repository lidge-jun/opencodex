/**
 * `ocx doctor` check for a package install whose bundled Bun dependency never finished
 * installing (#8361).
 *
 * npm 12 blocks dependency lifecycle scripts by default. The `bun` npm package downloads nothing
 * in its tarball: its postinstall copies the selected `@oven/bun-*` executable into `bin/`. An
 * install that skipped that script succeeds and leaves a ~450-byte placeholder, so the launcher
 * fails later with "the `bun` dependency is not installed". Doctor is where an operator looks
 * after that failure, so it names the state and the exact command that repairs it.
 *
 * The check is observe-only and never fails the doctor run: a leftover PATH Bun or an explicit
 * `OPENCODEX_BUN_PATH` can still be serving requests, which makes this a degraded install rather
 * than an unusable surface.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as bunRuntime from "../lib/bun-runtime";
import * as installDetection from "../update/install-detection.mjs";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const BUNDLED_BUN_MISSING_DETAIL = "the `bun` dependency is not installed";
export const NPM_BUN_REPAIR_COMMAND = "npm install -g --allow-scripts=bun @bitkyc08/opencodex";

type PackageInstaller = "npm" | "pnpm" | "bun" | "mise";

export type BundledBunDiagnostic =
  | { status: "ready"; path: string }
  | { status: "not-applicable" }
  | { status: "missing"; installer: PackageInstaller; lines: string[] };

export interface BundledBunDiagnosticDeps {
  platform?: NodeJS.Platform;
  bundledPath?: () => string | null;
  detectOwnership?: () => { installer: string; owner?: { tool: string } | null };
}

/** The command that reinstalls this package while allowing bun's postinstall. */
export function bundledBunRepairCommand(installer: PackageInstaller, tool?: string | null): string | null {
  if (installer === "npm") return NPM_BUN_REPAIR_COMMAND;
  if (installer === "pnpm") return "pnpm add -g --allow-build=bun @bitkyc08/opencodex";
  if (installer === "bun") return "bun add -g @bitkyc08/opencodex";
  return tool ? `mise upgrade ${tool}` : null;
}

export function collectBundledBunDiagnostic(deps: BundledBunDiagnosticDeps = {}): BundledBunDiagnostic {
  const bundled = (deps.bundledPath ?? bunRuntime.bundledBunPath)();
  if (bundled) return { status: "ready", path: bundled };

  const ownership = (deps.detectOwnership
    ?? (() => installDetection.detectInstallOwnershipFromPath(PACKAGE_ROOT)))();
  const installer = ownership.installer;
  // Only the mise verdict carries an owner; the others have no tool to name.
  const ownerTool = "owner" in ownership ? ownership.owner?.tool ?? null : null;
  // A source checkout has no bundled dependency by design, and a standalone binary carries its
  // own runtime; neither is a skipped-postinstall symptom.
  if (installer !== "npm" && installer !== "pnpm" && installer !== "bun" && installer !== "mise") {
    return { status: "not-applicable" };
  }

  const repair = bundledBunRepairCommand(installer, ownerTool);
  const windows = (deps.platform ?? process.platform) === "win32";
  const lines = [
    `  !!     ${BUNDLED_BUN_MISSING_DETAIL} (its postinstall was skipped or the dependency is incomplete)`,
    "         Allow bun's own install script; npm 12 blocks lifecycle scripts by default,",
    "         and --ignore-scripts or ignore-scripts=true in an npmrc blocks it on any npm",
  ];
  if (!repair) {
    lines.push("         This mise-owned installation has no verified tool name; upgrade it through mise.");
    return { status: "missing", installer, lines };
  }
  if (windows && installer === "npm") {
    // A running bun.exe holds node_modules/bun/bin open, so npm fails with EBUSY. The instruction
    // has to stop first; `ocx update` does this itself, but a manual reinstall does not.
    lines.push("         Stop the proxy first so Windows releases node_modules/bun/bin, then run:");
    lines.push("           ocx stop");
    lines.push(`           ${repair}`);
    lines.push("         Restart afterwards: ocx service restart (or ocx start when unmanaged)");
  } else {
    lines.push("         Fix: reinstall with the package manager that owns this install:");
    lines.push(`           ${repair}`);
  }
  return { status: "missing", installer, lines };
}

/** Render the doctor "Bundled Bun runtime" section lines. */
export function formatBundledBunDiagnosticLines(diagnostic: BundledBunDiagnostic): string[] {
  if (diagnostic.status === "ready") return [`  ok     ready: ${diagnostic.path}`];
  if (diagnostic.status === "not-applicable") return [];
  return diagnostic.lines;
}
