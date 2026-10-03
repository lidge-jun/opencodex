import { MessageBudget } from "./budget";
import { LocalMessagingError } from "./types";

/** No shell, logging or retry. Only the command's own child is terminated/joined. */
export async function runMessageProcess(argv: readonly string[], budget: MessageBudget,
  options: { env?: NodeJS.ProcessEnv; stdin?: string; timeoutMs?: number } = {}): Promise<{ exitCode: number; stdout: string }> {
  budget.throwIfEnded();
  const stageTimeout = options.timeoutMs ?? 20_000;
  if (!Number.isInteger(stageTimeout) || stageTimeout <= 0 || stageTimeout > 20_000) {
    throw new LocalMessagingError("invalid_budget", "Helper timeout must be between 1 and 20000 milliseconds.");
  }
  const timeoutMs = budget.remainingMs(stageTimeout);
  let child: Bun.Subprocess<"pipe", "pipe", "pipe">;
  const ownGroup = process.platform !== "win32";
  try { child = Bun.spawn([...argv], { stdin: "pipe", stdout: "pipe", stderr: "pipe",
    detached: ownGroup, env: options.env ?? process.env }); }
  catch { throw new LocalMessagingError("process_not_started", "Codex helper could not be started; no submission was attempted."); }
  let incomplete = false;
  let force: ReturnType<typeof setTimeout> | undefined;
  const killOwned = (signal: NodeJS.Signals) => {
    try {
      // A launcher may fork native Codex and leave its inherited pipes open.
      // This fresh process group belongs solely to this invocation, not the daemon.
      if (ownGroup) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch { /* The owned process/group may already have exited. */ }
  };
  const terminate = () => {
    incomplete = true;
    killOwned("SIGTERM");
    force ??= setTimeout(() => killOwned("SIGKILL"), 1000);
  };
  budget.signal.addEventListener("abort", terminate, { once: true });
  const timer = setTimeout(terminate, timeoutMs);
  if (budget.signal.aborted) terminate();
  const read = async (stream: ReadableStream<Uint8Array>, capture: boolean): Promise<string> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.length;
        if (length > 64 * 1024) { terminate(); await reader.cancel(); break; }
        if (capture) chunks.push(chunk.value);
      }
      return Buffer.concat(chunks).toString("utf8");
    } finally { reader.releaseLock(); }
  };
  const output = read(child.stdout, true);
  const errors = read(child.stderr, false);
  try {
    if (options.stdin !== undefined) child.stdin.write(options.stdin);
    child.stdin.end();
    const [exitCode, stdout] = await Promise.all([child.exited, output, errors]);
    if (incomplete || budget.signal.aborted) throw new LocalMessagingError("process_incomplete", "Codex helper was cancelled, timed out or exceeded its output limit.");
    return { exitCode, stdout };
  } catch {
    terminate();
    await child.exited;
    await Promise.allSettled([output, errors]);
    throw new LocalMessagingError("process_incomplete", "Codex helper did not complete; submission may be uncertain.");
  } finally {
    clearTimeout(timer); clearTimeout(force);
    budget.signal.removeEventListener("abort", terminate);
  }
}
