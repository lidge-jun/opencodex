import { linkSshSpawnEnv, type SshRunResult, type SshRunner } from "../link/ssh-runner";

export type FanoutProcessFailure = "deadline-exceeded" | "termination-unconfirmed" | "ssh-spawn-failed" | "ssh-output";
export class FanoutProcessError extends Error {
  constructor(readonly reason: FanoutProcessFailure, options?: ErrorOptions) {
    super(reason, options);
    this.name = "FanoutProcessError";
  }
}

function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

async function readBounded(stream: ReadableStream<Uint8Array>, cap: number, exited: Promise<number>): Promise<string> {
  const reader = stream.getReader();
  let ended = false;
  let graceExpired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  void exited.then(() => { if (!ended) timer = setTimeout(() => { graceExpired = true; void reader.cancel().catch(() => {}); }, 250); });
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        if (graceExpired) throw new FanoutProcessError("ssh-output");
        break;
      }
      length += next.value.length;
      if (length > cap) throw new FanoutProcessError("ssh-output");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch (cause) { throw new FanoutProcessError("ssh-output", { cause }); }
  } finally {
    ended = true;
    if (timer !== undefined) clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function runFanoutProcess(argv: readonly string[], options: {
  timeoutMs: number; maxOutputBytes?: number; onSpawn?: (pid: number) => void;
}): Promise<SshRunResult> {
  if (options.timeoutMs <= 0) throw new FanoutProcessError("deadline-exceeded");
  const env = linkSshSpawnEnv();
  let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", ...(env ? { env } : {}) });
  } catch (cause) { throw new FanoutProcessError("ssh-spawn-failed", { cause }); }
  options.onSpawn?.(child.pid);
  let exited = false;
  const exit = child.exited.then(code => { exited = true; return code; });
  const stdout = readBounded(child.stdout, options.maxOutputBytes ?? 65536, exit);
  const stderr = readBounded(child.stderr, options.maxOutputBytes ?? 65536, exit);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new FanoutProcessError("deadline-exceeded")), Math.max(0, options.timeoutMs)); });
  try {
    const [code, out, err] = await Promise.race([Promise.all([exit, stdout, stderr]), deadline]);
    return { code, stdout: out, stderr: err };
  } catch (error) {
    let signalError = false;
    const signal = (name: NodeJS.Signals): void => {
      if (exited) return;
      try { child.kill(name); } catch (cause) {
        if (cause && typeof cause === "object" && "code" in cause && cause.code === "ESRCH") { exited = true; return; }
        signalError = true;
      }
    };
    signal("SIGTERM");
    if (!exited) await Promise.race([exit, delay(2000)]);
    if (!exited) signal("SIGKILL");
    if (!exited) await Promise.race([exit, delay(1000)]);
    if (signalError || !exited) throw new FanoutProcessError("termination-unconfirmed", { cause: error });
    if (error instanceof FanoutProcessError) throw error;
    throw new FanoutProcessError("ssh-output", { cause: error });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    void Promise.allSettled([exit, stdout, stderr]);
  }
}

/** Platform discovery shares the worker deadline across its SSH calls. */
export function fanoutSshRunner(deadline: number): Pick<SshRunner, "run"> {
  return { run: (argv, options = {}) => runFanoutProcess(argv, {
    timeoutMs: Math.min(options.timeoutMs ?? 30_000, Math.max(0, deadline - Date.now())),
    ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
  }) };
}
