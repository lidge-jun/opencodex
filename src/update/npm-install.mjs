// Windows Node-launcher compatibility code. The install owns its entire process tree until
// exit is proved; a timeout signal alone never authorizes stage removal.
import { guardedSpawn, guardedSpawnSync, materializeMutationData } from "./mutation-guard.mjs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { publishWindowsInstallerPid } from "./windows-installer-marker.mjs";
import { isTestHomeGuardArmed } from "./test-home-guard.mjs";

const JOIN_MS = 10000;
const failure = message => ({ status: null, processTreeExited: false, error: { code: "EINSTALLJOIN", message } });

let windowsSupervisorSeamsForTests = null;
/**
 * Test seam: drive the Windows supervisor branch with a fake platform and supervisor launcher. A
 * fake launcher skips guardedSpawn, so the seam refuses outside a test process.
 */
export function setWindowsInstallerSupervisorForTests(seams) {
  if (seams !== null && !isTestHomeGuardArmed()) throw Error("the Windows installer supervisor seam is test-only");
  windowsSupervisorSeamsForTests = seams;
}

/** Bridge synchronous pnpm transactions to the same Windows Job Object barrier. */
export function runWindowsInstallerSync(invocation, { env = process.env, cwd, timeoutMs = 180000, authorizeMutation = () => false, markerPath } = {}) {
  const moduleUrl = import.meta.url;
  const script = `import {readFileSync} from 'node:fs';import {runNpmInstall} from ${JSON.stringify(moduleUrl)};const input=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(await runNpmInstall(input.invocation,{timeoutMs:input.timeoutMs,markerPath:input.markerPath,authorizeMutation:()=>true})));`;
  const result = guardedSpawnSync(authorizeMutation, "package", process.execPath, ["--input-type=module", "-e", script], {
    input: JSON.stringify({ invocation, timeoutMs, markerPath }), env, cwd, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "inherit"],
  });
  try {
    const value = JSON.parse(result.stdout);
    if (result.status !== 0 || typeof value.processTreeExited !== "boolean") throw Error("invalid supervisor result");
    return value;
  } catch { return failure("Windows installer supervisor did not confirm process-tree exit"); }
}

function quoteWindowsArg(value) {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1") + '"';
}

export async function runNpmInstall(invocation, { env = process.env, timeoutMs = 180000, authorizeMutation = () => false, markerPath } = {}) {
  invocation = materializeMutationData(invocation);
  env = materializeMutationData(env);
  if (!invocation) return { status: 1, processTreeExited: true, error: { code: "ENOENT", message: "npm invocation unavailable" } };
  const seams = windowsSupervisorSeamsForTests;
  if ((seams?.platform ?? process.platform) === "win32") {
    // The PowerShell helper assigns npm to a kill-on-close Job Object before it
    // resumes the suspended process, then terminates the job on timeout and
    // waits for the job to become empty. An unconfirmed join retains the stage.
    // Windows acceptance still needs orchestrated npm and pnpm worker tests proving
    // marker visibility across supervisor failure and Job Object termination.
    // Resolve from the same absolute system directory as the hardened cmd hop.
    // Never search PATH for PowerShell, and never interpolate the JSON as code.
    const roots = new Set(Object.entries(env).filter(([key, value]) => key.toLowerCase() === "systemroot" && value !== undefined).map(([, value]) => value));
    const root = env.SystemRoot ?? (roots.size === 1 ? [...roots][0] : undefined);
    if (!root || !win32.isAbsolute(root)) return failure("absolute SystemRoot is required for npm process supervision");
    const supervisor = win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const helper = join(dirname(fileURLToPath(import.meta.url)), "npm-install-job.ps1");
    return new Promise(resolve => {
      const supervisorArgs = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper];
      const supervisorOptions = { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] };
      const child = seams?.launch ? seams.launch(supervisor, supervisorArgs, supervisorOptions) : guardedSpawn(authorizeMutation, "package", supervisor, supervisorArgs, {
        ...supervisorOptions,
      });
      let output = "";
      let invalid = false;
      let spawned = false;
      let completed = false;
      // Record the supervisor pid before it receives its request: the supervisor creates no installer
      // until stdin closes, so a launcher killed after this point leaves a marker whose witness is
      // the supervisor itself (#8524). "unrecorded" means nothing could be published and no
      // installer will start; "live" means an earlier supervisor still runs and keeps its witness.
      let witness = null;
      if (markerPath !== undefined) {
        try {
          if (!Number.isSafeInteger(child.pid) || child.pid <= 0) throw Error("installer supervisor has no pid");
          publishWindowsInstallerPid(markerPath, child.pid);
        } catch (error) { witness = error?.code === "EINSTALLWITNESS" ? "live" : "unrecorded"; }
      }
      const complete = result => {
        if (completed) return;
        completed = true;
        clearTimeout(watchdog);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        resolve(result);
      };
      const completeUnstarted = () => complete(witness === "live"
        ? { status: null, processTreeExited: false, error: { code: "EINSTALLJOIN", message: "an earlier installer supervisor is still running; installer not started" } }
        : { status: 1, processTreeExited: true, error: { code: "EINSTALLJOIN", message: "installer supervisor pid could not be recorded; installer not started" } });
      const watchdog = setTimeout(() => {
        child.kill();
        complete(failure(`npm supervisor exceeded ${timeoutMs} ms install budget and exit-confirmation budget; stage retained`));
      }, timeoutMs + JOIN_MS + 30000);
      child.on("spawn", () => { spawned = true; });
      child.stderr.on("data", chunk => { if (!completed) process.stderr.write(chunk); });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        if (output.length + chunk.length > 16384) { invalid = true; child.kill(); complete(failure("invalid npm supervisor output; stage retained")); }
        else output += chunk.toString("utf8");
      });
      child.on("error", error => {
        if (witness !== null) { if (!spawned) completeUnstarted(); return; }
        complete({ status: null, processTreeExited: !spawned, error: { code: error.code, message: error.message } });
      });
      child.on("close", status => {
        clearTimeout(watchdog);
        if (witness !== null) { completeUnstarted(); return; }
        try {
          const result = JSON.parse(output);
          if (invalid || status !== 0 || typeof result.processTreeExited !== "boolean"
            || !(result.status === null || Number.isInteger(result.status))) throw new Error("invalid supervisor result");
          complete(result);
        } catch { complete(failure("npm supervisor did not confirm process-tree exit; stage retained")); }
      });
      child.stdin.on("error", () => { /* close/result decides whether the helper ran */ });
      if (witness !== null) {
        // No request: the supervisor never creates the job or the installer.
        child.stdin.end();
        child.kill();
        return;
      }
      const args = invocation.options?.windowsVerbatimArguments ? invocation.args.join(" ") : invocation.args.map(quoteWindowsArg).join(" ");
      child.stdin.end(JSON.stringify({ file: invocation.file, commandLine: quoteWindowsArg(invocation.file) + " " + args,
        cwd: process.cwd(), timeoutMs, joinMs: JOIN_MS }));
    });
  }

  return failure("the npm Job Object supervisor is Windows-only");
}
