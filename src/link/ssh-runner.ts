const DEFAULT_OUTPUT_BYTES = 64 * 1024;

export interface SshRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SshChild {
  readonly pid: number;
  readonly argv: readonly string[];
  readonly exited: Promise<number>;
  readonly stdout?: Promise<string>;
  readonly stderr?: Promise<string>;
  kill(signal?: NodeJS.Signals): void;
}

export interface SshRunner {
  run(argv: readonly string[], options?: {
    stdin?: string | Uint8Array;
    timeoutMs?: number;
    maxOutputBytes?: number;
  }): Promise<SshRunResult>;
  spawnTunnel(argv: readonly string[]): SshChild;
}

export class SshRunnerError extends Error {
  constructor(readonly code: "spawn" | "timeout" | "output_limit" | "decode", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SshRunnerError";
  }
}

async function readOutput(stream: ReadableStream<Uint8Array>, maxBytes: number, kill?: () => void): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        kill?.();
        throw new SshRunnerError("output_limit", `ssh output exceeded ${maxBytes} bytes`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new SshRunnerError("decode", "ssh output was not valid UTF-8", { cause: error });
  }
}

function outputStream(stream: Bun.Subprocess["stdout"]): ReadableStream<Uint8Array> {
  if (!stream || typeof stream === "number") throw new SshRunnerError("spawn", "ssh output was not piped");
  return stream;
}

function defaultKill(process: Bun.Subprocess, signal?: NodeJS.Signals): void {
  process.kill(signal);
}

export function createSshRunner(deps: { spawn?: typeof Bun.spawn; timeoutMs?: number } = {}): SshRunner {
  const spawn = deps.spawn ?? ((argv, options) => Bun.spawn(argv, options));
  const defaultTimeoutMs = deps.timeoutMs ?? 30_000;

  const spawnChild = (argv: readonly string[]): SshChild => {
    let child: Bun.Subprocess;
    try {
      child = spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    } catch (error) {
      throw new SshRunnerError("spawn", `could not spawn ${argv[0] ?? "ssh"}`, { cause: error });
    }
    const stdout = readOutput(outputStream(child.stdout), DEFAULT_OUTPUT_BYTES, () => defaultKill(child, "SIGTERM"));
    const stderr = readOutput(outputStream(child.stderr), DEFAULT_OUTPUT_BYTES, () => defaultKill(child, "SIGTERM"));
    void stdout.catch(() => {});
    void stderr.catch(() => {});
    return {
      pid: child.pid,
      argv: [...argv],
      exited: child.exited,
      stdout,
      stderr,
      kill: signal => defaultKill(child, signal),
    };
  };

  return {
    async run(argv, options = {}) {
      const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_BYTES;
      if (!Number.isInteger(maxOutputBytes) || maxOutputBytes < 0) {
        throw new SshRunnerError("output_limit", "maxOutputBytes must be a non-negative integer");
      }
      let child: Bun.Subprocess;
      try {
        child = spawn([...argv], {
          stdin: options.stdin === undefined ? "ignore" : "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
      } catch (error) {
        throw new SshRunnerError("spawn", `could not spawn ${argv[0] ?? "ssh"}`, { cause: error });
      }

    const stdout = readOutput(outputStream(child.stdout), Math.min(maxOutputBytes, DEFAULT_OUTPUT_BYTES), () => defaultKill(child, "SIGTERM"));
    const stderr = readOutput(outputStream(child.stderr), Math.min(maxOutputBytes, DEFAULT_OUTPUT_BYTES), () => defaultKill(child, "SIGTERM"));
      if (options.stdin !== undefined) {
        try {
          const input = child.stdin;
          if (!input || typeof input === "number") throw new Error("ssh stdin was not piped");
          await input.write(options.stdin);
          await input.end();
        } catch (error) {
          child.kill("SIGTERM");
          throw new SshRunnerError("spawn", "could not write ssh stdin", { cause: error });
        }
      }

      const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          defaultKill(child, "SIGTERM");
          reject(new SshRunnerError("timeout", `ssh command exceeded ${timeoutMs}ms`));
        }, timeoutMs);
      });
      try {
        const code = await Promise.race([child.exited, timeout]);
        const [out, err] = await Promise.all([stdout, stderr]);
        if (timedOut) throw new SshRunnerError("timeout", `ssh command exceeded ${timeoutMs}ms`);
        return { code, stdout: out, stderr: err };
      } catch (error) {
        if (error instanceof SshRunnerError) throw error;
        throw new SshRunnerError("spawn", "ssh command failed", { cause: error });
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        void Promise.allSettled([stdout, stderr, child.exited]);
      }
    },
    spawnTunnel,
  };

  function spawnTunnel(argv: readonly string[]): SshChild {
    return spawnChild(argv);
  }
}

export const SSH_OUTPUT_CAP_BYTES = DEFAULT_OUTPUT_BYTES;
