import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  ComputerUseErrorSchema,
  ComputerUseResultSchema,
  DeleteErrorSchema,
  DeleteFileNotFoundSchema,
  DeleteResultSchema,
  DeleteSuccessSchema,
  DiagnosticsResultSchema,
  DiagnosticsSuccessSchema,
  ExecClientMessageSchema,
  FetchErrorSchema,
  FetchResultSchema,
  GetBlobResultSchema,
  GrepErrorSchema,
  GrepResultSchema,
  KvClientMessageSchema,
  ListMcpResourcesExecResultSchema,
  ListMcpResourcesSuccessSchema,
  LsDirectoryTreeNode_FileSchema,
  LsDirectoryTreeNodeSchema,
  LsErrorSchema,
  LsResultSchema,
  LsSuccessSchema,
  McpErrorSchema,
  McpResultSchema,
  ReadErrorSchema,
  ReadFileNotFoundSchema,
  ReadResultSchema,
  ReadSuccessSchema,
  RequestContextResultSchema,
  RequestContextSchema,
  RequestContextSuccessSchema,
  SetBlobResultSchema,
  ShellFailureSchema,
  ShellResultSchema,
  ShellSuccessSchema,
  WriteErrorSchema,
  WriteResultSchema,
  WriteSuccessSchema,
  type ExecClientMessage,
  type ExecServerMessage,
  type KvServerMessage,
} from "./gen/agent_pb";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();
const blobs = new Map<string, Uint8Array>();

function key(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function clientBytes(message: Parameters<typeof create<typeof AgentClientMessageSchema>>[1]): Uint8Array {
  return toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, message));
}

function execBytes(execMsg: ExecServerMessage, messageCase: ExecClientMessage["message"]["case"], value: unknown): Uint8Array {
  return clientBytes({
    message: {
      case: "execClientMessage",
      value: create(ExecClientMessageSchema, {
        id: execMsg.id,
        execId: execMsg.execId,
        message: { case: messageCase, value: value as never },
      }),
    },
  });
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}

function readExec(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "readArgs") throw new Error("invalid read exec");
  const path = resolve(execMsg.message.value.path);
  if (!existsSync(path)) {
    return execBytes(execMsg, "readResult", create(ReadResultSchema, {
      result: { case: "fileNotFound", value: create(ReadFileNotFoundSchema, { path }) },
    }));
  }
  try {
    const buf = readFileSync(path);
    const text = textDecoder.decode(buf);
    return execBytes(execMsg, "readResult", create(ReadResultSchema, {
      result: {
        case: "success",
        value: create(ReadSuccessSchema, {
          path,
          totalLines: lineCount(text),
          fileSize: BigInt(buf.length),
          truncated: false,
          output: { case: "content", value: text },
        }),
      },
    }));
  } catch (err) {
    return execBytes(execMsg, "readResult", create(ReadResultSchema, {
      result: { case: "error", value: create(ReadErrorSchema, { path, error: errorText(err) }) },
    }));
  }
}

function writeExec(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "writeArgs") throw new Error("invalid write exec");
  const args = execMsg.message.value;
  const path = resolve(args.path);
  try {
    mkdirSync(dirname(path), { recursive: true });
    const bytes = args.fileBytes && args.fileBytes.length > 0 ? args.fileBytes : textEncoder.encode(args.fileText ?? "");
    writeFileSync(path, bytes);
    const written = readFileSync(path, "utf8");
    return execBytes(execMsg, "writeResult", create(WriteResultSchema, {
      result: {
        case: "success",
        value: create(WriteSuccessSchema, {
          path,
          linesCreated: lineCount(written),
          fileSize: bytes.length,
          fileContentAfterWrite: args.returnFileContentAfterWrite ? written : undefined,
        }),
      },
    }));
  } catch (err) {
    return execBytes(execMsg, "writeResult", create(WriteResultSchema, {
      result: { case: "error", value: create(WriteErrorSchema, { path, error: errorText(err) }) },
    }));
  }
}

function deleteExec(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "deleteArgs") throw new Error("invalid delete exec");
  const path = resolve(execMsg.message.value.path);
  if (!existsSync(path)) {
    return execBytes(execMsg, "deleteResult", create(DeleteResultSchema, {
      result: { case: "fileNotFound", value: create(DeleteFileNotFoundSchema, { path }) },
    }));
  }
  try {
    const before = statSync(path);
    const prevContent = before.isFile() ? readFileSync(path, "utf8") : "";
    rmSync(path, { recursive: true, force: true });
    return execBytes(execMsg, "deleteResult", create(DeleteResultSchema, {
      result: {
        case: "success",
        value: create(DeleteSuccessSchema, {
          path,
          deletedFile: basename(path),
          fileSize: BigInt(before.size),
          prevContent,
        }),
      },
    }));
  } catch (err) {
    return execBytes(execMsg, "deleteResult", create(DeleteResultSchema, {
      result: { case: "error", value: create(DeleteErrorSchema, { path, error: errorText(err) }) },
    }));
  }
}

