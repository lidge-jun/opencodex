import type { AdapterEvent } from "../../types";
import { cursorExecResult } from "./exec-policy";
import type { CursorClientMessage, CursorServerMessage } from "./types";
import type { CursorKvStore } from "./kv-store";

export interface CursorMessageMapperState {
  kv: CursorKvStore;
  writeClient(message: CursorClientMessage): void;
}

export function mapCursorServerMessage(
  message: CursorServerMessage,
  state: CursorMessageMapperState,
): AdapterEvent[] {
  switch (message.type) {
    case "text":
      return [{ type: "text_delta", text: message.text }];
    case "thinking":
      return [{ type: "thinking_delta", thinking: message.thinking }];
    case "tool_call_start":
      return [{ type: "tool_call_start", id: message.id, name: message.name }];
    case "tool_call_delta":
      return [{ type: "tool_call_delta", arguments: message.arguments }];
    case "tool_call_end":
      return [{ type: "tool_call_end" }];
    case "done":
      return [{ type: "done", usage: message.usage }];
    case "error":
      return [{ type: "error", message: message.message }];
    case "kv_get":
      state.writeClient({ type: "kv_value", key: message.key, value: state.kv.get(message.key) });
      return [];
    case "kv_set":
      state.kv.set(message.key, message.value);
      state.writeClient({ type: "kv_stored", key: message.key });
      return [];
    case "exec":
      state.writeClient(cursorExecResult(message.requestId, message.execCase));
      return [];
  }
}
