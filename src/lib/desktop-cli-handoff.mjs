import { spawn } from "node:child_process";
import { forwardLauncherSignals } from "./launcher-signal-forwarding.mjs";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { readDesktopCliRecord } from "./desktop-cli-record.mjs";
import { isCodexCliUpdateInspectionArgv } from "../update/codex-cli-update-launch-policy.mjs";

const PROOF_PREFIX = "--ocx-internal-launch-proof=";

export function desktopHandoffExcluded(argv, env = process.env) {
  const args = argv.filter(arg => !arg.startsWith(PROOF_PREFIX));
  return env.OCX_NO_DESKTOP_HANDOFF === "1"
    || ["update", "uninstall", "remove"].includes(args[0])
    || (args[0] === "capabilities" && args.includes("--contracts"))
    || (args[0] ?? "").startsWith("__")
    || isCodexCliUpdateInspectionArgv(["node", "ocx.mjs", ...args]);
}

export function planDesktopCliHandoff(input = {}, deps = {}) {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") return { kind: "continue", reason: "windows-path-only" };
  const argv = input.argv ?? process.argv.slice(2);
  const env = input.env ?? process.env;
  if (desktopHandoffExcluded(argv, env)) return { kind: "continue", reason: "excluded" };
  const read = input.recordRead ?? readDesktopCliRecord({ env, platform: input.platform });
  if (read.state === "missing" || read.state === "disabled") {
    return { kind: "continue", reason: read.state };
  }
  if (read.state !== "ready") return { kind: "error", issue: read.issue };
  const api = platform === "win32" ? win32 : posix;
  const target = read.record.cliExecutable;
  if (!api.isAbsolute(target)) return { kind: "error", issue: "target-invalid" };
  const stat = deps.stat ?? statSync;
  const access = deps.access ?? accessSync;
  const realpath = deps.realpath ?? realpathSync;
  try {
    if (!stat(target).isFile()) return { kind: "error", issue: "target-invalid" };
    access(target, platform === "win32" ? constants.F_OK : constants.X_OK);
    const physical = realpath(target);
    const key = path => platform === "win32" ? path.toLowerCase() : path;
    for (const self of input.selfPaths ?? [process.argv[1], process.execPath]) {
      if (!self) continue;
      let own;
      try { own = realpath(self); }
      catch (error) { if (error?.code === "ENOENT") continue; throw error; }
      if (key(own) === key(physical)) return { kind: "error", issue: "target-self" };
    }
    return { kind: "handoff", target: physical };
  } catch {
    return { kind: "error", issue: "target-unusable" };
  }
}

export function runDesktopCliHandoff(plan, launch, deps = {}) {
  const spawnChild = deps.spawn ?? spawn;
  const parent = deps.parent ?? process;
  const platform = deps.platform ?? process.platform;
  const spawnFailure = () => ({ kind: "error", issue: "spawn-failed" });
  const argv = launch.argv.filter(arg => !arg.startsWith(PROOF_PREFIX));
  const env = { ...launch.env, OCX_NO_DESKTOP_HANDOFF: "1", OCX_NODE_LAUNCH_CONTEXT: launch.context };
  delete env.OCX_BUN_RUNTIME_SOURCE;
  delete env.OCX_BUN_RUNTIME_PATH;
  return new Promise(resolveExit => {
    const forwarding = forwardLauncherSignals({ parent, platform });
    let child;
    try {
      child = spawnChild(plan.target, [`${PROOF_PREFIX}${launch.proof}`, ...argv], {
        stdio: "inherit", shell: false, windowsHide: true, env,
      });
    } catch {
      forwarding.clear();
      resolveExit(spawnFailure());
      return;
    }
    forwarding.attach(child);
    let done = false;
    const finish = result => { if (done) return; done = true; forwarding.clear(); resolveExit(result); };
    child.once("error", () => finish(spawnFailure()));
    let delegateError = false;
    child.once("exit", (code, signal) => finish(delegateError ? { kind: "error", issue: "spawn-failed" } : { kind: "exit", code: code ?? 1, signal }));
    if (child.pid && launch.onSpawn) {
      try { launch.onSpawn(child.pid); }
      catch (error) {
        delegateError = true;
        console.error(`opencodex: sync mutex delegate publication failed: ${error.message}`);
        try { child.kill(); } catch (killError) { console.error(`opencodex: failed to stop sync child: ${killError.message}`); }
      }
    }
  });
}
