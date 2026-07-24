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
import { errorText, execBytes, execStreamCloseBytes } from "./native-exec-common";

const backgroundShells = new Map<number, { child: ChildProcessWithoutNullStreams; outputLength: number }>();
let nextShellId = 1;

const NATIVE_SHELL_DISABLED =
  "Cursor-native Shell is disabled by OpenCodex policy for this request (not a Codex sandbox denial). Use the Codex bridge shell tool from the current catalog — usually `shell_command` or `exec_command`, including the long MCP display name if that is what the list shows.";

function rejectedShellResult(command: string, cwd: string, started: number) {
  return create(ShellResultSchema, {
    result: {
      case: "failure",
      value: create(ShellFailureSchema, {
        command,
        workingDirectory: cwd,
        exitCode: 1,
        signal: "",
        stdout: "",
        stderr: NATIVE_SHELL_DISABLED,
        executionTime: Date.now() - started,
        aborted: true,
      }),
    },
  });
}

export function rejectShellExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "shellArgs") throw new Error("invalid shell exec");
  const args = execMsg.message.value;
  return execBytes(execMsg, "shellResult", rejectedShellResult(args.command, resolve(args.workingDirectory || process.cwd()), Date.now()));
}

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

export function rejectShellStreamExecForPolicy(execMsg: ExecServerMessage): Uint8Array[] {
  if (execMsg.message.case !== "shellStreamArgs") throw new Error("invalid shell stream exec");
  const args = execMsg.message.value;
  const cwd = resolve(args.workingDirectory || process.cwd());
  const started = Date.now();
  return [
    execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "start", value: create(ShellStreamStartSchema, { sandboxPolicy: args.requestedSandboxPolicy }) },
    })),
    execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "stderr", value: create(ShellStreamStderrSchema, { data: NATIVE_SHELL_DISABLED }) },
    })),
    execBytes(execMsg, "shellStream", create(ShellStreamSchema, {
      event: { case: "exit", value: create(ShellStreamExitSchema, { code: 1, cwd, aborted: true }) },
    })),
    execBytes(execMsg, "shellResult", rejectedShellResult(args.command, cwd, started)),
    execStreamCloseBytes(execMsg),
  ];
}

export async function shellStreamExec(execMsg: ExecServerMessage): Promise<Uint8Array[]> {
  if (execMsg.message.case !== "shellStreamArgs") throw new Error("invalid shell stream exec");
  const args = execMsg.message.value;
  const cwd = resolve(args.workingDirectory || process.cwd());
  const started = Date.now();
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
  // Cursor keeps the turn pending when it receives only stream deltas/exit: it requires the final
  // structured shellResult as completion acknowledgement, followed by an exec stream close. Without
  // these two frames the server-side agent waits forever (heartbeat-only stall → watchdog
  // upstream_stall_timeout → upstream 502). Mirrors jawcode handleShellStreamArgs.
  const shellResult = result.code === 0 && !result.aborted
    ? create(ShellResultSchema, {
        result: {
          case: "success",
          value: create(ShellSuccessSchema, {
            command: args.command,
            workingDirectory: cwd,
            exitCode: result.code,
            signal: "",
            stdout: result.stdout,
            stderr: result.stderr,
            executionTime: Date.now() - started,
          }),
        },
      })
    : create(ShellResultSchema, {
        result: {
          case: "failure",
          value: create(ShellFailureSchema, {
            command: args.command,
            workingDirectory: cwd,
            exitCode: result.code,
            signal: "",
            stdout: result.stdout,
            stderr: result.stderr,
            executionTime: Date.now() - started,
            aborted: result.aborted,
          }),
        },
      });
  replies.push(execBytes(execMsg, "shellResult", shellResult));
  replies.push(execStreamCloseBytes(execMsg));
  return replies;
}

export function rejectBackgroundShellSpawnExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "backgroundShellSpawnArgs") throw new Error("invalid background shell exec");
  const args = execMsg.message.value;
  const cwd = resolve(args.workingDirectory || process.cwd());
  return execBytes(execMsg, "backgroundShellSpawnResult", create(BackgroundShellSpawnResultSchema, {
    result: { case: "error", value: create(BackgroundShellSpawnErrorSchema, { command: args.command, workingDirectory: cwd, error: NATIVE_SHELL_DISABLED }) },
  }));
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

export function rejectWriteShellStdinExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "writeShellStdinArgs") throw new Error("invalid shell stdin exec");
  return execBytes(execMsg, "writeShellStdinResult", create(WriteShellStdinResultSchema, {
    result: { case: "error", value: create(WriteShellStdinErrorSchema, { error: NATIVE_SHELL_DISABLED }) },
  }));
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
