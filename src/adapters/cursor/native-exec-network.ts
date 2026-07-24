import { create } from "@bufbuild/protobuf";
import { FetchErrorSchema, FetchResultSchema, FetchSuccessSchema, type ExecServerMessage } from "./gen/agent_pb";
import { errorText, execBytes } from "./native-exec-common";

export interface CursorNativeNetworkDeps {
  fetch?: typeof fetch;
}

const NATIVE_FETCH_DISABLED =
  "Cursor-native fetch is disabled by OpenCodex policy for this request (not a Codex sandbox denial). Use the Codex shell bridge tool `shell_command` (aliases: `exec_command`, `mcp_opencodex-responses_shell_command`, `mcp_opencodex-responses_exec_command`) with curl or wget instead.";

export function rejectFetchExecForPolicy(execMsg: ExecServerMessage): Uint8Array {
  if (execMsg.message.case !== "fetchArgs") throw new Error("invalid fetch exec");
  const args = execMsg.message.value;
  return execBytes(execMsg, "fetchResult", create(FetchResultSchema, {
    result: { case: "error", value: create(FetchErrorSchema, { url: args.url, error: NATIVE_FETCH_DISABLED }) },
  }));
}

export async function fetchExec(execMsg: ExecServerMessage, deps: CursorNativeNetworkDeps = {}): Promise<Uint8Array> {
  if (execMsg.message.case !== "fetchArgs") throw new Error("invalid fetch exec");
  const args = execMsg.message.value;
  try {
    const fetchImpl = deps.fetch ?? fetch;
    const response = await fetchImpl(args.url);
    const content = await response.text();
    return execBytes(execMsg, "fetchResult", create(FetchResultSchema, {
      result: {
        case: "success",
        value: create(FetchSuccessSchema, {
          url: args.url,
          content,
          statusCode: response.status,
          contentType: response.headers.get("content-type") ?? "",
        }),
      },
    }));
  } catch (err) {
    return execBytes(execMsg, "fetchResult", create(FetchResultSchema, {
      result: { case: "error", value: create(FetchErrorSchema, { url: args.url, error: errorText(err) }) },
    }));
  }
}
