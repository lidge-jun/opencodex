import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";
import type { SpawnInvocation } from "../../lib/win-exec";
import { TRAE_WINDOWS_JOB_SOURCE } from "./windows-job-source";

/** Scoped env keys are uppercase; native CreateProcess does not search for lpApplicationName. */
function windowsEnv(env: Record<string, string>, name: string): string | undefined {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

/** Require an absolute native executable, resolving the cmd dispatcher from the scoped Windows env. */
export function traeWindowsJobExecutable(file: string, env: Record<string, string>): string {
  if (win32.isAbsolute(file)) return file;
  if (/^cmd(?:\.exe)?$/i.test(file)) {
    const comspec = windowsEnv(env, "ComSpec");
    if (comspec && win32.isAbsolute(comspec)) return comspec;
    return win32.join(windowsEnv(env, "SystemRoot") ?? "C:\\Windows", "System32", "cmd.exe");
  }
  throw Object.assign(new Error("Native TRAE CN supervision requires an absolute executable path."), { code: "ENOENT" });
}

/** Quote the native command line once; cmd/bat arguments already carry cmd escaping. */
export function traeWindowsCommandLine(invocation: SpawnInvocation): string {
  const quote = (value: string): string => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
  return quote(invocation.file) + " " + (invocation.options.windowsVerbatimArguments
    ? invocation.args.join(" ") : invocation.args.map(quote).join(" "));
}

/** Use a small encoded loader so the embedded source cannot exceed CreateProcess's argv limit. */
export async function prepareTraeWindowsJob(invocation: SpawnInvocation, home: string, cwd: string, joinMs: number,
  env: Record<string, string>): Promise<SpawnInvocation & { cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(home, "supervisor-"));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    invocation = { ...invocation, file: traeWindowsJobExecutable(invocation.file, env) };
    const source = join(directory, "TraeAcpJob.cs");
    await writeFile(source, TRAE_WINDOWS_JOB_SOURCE, { mode: 0o600 });
    const literal = (value: string): string => "'" + value.replaceAll("'", "''") + "'";
    const deadline = Math.max(1, Math.min(60_000, Math.floor(joinMs / 2)));
    const loader = [
      "$ErrorActionPreference='Stop';$entered=$false;try {",
      "Add-Type -TypeDefinition ([IO.File]::ReadAllText(" + literal(source) + ")) | Out-Null;",
      "$entered=$true;$code=[TraeAcpJob]::Run(" + [invocation.file, traeWindowsCommandLine(invocation), cwd].map(literal).join(",") + "," + deadline + ");exit $code",
      "} catch { [Console]::Error.WriteLine('OCX_TRAE_ERROR:loader:0');",
      "if (-not $entered) { [Console]::Error.WriteLine('OCX_TRAE_JOB_STOPPED') };exit 1 }",
    ].join("\n");
    return { file: win32.join(windowsEnv(env, "SystemRoot") ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(loader, "utf16le").toString("base64")],
      options: {}, cleanup };
  } catch (error) { await cleanup().catch(() => undefined); throw error; }
}

/** CLI stderr is encoded data, never supervisor control; storage stays bounded across split frames. */
export class TraeWindowsJobFrames {
  private line = "";
  private dropping = false;
  private invalid = false;
  private stopped = false;
  private readonly utf8 = new TextDecoder();
  constructor(private readonly stderr: (text: string) => void, private readonly error: (stage: string, code: number) => void) {}

  /** Frame ASCII supervisor records while dropping oversized or non-ASCII lines before interpretation. */
  push(chunk: Uint8Array): void {
    // Supervisor frames are ASCII. Decode the base64 payload's UTF-8 only after framing.
    for (const byte of chunk) {
      if (byte === 10) {
        if (!this.dropping) this.frame(this.line.replace(/\r$/, ""));
        this.line = "";
        this.dropping = false;
      } else if (!this.dropping) {
        if (this.line.length >= 4200 || byte > 127) {
          this.invalid = true;
          this.line = "";
          this.dropping = true;
        } else this.line += String.fromCharCode(byte);
      }
    }
  }

  /** Accept allowlisted control records and bounded base64 stderr; reject every other frame. */
  private frame(line: string): void {
    if (line === "OCX_TRAE_JOB_STOPPED") { this.stopped = true; return; }
    const diagnostic = /^OCX_TRAE_STDERR:([A-Za-z0-9+/]+={0,2})$/.exec(line);
    if (diagnostic && diagnostic[1]!.length % 4 === 0 && diagnostic[1]!.length <= 4096) {
      this.stderr(this.utf8.decode(Buffer.from(diagnostic[1]!, "base64"), { stream: true }));
      return;
    }
    const failure = /^OCX_TRAE_ERROR:(setup|create|resume|transport|loader):(\d{1,10})$/.exec(line);
    if (failure) { this.error(failure[1]!, Number(failure[2])); return; }
    this.invalid = true;
  }

  /** Flush stderr decoding and reject a partial or previously dropped final control record. */
  finish(): void {
    if (this.line.length || this.dropping) this.invalid = true;
    this.stderr(this.utf8.decode());
  }

  get processTreeExited(): boolean { return this.stopped && !this.invalid; }
}
