import { linkSshSpawnEnv } from "../link/ssh-runner";
import { MessageBudget } from "./budget";
import { RemoteCapacity, remoteError, REMOTE_LIMITS } from "./remote-contract";

export interface RemoteHelper {
  readonly pid: number; readonly exited: Promise<number>; readonly output: Promise<string>;
  close(): Promise<void>;
}
/** Spawn only invocation-owned process groups; bounded drains and cleanup are shared by helpers/tunnels. */
export function spawnRemoteHelper(argv: readonly string[], capacity: RemoteCapacity, signal?: AbortSignal,
  stdin?: string, env = linkSshSpawnEnv()): RemoteHelper {
  if (signal?.aborted) throw remoteError("cancelled", "Messaging helper was cancelled before spawn.");
  const release = capacity.reserve("helpers");
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  try { child = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true, env }); }
  catch { release(); throw remoteError("ssh_unavailable", "The messaging SSH helper could not start."); }
  const readers = [child.stdout.getReader(), child.stderr.getReader()];
  let closing: Promise<void> | undefined;
  let failure: Error | undefined;
  const signalGroup = (kind: NodeJS.Signals) => {
    if (child.exitCode !== null) return;
    try { process.kill(-child.pid, kind); } catch { /* Exit racing owned cleanup is harmless. */ }
  };
  const close = (): Promise<void> => closing ??= (async () => {
    signal?.removeEventListener("abort", abort);
    signalGroup("SIGTERM");
    const force = setTimeout(() => signalGroup("SIGKILL"), 500);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([child.exited, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(remoteError("cleanup_incomplete", "An owned messaging helper did not exit within cleanup budget.")), REMOTE_LIMITS.shutdownMs);
      })]);
    } finally {
      clearTimeout(force); clearTimeout(timer);
      // Escaped descendants retaining a pipe cannot hold shutdown open forever.
      for (const reader of readers) void reader.cancel().catch(() => {});
      release();
    }
  })();
  const abort = () => { void close().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const drain = async (index: number): Promise<string> => {
    const chunks: Uint8Array[] = [], reservations: (() => void)[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await readers[index]!.read(); if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 64 * 1024) throw remoteError("ssh_output_limit", "Messaging helper output exceeded its limit.");
        const free = capacity.reserve("outputBytes", next.value.byteLength || 1);
        if (index === 0) { reservations.push(free); chunks.push(next.value); } else free();
      }
      return index === 0 ? new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) : "";
    } catch {
      failure = remoteError("ssh_incomplete", "Messaging helper output could not be captured safely.");
      abort(); return "";
    } finally { for (const free of reservations) free(); readers[index]!.releaseLock(); }
  };
  const output = Promise.all([drain(0), drain(1)]).then(([out]) => {
    if (failure) throw failure; return out;
  });
  void output.catch(() => {});
  void child.exited.then(() => { signal?.removeEventListener("abort", abort); release(); });
  try { if (stdin !== undefined) child.stdin.write(stdin); child.stdin.end(); }
  catch { abort(); throw remoteError("ssh_incomplete", "Messaging control input could not be written."); }
  return { pid: child.pid, exited: child.exited, output, close };
}

/** One bounded batch covers helper startup, stdin, exit and output; errors never include raw output. */
export async function runRemoteHelper(argv: readonly string[], budget: MessageBudget,
  capacity: RemoteCapacity, stdin?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  budget.throwIfEnded();
  const helper = spawnRemoteHelper(argv, capacity, budget.signal, stdin, env ?? linkSshSpawnEnv());
  try {
    const [code, output] = await Promise.all([helper.exited, helper.output]);
    budget.throwIfEnded();
    if (code !== 0) throw remoteError(code === 127 ? "remote_ocx_missing" : "ssh_failed", "Messaging SSH command did not complete successfully.");
    return output;
  } finally { await helper.close(); }
}
