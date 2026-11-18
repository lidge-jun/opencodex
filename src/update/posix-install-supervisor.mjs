import { spawn } from "node:child_process";
import { guardedSpawnSync } from "./mutation-guard.mjs";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

// The supervisor runs through a dedicated entry file: this library is also bundled into the
// compiled CLI, where every module shares one entry URL, so it must have no top-level effects.
const entry = join(dirname(fileURLToPath(import.meta.url)), "posix-install-supervisor-entry.mjs");
const failed = message => ({ status: null, groupExited: false, processTreeExited: false, error: { code: "EINSTALLJOIN", message } });

// The synchronous transaction waits for this separate supervisor, which keeps a
// detached group leader blocked until its pid and pgid are durable in the marker.
export function runPosixInstallerSync({ file, args, markerPath, timeoutMs = 180000, env, cwd, authorizeMutation = () => true }) {
  if (!authorizeMutation("package")) return { status: 1, groupExited: true, groupKilled: false };
  const input = JSON.stringify({ file, args, markerPath, timeoutMs, cwd });
  const result = guardedSpawnSync(authorizeMutation, "package", process.execPath, [entry, "supervise"], { input, encoding: "utf8", env, cwd, stdio: ["pipe", "pipe", "inherit"] });
  try {
    const value = JSON.parse(result.stdout);
    if (result.status !== 0 || typeof value.groupExited !== "boolean" || typeof value.groupKilled !== "boolean"
      || !(value.status === null || Number.isInteger(value.status)) || !(value.signal === null || typeof value.signal === "string")) throw Error("invalid result");
    return value;
  } catch { return failed("installer supervisor did not confirm process-tree exit"); }
}

function publish(path, pid) {
  const marker = JSON.parse(readFileSync(path, "utf8"));
  if (marker.phase !== "mutating" || !Number.isSafeInteger(marker.pid)) throw Error("invalid update marker");
  const temp = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    writeFileSync(temp, JSON.stringify({ ...marker, installerPid: pid, installerPgid: pid }), { flag: "wx", mode: 0o600 });
    created = true;
    renameSync(temp, path);
    created = false;
  } finally {
    if (created) try { unlinkSync(temp); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function alive(pgid) {
  try { process.kill(-pgid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

async function supervise(config) {
  const group = spawn(process.execPath, [entry, "install"], { detached: true, stdio: ["pipe", "ignore", "inherit"], cwd: config.cwd, env: process.env });
  const spawned = await new Promise(resolve => { group.once("spawn", () => resolve(true)); group.once("error", () => resolve(false)); });
  if (!spawned || !group.pid) return { status: null, groupExited: true, processTreeExited: false, error: { code: "ESPAWN", message: "installer group could not start" } };
  const pid = group.pid;
  try { publish(config.markerPath, pid); }
  catch (error) {
    try { process.kill(-pid, "SIGKILL"); }
    catch (killError) { if (killError.code !== "ESRCH") return failed(`could not publish or terminate installer group: ${killError.message}`); }
    return failed(`could not publish installer group: ${error.message}`);
  }
  const closed = new Promise(resolve => group.once("close", (status, signal) => resolve({ status, signal })));
  group.stdin.on("error", () => {});
  group.stdin.end(JSON.stringify({ file: config.file, args: config.args, cwd: config.cwd }));
  let timer;
  const timed = new Promise(resolve => { timer = setTimeout(() => resolve(null), config.timeoutMs); });
  const result = await Promise.race([closed, timed]); clearTimeout(timer);
  // Even an exited leader may have left descendants in its process group.
  let groupKilled = false;
  try { if (alive(pid)) { process.kill(-pid, "SIGKILL"); groupKilled = true; } }
  catch (error) { if (error.code !== "ESRCH") return failed("could not terminate installer group"); }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { if (!alive(pid)) return { status: result?.status ?? null, signal: result?.signal ?? null, groupExited: true, groupKilled,
      ...(result?.status == null ? { processTreeExited: false } : {}) }; }
    catch (error) { return failed(`could not inspect installer group: ${error.code ?? error.message}`); }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return failed("installer group termination was not confirmed");
}

/** Entry-point body for posix-install-supervisor-entry.mjs. */
export async function runPosixInstallerSupervisorMain() {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (process.argv[2] === "supervise") {
    console.log(JSON.stringify(await supervise(input)));
  } else if (process.argv[2] === "install") {
    const child = spawn(input.file, input.args, { cwd: input.cwd, env: process.env, stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", () => { process.exitCode = 1; });
    child.on("close", (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code ?? 1; });
  }
}
