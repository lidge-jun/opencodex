// Windows Node-launcher compatibility code. The install owns its entire process tree until
// exit is proved; a timeout signal alone never authorizes stage removal.
import { guardedSpawn, guardedSpawnSync, materializeMutationData } from "./mutation-guard.mjs";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const JOIN_MS = 10000;
const failure = message => ({ status: null, processTreeExited: false, error: { code: "EINSTALLJOIN", message } });

/** Bridge synchronous pnpm transactions to the same Windows Job Object barrier. */
export function runWindowsInstallerSync(invocation, { env = process.env, cwd, timeoutMs = 180000, authorizeMutation = () => false } = {}) {
  const moduleUrl = import.meta.url;
  const script = `import {readFileSync} from 'node:fs';import {runNpmInstall} from ${JSON.stringify(moduleUrl)};const input=JSON.parse(readFileSync(0,'utf8'));console.log(JSON.stringify(await runNpmInstall(input.invocation,{timeoutMs:input.timeoutMs,authorizeMutation:()=>true})));`;
  const result = guardedSpawnSync(authorizeMutation, "package", process.execPath, ["--input-type=module", "-e", script], {
    input: JSON.stringify({ invocation, timeoutMs }), env, cwd, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "inherit"],
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

export async function runNpmInstall(invocation, { env = process.env, timeoutMs = 180000, authorizeMutation = () => false } = {}) {
  invocation = materializeMutationData(invocation);
  env = materializeMutationData(env);
  if (!invocation) return { status: 1, processTreeExited: true, error: { code: "ENOENT", message: "npm invocation unavailable" } };
  if (process.platform === "win32") {
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
      const child = guardedSpawn(authorizeMutation, "package", supervisor, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", helper], {
        env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let invalid = false;
      let spawned = false;
      let completed = false;
      const complete = result => {
        if (completed) return;
        completed = true;
        clearTimeout(watchdog);
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
        resolve(result);
      };
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
        complete({ status: null, processTreeExited: !spawned, error: { code: error.code, message: error.message } });
      });
      child.on("close", status => {
        clearTimeout(watchdog);
        try {
          const result = JSON.parse(output);
          if (invalid || status !== 0 || typeof result.processTreeExited !== "boolean"
            || !(result.status === null || Number.isInteger(result.status))) throw new Error("invalid supervisor result");
          complete(result);
        } catch { complete(failure("npm supervisor did not confirm process-tree exit; stage retained")); }
      });
      child.stdin.on("error", () => { /* close/result decides whether the helper ran */ });
      const args = invocation.options?.windowsVerbatimArguments ? invocation.args.join(" ") : invocation.args.map(quoteWindowsArg).join(" ");
      child.stdin.end(JSON.stringify({ file: invocation.file, commandLine: quoteWindowsArg(invocation.file) + " " + args,
        cwd: process.cwd(), timeoutMs, joinMs: JOIN_MS }));
    });
  }

  return failure("the npm Job Object supervisor is Windows-only");
}
