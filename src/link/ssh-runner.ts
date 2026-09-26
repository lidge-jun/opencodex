import { homedir } from "node:os";

const DEFAULT_OUTPUT_BYTES = 64 * 1024;
const HINT_MAX_CHARS = 160;
// Written as escapes on purpose: invisible and bidi controls must never sit literally in source.
const ANSI_SEQUENCE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]|\u001b[@-_]/g;
const HINT_CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g;
const HINT_SECRET = /\bocx_(data|admin|session|pair)_[A-Za-z0-9_-]+/g;
const HINT_URL_QUERY = /\b(https?:\/\/[^\s?#]*)[?#]\S*/g;

type SpawnEnv = Record<string, string | undefined>;

/**
 * PATH for ssh and ssh-keygen children on POSIX. A desktop sidecar inherits launchd's minimal
 * PATH, so a ProxyCommand helper installed by Homebrew or into ~/.bun/bin would not resolve.
 * Inherited entries keep their order and precedence; the common helper directories are appended
 * once. Windows keeps its inherited environment untouched and gets undefined.
 */
export function linkSshPath(env: SpawnEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "win32") return undefined;
  const home = env.HOME || homedir();
  const extra = ["/opt/homebrew/bin", "/usr/local/bin", ...(home ? [`${home}/.bun/bin`, `${home}/.local/bin`] : [])];
  return [...new Set([...(env.PATH ?? "").split(":").filter(Boolean), ...extra])].join(":");
}

/** The environment ssh runs with: the inherited one with `linkSshPath`, or undefined on Windows. */
export function linkSshSpawnEnv(env: SpawnEnv = process.env, platform: NodeJS.Platform = process.platform): SpawnEnv | undefined {
  const path = linkSshPath(env, platform);
  return path === undefined ? undefined : { ...env, PATH: path };
}

/**
 * One hint line as the dashboard may see it: control and bidi characters removed, OpenCodex
 * secrets and URL queries redacted, whitespace collapsed, capped at 160 code points. The cut is
 * made between code points, so an astral character is never split into a lone surrogate.
 */
export function boundHint(line: string): string | undefined {
  const clean = line.replace(HINT_CONTROL, " ").replace(HINT_SECRET, "ocx_$1_[redacted]")
    .replace(HINT_URL_QUERY, "$1").replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  const points = Array.from(clean);
  return points.length > HINT_MAX_CHARS ? `${points.slice(0, HINT_MAX_CHARS - 1).join("")}\u2026` : clean;
}

/**
 * A short reason for a failed ssh command: the last non-empty stderr line, with terminal escapes,
 * control and bidi characters removed, OpenCodex secrets and URL queries redacted, capped at 160
 * code points. It reads stderr only; stdout and stdin can carry keys. Callers return it to the
 * dashboard and never log it.
 */
export function sshFailureHint(stderr: string): string | undefined {
  const lines = stderr.replace(ANSI_SEQUENCE, "").split(/\r\n|\r|\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const hint = boundHint(lines[index]!);
    if (hint) return hint;
  }
  return undefined;
}

/** The runner's own failure (spawn, timeout, output limit) as a hint; other errors give none. */
export function sshRunnerErrorHint(error: unknown): string | undefined {
  return error instanceof SshRunnerError ? boundHint(error.message) : undefined;
}

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

export function createSshRunner(deps: { spawn?: typeof Bun.spawn; timeoutMs?: number; env?: () => SpawnEnv | undefined } = {}): SshRunner {
  const spawn = deps.spawn ?? ((argv, options) => Bun.spawn(argv, options));
  const defaultTimeoutMs = deps.timeoutMs ?? 30_000;
  // Read per spawn so a PATH change reaches the next command; Windows passes no env key at all.
  const spawnEnv = (): { env?: SpawnEnv } => {
    const env = (deps.env ?? (() => linkSshSpawnEnv()))();
    return env ? { env } : {};
  };

  const spawnChild = (argv: readonly string[]): SshChild => {
    let child: Bun.Subprocess;
    try {
      child = spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "pipe", ...spawnEnv() });
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
          ...spawnEnv(),
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
