import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  BackgroundShellSpawnErrorSchema,
  BackgroundShellSpawnResultSchema,
  BackgroundShellSpawnSuccessSchema,
  ShellFailureSchema,
  ShellResultSchema,
  ShellStreamExitSchema,
  ShellStreamSchema,
  ShellStreamStartSchema,
  ShellStreamStderrSchema,
  ShellStreamStdoutSchema,
  ShellSuccessSchema,
  WriteShellStdinErrorSchema,
  WriteShellStdinResultSchema,
  WriteShellStdinSuccessSchema,
  type ExecServerMessage,
} from "./gen/agent_pb";
import { errorText, execBytes } from "./native-exec-common";

const backgroundShells = new Map<number, { child: ChildProcessWithoutNullStreams; outputLength: number }>();
let nextShellId = 1;

export function shellExec(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "shellArgs") throw new Error("invalid shell exec");
  const args = execMsg.message.value;
  const cwd = resolve(args.workingDirectory || process.cwd());
  const started = Date.now();
  const result = spawnSync(args.command, { cwd, shell: true, encoding: "utf8", timeout: args.hardTimeout || 120_000 });
  const elapsed = Date.now() - started;
  const stdout = String(result.stdout ?? "");
  const stderr = String(result.stderr ?? "");
  const code = typeof result.status === "number" ? result.status : 1;
  if (code === 0) {
    return execBytes(execMsg, "shellResult", create(ShellResultSchema, {
      result: {
        case: "success",
        value: create(ShellSuccessSchema, { command: args.command, workingDirectory: cwd, exitCode: code, signal: "", stdout, stderr, executionTime: elapsed }),
      },
    }));
  }
  return execBytes(execMsg, "shellResult", create(ShellResultSchema, {
    result: {
      case: "failure",
      value: create(ShellFailureSchema, {
        command: args.command,
        workingDirectory: cwd,
        exitCode: code,
        signal: String(result.signal ?? ""),
        stdout,
        stderr,
        executionTime: elapsed,
        aborted: !!result.error,
      }),
    },
  }));
}

export async function shellStreamExec(execMsg: ExecServerMessage): Promise<Uint8Array[]> {
  if (execMsg.message.case !== "shellStreamArgs") throw new Error("invalid shell stream exec");
  const args = execMsg.message.value;
  const cwd = resolve(args.workingDirectory || process.cwd());
  const replies = [
    execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "start", value: create(ShellStreamStartSchema, { sandboxPolicy: args.requestedSandboxPolicy }) },
    })),
  ];
  const result = await new Promise<{ stdout: string; stderr: string; code: number; aborted: boolean }>(resolvePromise => {
    const child = spawn(args.command, { cwd, shell: true });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const timeout = setTimeout(() => {
      aborted = true;
      child.kill();
    }, args.hardTimeout || 120_000);
    child.stdout.on("data", chunk => {
      stdout += String(chunk);
    });
    child.stderr.on("data", chunk => {
      stderr += String(chunk);
    });
    child.on("close", code => {
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr, code: code ?? 1, aborted });
    });
    child.on("error", err => {
      clearTimeout(timeout);
      resolvePromise({ stdout, stderr: stderr + errorText(err), code: 1, aborted });
    });
  });
  if (result.stdout) {
    replies.push(execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "stdout", value: create(ShellStreamStdoutSchema, { data: result.stdout }) },
    })));
  }
  if (result.stderr) {
    replies.push(execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "stderr", value: create(ShellStreamStderrSchema, { data: result.stderr }) },
    })));
  }
  replies.push(execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
    event: { case: "exit", value: create(ShellStreamExitSchema, { code: result.code, cwd, aborted: result.aborted }) },
  })));
  return replies;
}

export function backgroundShellSpawnExec(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "backgroundShellSpawnArgs") throw new Error("invalid background shell exec");
  const args = execMsg.message.value;
  const cwd = resolve(args.workingDirectory || process.cwd());
  try {
    const child = spawn(args.command, { cwd, shell: true });
    const shellId = nextShellId++;
    backgroundShells.set(shellId, { child, outputLength: 0 });
    child.stdout.on("data", chunk => {
      const shell = backgroundShells.get(shellId);
      if (shell) shell.outputLength += Buffer.byteLength(String(chunk));
    });
    child.stderr.on("data", chunk => {
      const shell = backgroundShells.get(shellId);
      if (shell) shell.outputLength += Buffer.byteLength(String(chunk));
    });
    child.on("close", () => backgroundShells.delete(shellId));
    return execBytes(execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, {
      result: {
        case: "success",
        value: create(BackgroundShellSpawnSuccessSchema, { shellId, command: args.command, workingDirectory: cwd, pid: child.pid }),
      },
    }));
  } catch (err) {
    return execBytes(execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, {
      result: { case: "error", value: create(BackgroundShellSpawnErrorSchema, { command: args.command, workingDirectory: cwd, error: errorText(err) }) },
    }));
  }
}

export function writeShellStdinExec(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "writeShellStdinArgs") throw new Error("invalid shell stdin exec");
  const args = execMsg.message.value;
  const shell = backgroundShells.get(args.shellId);
  if (!shell) {
    return execBytes(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, {
      result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: `Unknown shell id ${args.shellId}` }) },
    }));
  }
  const before = shell.outputLength;
  shell.child.stdin.write(args.chars);
  return execBytes(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, {
    result: { case: "success", value: create(WriteShellStdinSuccessSchema, { shellId: args.shellId, terminalFileLengthBeforeInputWritten: before }) },
  }));
}