function lsExec(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "lsArgs") throw new Error("invalid ls exec");
  const path = resolve(execMsg.message.value.path);
  try {
    const entries = readdirSync(path, { withFileTypes: true }).slice(0, 200);
    const childrenDirs = entries.filter(e => e.isDirectory()).map(e => create(LsDirectoryTreeNodeSchema, {
      absPath: resolve(path, e.name),
      childrenDirs: [],
      childrenFiles: [],
      childrenWereProcessed: false,
      fullSubtreeExtensionCounts: {},
      numFiles: 0,
    }));
    const childrenFiles = entries.filter(e => e.isFile()).map(e => create(LsDirectoryTreeNode_FileSchema, { name: e.name }));
    return execBytes(execMsg, "lsResult", create(LsResultSchema, {
      result: {
        case: "success",
        value: create(LsSuccessSchema, {
          directoryTreeRoot: create(LsDirectoryTreeNodeSchema, {
            absPath: path,
            childrenDirs,
            childrenFiles,
            childrenWereProcessed: true,
            fullSubtreeExtensionCounts: Object.fromEntries(childrenFiles.map(f => [extname(f.name) || "(none)", 1])),
            numFiles: childrenFiles.length,
          }),
        }),
      },
    }));
  } catch (err) {
    return execBytes(execMsg, "lsResult", create(LsResultSchema, {
      result: { case: "error", value: create(LsErrorSchema, { path, error: errorText(err) }) },
    }));
  }
}

function shellExec(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "shellArgs" && execMsg.message.case !== "shellStreamArgs") throw new Error("invalid shell exec");
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
        value: create(ShellSuccessSchema, {
          command: args.command,
          workingDirectory: cwd,
          exitCode: code,
          signal: "",
          stdout,
          stderr,
          executionTime: elapsed,
        }),
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

function unsupportedExec(execMsg: ExecServerMessage, messageCase: ExecClientMessage["message"]["case"], value: unknown): Uint8Array {
  return execBytes(execMsg, messageCase, value);
}

export function handleCursorNativeExec(execMsg: ExecServerMessage): Uint8Array[] {
  const execCase = execMsg.message.case;
  if (execCase === "requestContextArgs") {
    return [execBytes(execMsg, "requestContextResult", create(RequestContextResultSchema, {
      result: { case: "success", value: create(RequestContextSuccessSchema, { requestContext: create(RequestContextSchema, {}) }) },
    }))];
  }
  if (execCase === "readArgs") return [readExec(execMsg)];
  if (execCase === "writeArgs") return [writeExec(execMsg)];
  if (execCase === "deleteArgs") return [deleteExec(execMsg)];
  if (execCase === "lsArgs") return [lsExec(execMsg)];
  if (execCase === "shellArgs" || execCase === "shellStreamArgs") return [shellExec(execMsg)];
  if (execCase === "diagnosticsArgs") {
    const path = resolve(execMsg.message.value.path);
    return [unsupportedExec(execMsg, "diagnosticsResult", create(DiagnosticsResultSchema, {
      result: { case: "success", value: create(DiagnosticsSuccessSchema, { path, diagnostics: [], totalDiagnostics: 0 }) },
    }))];
  }
  if (execCase === "grepArgs") {
    return [unsupportedExec(execMsg, "grepResult", create(GrepResultSchema, {
      result: { case: "error", value: create(GrepErrorSchema, { error: "Cursor grep exec is wired but not implemented in this opencodex build." }) },
    }))];
  }
  if (execCase === "mcpArgs") {
    return [unsupportedExec(execMsg, "mcpResult", create(McpResultSchema, {
      result: { case: "error", value: create(McpErrorSchema, { error: "No local MCP executor is configured inside opencodex." }) },
    }))];
  }
  if (execCase === "fetchArgs") {
    return [unsupportedExec(execMsg, "fetchResult", create(FetchResultSchema, {
      result: { case: "error", value: create(FetchErrorSchema, { url: execMsg.message.value.url, error: "Cursor fetch exec is not implemented in this build." }) },
    }))];
  }
  if (execCase === "listMcpResourcesExecArgs") {
    return [unsupportedExec(execMsg, "listMcpResourcesExecResult", create(ListMcpResourcesExecResultSchema, {
      result: { case: "success", value: create(ListMcpResourcesSuccessSchema, { resources: [] }) },
    }))];
  }
  if (execCase === "computerUseArgs") {
    return [unsupportedExec(execMsg, "computerUseResult", create(ComputerUseResultSchema, {
      result: { case: "error", value: create(ComputerUseErrorSchema, { error: "No local computer-use executor is configured inside opencodex.", actionCount: 0, durationMs: 0 }) },
    }))];
  }
  return [execBytes(execMsg, undefined, undefined)];
}

export function handleCursorNativeKv(kvMsg: KvServerMessage): Uint8Array {
  if (kvMsg.message.case === "getBlobArgs") {
    const blobData = blobs.get(key(kvMsg.message.value.blobId));
    return clientBytes({
      message: {
        case: "kvClientMessage",
        value: create(KvClientMessageSchema, {
          id: kvMsg.id,
          message: { case: "getBlobResult", value: create(GetBlobResultSchema, blobData ? { blobData } : {}) },
        }),
      },
    });
  }
  if (kvMsg.message.case === "setBlobArgs") {
    blobs.set(key(kvMsg.message.value.blobId), kvMsg.message.value.blobData);
    return clientBytes({
      message: {
        case: "kvClientMessage",
        value: create(KvClientMessageSchema, {
          id: kvMsg.id,
          message: { case: "setBlobResult", value: create(SetBlobResultSchema, {}) },
        }),
      },
    });
  }
  return clientBytes({ message: { case: "kvClientMessage", value: create(KvClientMessageSchema, { id: kvMsg.id }) } });
}
