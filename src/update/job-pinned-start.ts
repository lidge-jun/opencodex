import { guardedSpawn } from "./mutation-guard.mjs";
import type { ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { withoutSiblingMarker } from "../codex/sibling-start";
import type { UpdateMutationAuthorizer } from "./mutation-guard.mjs";

/** The guard runs after log-file setup, immediately before creating the pinned runtime. */
export function spawnWorkerPinnedStart(cmd: { bin: string; args: string[]; display: string },
  authorizeMutation: UpdateMutationAuthorizer, report: (line: string) => void, formatError: (error: unknown) => string): ChildProcess {
  // An ordinary owner: a stray sibling marker would otherwise mark it before any probe.
  const env: NodeJS.ProcessEnv = withoutSiblingMarker(process.env);
  delete env.OCX_SERVICE;
  report(`$ ${cmd.display}`);
  let stdio: "ignore" | [ "ignore", number, number ] = "ignore";
  let logFd: number | undefined;
  try {
    const logPath = join(getConfigDir(), "update-pinned-start.log");
    mkdirSync(getConfigDir(), { recursive: true });
    logFd = openSync(logPath, "a");
    writeSync(logFd, `\n--- ${new Date().toISOString()} ---\n$ ${cmd.display}\n`);
    stdio = ["ignore", logFd, logFd];
  } catch { /* fall back to ignored stdio */ }
  if (!authorizeMutation("runtime")) {
    if (logFd !== undefined) closeSync(logFd);
    throw new Error("Automatic update restart refused; check 'ocx service status'.");
  }
  let child: ChildProcess;
  try { child = guardedSpawn(authorizeMutation, "runtime", cmd.bin, cmd.args, {
    detached: true,
    stdio,
    windowsHide: true,
    env,
  }); } finally { if (logFd !== undefined) closeSync(logFd); }
  child.once("error", err => {
    try {
      report(`Pinned start spawn error: ${formatError(err)}`);
    } catch { /* best-effort */ }
  });
  // Foreground `ocx start` keeps the listen process; EADDRINUSE/ghost races exit quickly
  // with stdio ignored — surface that so the job log explains a silent miss.
  child.once("exit", (code, signal) => {
    if (code === 0 && !signal) return;
    try {
      report(
        `Pinned start exited early (code=${code ?? "null"} signal=${signal ?? "null"}).`,
      );
    } catch { /* best-effort */ }
  });
  child.unref();
  return child;
}
