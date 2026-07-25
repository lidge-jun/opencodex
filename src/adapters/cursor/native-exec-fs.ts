import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  DeleteErrorSchema,
  DeleteFileNotFoundSchema,
  DeleteRejectedSchema,
  DeleteResultSchema,
  DeleteSuccessSchema,
  GrepContentMatchSchema,
  GrepContentResultSchema,
  GrepCountResultSchema,
  GrepErrorSchema,
  GrepFileCountSchema,
  GrepFileMatchSchema,
  GrepFilesResultSchema,
  GrepResultSchema,
  GrepSuccessSchema,
  GrepUnionResultSchema,
  LsDirectoryTreeNode_FileSchema,
  LsDirectoryTreeNodeSchema,
  LsErrorSchema,
  LsResultSchema,
  LsSuccessSchema,
  ReadErrorSchema,
  ReadFileNotFoundSchema,
  ReadResultSchema,
  ReadSuccessSchema,
  WriteErrorSchema,
  WriteRejectedSchema,
  WriteResultSchema,
  WriteSuccessSchema,
  type ExecServerMessage,
  type GrepArgs,
} from "./gen/agent_pb";
import { errorText, execBytes, lineCount, textDecoder, textEncoder } from "./native-exec-common";

const MAX_GREP_FILES = 500;
const MAX_GREP_RESULTS = 200;
const MAX_FILE_BYTES = 1_000_000;

function codexNativeMutationRefusal(operation: "write" | "delete"): string {
  return `Cursor-native ${operation} is disabled for this Codex request because apply_patch is available. Use the apply_patch tool for file edits so Codex can approve the change, enforce sandbox policy, show diffs, and record rollout. No file was changed.`;
}

const NATIVE_LOCAL_EXEC_DISABLED =
  "Route filesystem work through the Codex Responses bridge shell tool (`shell_command` / `exec_command`, or the listed `mcp_opencodex-responses_*` display alias) with equivalent shell commands (cat, head, ls, rg, grep), or `apply_patch` for file edits. Do not tell the user shell or read access is blocked, disabled, or denied — silently call that bridge tool.";

export function rejectReadExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "readArgs") throw new Error("invalid read exec");
  const path = resolve(execMsg.message.value.path);
  return execBytes(execMsg, "readResult", create(ReadResultSchema, {
    result: { case: "error", value: create(ReadErrorSchema, { path, error: NATIVE_LOCAL_EXEC_DISABLED }) },
  }));
}

export function readExec(execMsg: ExecServerMessage): Uint8Array {
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

export function rejectWriteExecForApplyPatch(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "writeArgs") throw new Error("invalid write exec");
  const path = resolve(execMsg.message.value.path);
  return execBytes(execMsg, "writeResult", create(WriteResultSchema, {
    result: {
      case: "rejected",
      value: create(WriteRejectedSchema, { path, reason: codexNativeMutationRefusal("write") }),
    },
  }));
}

export function rejectWriteExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "writeArgs") throw new Error("invalid write exec");
  const path = resolve(execMsg.message.value.path);
  return execBytes(execMsg, "writeResult", create(WriteResultSchema, {
    result: {
      case: "rejected",
      value: create(WriteRejectedSchema, { path, reason: `${NATIVE_LOCAL_EXEC_DISABLED} No file was changed.` }),
    },
  }));
}

export function writeExec(execMsg: ExecServerMessage): Uint8Array {
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

export function rejectDeleteExecForApplyPatch(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "deleteArgs") throw new Error("invalid delete exec");
  const path = resolve(execMsg.message.value.path);
  return execBytes(execMsg, "deleteResult", create(DeleteResultSchema, {
    result: {
      case: "rejected",
      value: create(DeleteRejectedSchema, { path, reason: codexNativeMutationRefusal("delete") }),
    },
  }));
}

export function rejectDeleteExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "deleteArgs") throw new Error("invalid delete exec");
  const path = resolve(execMsg.message.value.path);
  return execBytes(execMsg, "deleteResult", create(DeleteResultSchema, {
    result: {
      case: "rejected",
      value: create(DeleteRejectedSchema, { path, reason: `${NATIVE_LOCAL_EXEC_DISABLED} No file was changed.` }),
    },
  }));
}

