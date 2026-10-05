/**
 * What to tell the operator after a failed self-update (#5624).
 *
 * The transactional updater (`transactional-install.mjs`) either leaves the live package
 * untouched, rolls it back, or — only on a double fault — leaves it moved aside with a recovery
 * marker. Each of those needs a different next step, and the one command a user most often
 * reaches for after a failed update, a bare `npm install -g` under a live proxy, is the one that
 * fences the proxy (#5496). So the guidance stops the proxy first.
 *
 * Plain ESM with no Bun APIs: the Node launcher (`bin/ocx.mjs`) imports it.
 */

import { pnpmGlobalCommandArgs } from "./pnpm-global-install.mjs";

/**
 * Manual replacement must wait for recovery and stop the runtime through its owner first.
 * @param {{ bin: string; args: string[]; owner?: import("./pnpm-global-install.mjs").PnpmGlobalOwner; platform?: NodeJS.Platform }} command
 * @returns {string[]}
 */
export function manualUpdateFailureGuidance({ bin, args, owner, platform = process.platform }) {
  const windows = platform === "win32";
  const quote = value => /^[a-zA-Z0-9_@./:=-]+$/.test(value) ? value
    : "'" + value.replaceAll("'", windows ? "''" : "'\\''") + "'";
  const commandBin = owner ? owner.commandPath : bin;
  const commandArgs = owner ? pnpmGlobalCommandArgs(args, owner) : args;
  const install = (windows ? "& " : "") + [commandBin, ...commandArgs].map(quote).join(" ");
  return [
    "Next: run 'ocx status' and let any in-progress recovery finish.",
    "If a proxy is running, stop it through its owner ('ocx stop', the owning service, or the desktop app) and confirm it has stopped before installing.",
    (windows ? "Then run in PowerShell: " : "Then run: ") + install,
    "After installation completes, restart through the owning service ('ocx service restart') or desktop app; run 'ocx start' if unmanaged.",
  ];
}

/** Phases in which the live package was never touched. */
const UNTOUCHED_PHASES = new Set(["stage", "verify", "swap-backup"]);

/**
 * @param {{ phase?: string; rolledBack?: boolean; pkgName: string; version?: string; tag?: string }} failure
 * @returns {{ previousVersionKept: boolean; lines: string[] }}
 */
export function npmUpdateFailureGuidance({ phase, rolledBack, pkgName, version, tag }) {
  const manual = manualUpdateFailureGuidance({
    bin: "npm", args: ["install", "-g", "--allow-scripts=bun", pkgName + "@" + (version || tag || "latest")],
  });
  const kept = UNTOUCHED_PHASES.has(phase ?? "") || rolledBack === true;
  if (!kept) {
    return {
      previousVersionKept: false,
      lines: [
        "The previous version was moved aside and could not be put back automatically.",
        "Next: run the \"restore\" command recorded in .ocx-recovery.json next to the package, or follow the manual reinstall steps below.",
        ...manual,
      ],
    };
  }
  return {
    previousVersionKept: true,
    lines: [
      "The previous version is still installed.",
      "Next: run 'ocx update' again. If it fails the same way, reinstall manually:",
      ...manual,
    ],
  };
}

/**
 * The dashboard job only sees the launcher's exit status; its output is withheld because it can
 * carry local paths. Point at the terminal, where the launcher prints the phase-specific step.
 */
export const GUI_UPDATE_FAILURE_NEXT_STEP =
  "Run 'ocx update' in a terminal to see the reason and the exact recovery step.";
