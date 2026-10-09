import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { readDesktopCliRecord } from "./desktop-cli-record.mjs";
import { isCodexCliUpdateInspectionArgv } from "../update/codex-cli-update-launch-policy.mjs";

const PROOF_PREFIX = "--ocx-internal-launch-proof=";

export function desktopHandoffExcluded(argv, env = process.env) {
  const args = argv.filter(arg => !arg.startsWith(PROOF_PREFIX));
  return env.OCX_NO_DESKTOP_HANDOFF === "1"
    || ["update", "uninstall", "remove"].includes(args[0])
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
  } catch (error) {
    return error?.code === "ENOENT"
      ? { kind: "continue", reason: "target-missing" }
      : { kind: "error", issue: "target-unusable" };
  }
}

export function runDesktopCliHandoff(plan, launch, deps = {}) {
  const spawnChild = deps.spawn ?? spawn;
  const parent = deps.parent ?? process;
  const platform = deps.platform ?? process.platform;
  const lstat = deps.lstat ?? lstatSync;
  const spawnFailure = error => {
    if (error?.code === "ENOENT") {
      try { lstat(plan.target); }
      catch (checkError) { if (checkError?.code === "ENOENT") return { kind: "continue" }; }
    }
    return { kind: "error", issue: "spawn-failed" };
  };
  const argv = launch.argv.filter(arg => !arg.startsWith(PROOF_PREFIX));
  const env = { ...launch.env, OCX_NO_DESKTOP_HANDOFF: "1", OCX_NODE_LAUNCH_CONTEXT: launch.context };
  delete env.OCX_BUN_RUNTIME_SOURCE;
  delete env.OCX_BUN_RUNTIME_PATH;
  return new Promise(resolveExit => {
    let child;
    try {
      child = spawnChild(plan.target, [`${PROOF_PREFIX}${launch.proof}`, ...argv], {
        stdio: "inherit", shell: false, windowsHide: true, env,
      });
    } catch (error) {
      resolveExit(spawnFailure(error));
      return;
    }
    const forwarded = platform === "win32" ? ["SIGINT", "SIGTERM"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    const handlers = forwarded.map(signal => {
      const handler = () => { try { child.kill(signal); } catch { /* child already exited */ } };
      parent.on(signal, handler);
      return [signal, handler];
    });
    const clear = () => { for (const [signal, handler] of handlers) parent.removeListener(signal, handler); };
    let done = false;
    const finish = result => { if (done) return; done = true; clear(); resolveExit(result); };
    child.once("error", error => finish(spawnFailure(error)));
    child.once("exit", (code, signal) => finish({ kind: "exit", code: code ?? 1, signal }));
  });
}
