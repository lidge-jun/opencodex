import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { SUBPROCESS_KILL_GRACE_MS, waitForSubprocessExit } from "../../lib/bounded-subprocess";
import { bundleSignatureDetailsReason, bundleTrustStat, untrustedBundleFilesystemReason, type AsyncBundleTrustDeps } from "./bundle-trust-policy";

export type { AsyncBundleTrustDeps } from "./bundle-trust-policy";

type CommandResult = { status: number | null; output: string; stdout: string };
// Match spawnSync's default per-stream maxBuffer. Overflow never supplies successful trust evidence.
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Spawn contract used by the trust runner; injectable so cancellation/reaping can be verified anywhere. */
export type TrustCommandSpawn = (
  file: string,
  args: readonly string[],
  options: { stdio: ["ignore", "pipe", "pipe"]; windowsHide: boolean },
) => ChildProcess;

function runTrustCommand(file: string, args: readonly string[], timeout: number, signal?: AbortSignal, spawnImpl: TrustCommandSpawn = spawn): Promise<CommandResult> {
  signal?.throwIfAborted();
  return new Promise(resolve => {
    const child = spawnImpl(file, [...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[][] = [[], []];
    const sizes = [0, 0];
    let settled = false;
    let stopping = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const stdout = Buffer.concat(chunks[0]!).toString("utf8");
      resolve({ status, stdout, output: stdout + Buffer.concat(chunks[1]!).toString("utf8") });
    };
    const exited = new Promise<number>(resolveExit => {
      child.once("exit", code => resolveExit(code ?? 1));
      child.once("error", () => { if (!child.pid) resolveExit(1); });
    });
    const stop = () => {
      if (stopping || settled) return;
      stopping = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* exit observation owns reaping */ }
      child.stdout?.destroy();
      child.stderr?.destroy();
      void waitForSubprocessExit({ exited, kill: () => child.kill("SIGKILL") }, SUBPROCESS_KILL_GRACE_MS)
        .then(() => finish(null));
    };
    const abort = () => stop();
    for (const [index, stream] of [child.stdout, child.stderr].entries()) {
      if (stream === null) continue;
      stream.on("data", (chunk: Buffer) => {
        if (stopping || settled) return;
        sizes[index] = sizes[index]! + chunk.length;
        if (sizes[index]! > MAX_OUTPUT_BYTES) { stop(); return; }
        chunks[index]!.push(chunk);
      });
      stream.on("error", stop);
    }
    child.once("error", () => { if (child.pid) stop(); else finish(null); });
    child.once("close", code => { if (!stopping) finish(code); });
    timer = setTimeout(stop, timeout);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) stop();
  });
}

/** Per-call lookup: no directory-service subprocess or signature check blocks the event loop. */
export async function defaultAsyncBundleTrustDeps(
  signal?: AbortSignal,
  overrides?: { spawn?: TrustCommandSpawn },
): Promise<AsyncBundleTrustDeps> {
  signal?.throwIfAborted();
  const spawnImpl = overrides?.spawn ?? spawn;
  const admin = await runTrustCommand("/usr/bin/dscl", [".", "-read", "/Groups/admin", "PrimaryGroupID"], 5_000, signal, spawnImpl);
  signal?.throwIfAborted();
  const adminId = admin.status === 0 ? /^PrimaryGroupID: ([0-9]+)\s*$/.exec(admin.stdout)?.[1] : undefined;
  return {
    adminGroupId: adminId === undefined ? undefined : Number(adminId),
    uid: typeof process.getuid === "function" ? process.getuid() : -1,
    stat: bundleTrustStat,
    codesign: (args, codeSignal) => runTrustCommand("/usr/bin/codesign", args, 30_000, codeSignal ?? signal, spawnImpl),
  };
}

/** Same trust policy as the sync API; cancellation rejects only after the owned child is reaped. */
export async function untrustedChatgptBundleReasonAsync(
  bundleRoot: string,
  binary: string | undefined = undefined,
  deps?: AsyncBundleTrustDeps,
  signal?: AbortSignal,
): Promise<string | null> {
  signal?.throwIfAborted();
  const checks = deps ?? await defaultAsyncBundleTrustDeps(signal);
  signal?.throwIfAborted();
  const filesystemProblem = untrustedBundleFilesystemReason(bundleRoot, binary, checks);
  if (filesystemProblem) return filesystemProblem;
  binary ??= join(bundleRoot, "Contents", "MacOS", "ChatGPT");
  for (const target of [bundleRoot, binary]) {
    signal?.throwIfAborted();
    const verified = await checks.codesign(["--verify", "--strict", target], signal);
    signal?.throwIfAborted();
    if (verified.status !== 0) return `${target} failed code-signature verification`;
    const details = await checks.codesign(["-dv", "--verbose=2", target], signal);
    signal?.throwIfAborted();
    const detailsProblem = bundleSignatureDetailsReason(target, details);
    if (detailsProblem) return detailsProblem;
  }
  return null;
}