export function deleteExec(execMsg: ExecServerMessage): Uint8Array {
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

export function rejectLsExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "lsArgs") throw new Error("invalid ls exec");
  const path = resolve(execMsg.message.value.path);
  return execBytes(execMsg, "lsResult", create(LsResultSchema, {
    result: { case: "error", value: create(LsErrorSchema, { path, error: NATIVE_LOCAL_EXEC_DISABLED }) },
  }));
}

export function lsExec(execMsg: ExecServerMessage): Uint8Array {
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

function matchesGlob(file: string, glob?: string): boolean {
  if (!glob) return true;
  if (glob.startsWith("*.") || glob.startsWith("**/*.")) return file.endsWith(glob.slice(glob.indexOf("*") + 1));
  return file.includes(glob.replaceAll("*", ""));
}

function collectFiles(root: string, glob?: string, out: string[] = []): string[] {
  if (out.length >= MAX_GREP_FILES) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) collectFiles(path, glob, out);
    if (entry.isFile() && matchesGlob(path, glob)) out.push(path);
    if (out.length >= MAX_GREP_FILES) break;
  }
  return out;
}

function grepError(execMsg: ExecServerMessage, error: string): Uint8Array {
  return execBytes(execMsg, "grepResult", create(GrepResultSchema, {
    result: { case: "error", value: create(GrepErrorSchema, { error }) },
  }));
}

export function rejectGrepExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  return grepError(execMsg, NATIVE_LOCAL_EXEC_DISABLED);
}

export function grepExec(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "grepArgs") throw new Error("invalid grep exec");
  const args: GrepArgs = execMsg.message.value;
  const root = resolve(args.path || process.cwd());
  try {
    const pattern = new RegExp(args.pattern, args.caseInsensitive ? "i" : "");
    const files = existsSync(root) && statSync(root).isDirectory() ? collectFiles(root, args.glob) : [root];
    const matches = [];
    for (const file of files) {
      if (matches.length >= MAX_GREP_RESULTS) break;
      if (!existsSync(file) || statSync(file).size > MAX_FILE_BYTES) continue;
      const lines = readFileSync(file, "utf8").split(/\r\n|\r|\n/);
      const fileMatches = lines.flatMap((content, index) => pattern.test(content)
        ? [create(GrepContentMatchSchema, { lineNumber: index + 1, content, contentTruncated: false, isContextLine: false })]
        : []);
      if (fileMatches.length > 0) matches.push({ file, matches: fileMatches });
    }
    const outputMode = args.outputMode || "content";
    const result = outputMode === "count"
      ? create(GrepUnionResultSchema, {
        result: {
          case: "count",
          value: create(GrepCountResultSchema, {
            counts: matches.map(m => create(GrepFileCountSchema, { file: m.file, count: m.matches.length })),
            totalFiles: matches.length,
            totalMatches: matches.reduce((sum, m) => sum + m.matches.length, 0),
            clientTruncated: false,
            ripgrepTruncated: false,
          }),
        },
      })
      : outputMode === "files_with_matches"
        ? create(GrepUnionResultSchema, {
          result: {
            case: "files",
            value: create(GrepFilesResultSchema, {
              files: matches.map(m => m.file),
              totalFiles: matches.length,
              clientTruncated: false,
              ripgrepTruncated: false,
            }),
          },
        })
        : create(GrepUnionResultSchema, {
          result: {
            case: "content",
            value: create(GrepContentResultSchema, {
              matches: matches.map(m => create(GrepFileMatchSchema, { file: m.file, matches: m.matches })),
              totalLines: matches.reduce((sum, m) => sum + m.matches.length, 0),
              totalMatchedLines: matches.reduce((sum, m) => sum + m.matches.length, 0),
              clientTruncated: false,
              ripgrepTruncated: false,
            }),
          },
        });
    return execBytes(execMsg, "grepResult", create(GrepResultSchema, {
      result: {
        case: "success",
        value: create(GrepSuccessSchema, {
          pattern: args.pattern,
          path: root,
          outputMode,
          workspaceResults: { [relative(process.cwd(), root) || root]: result },
        }),
      },
    }));
  } catch (err) {
    return grepError(execMsg, errorText(err));
  }
}
