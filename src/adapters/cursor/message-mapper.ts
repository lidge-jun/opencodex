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
      return [{ type: "error", message: message.message, ...(message.usage ? { usage: message.usage } : {}) }];
    case "heartbeat":
      // Liveness only: keeps the bridge's stall watchdog from tripping upstream_stall_timeout while
      // Cursor silently assembles (parallel) tool calls. The bridge resets stallTicks on any adapter
      // event and ignores unknown event types, so this emits no Responses protocol event.
      return [{ type: "heartbeat" }];
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
    case "local_side_effect":
      // Internal retry-safety signal only; keep the bridge alive without producing protocol output.
      return [{ type: "heartbeat" }];
  }
}
