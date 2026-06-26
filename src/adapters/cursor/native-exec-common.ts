import { create, toBinary } from "@bufbuild/protobuf";
import {
  AgentClientMessageSchema,
  ExecClientMessageSchema,
  type ExecClientMessage,
  type ExecServerMessage,
} from "./gen/agent_pb";

export const textDecoder = new TextDecoder();
export const textEncoder = new TextEncoder();

export function clientBytes(message: Parameters<typeof create<typeof AgentClientMessageSchema>>[1]): Uint8Array {
  return toBinary(AgentClientMessageSchema, create(AgentClientMessageSchema, message));
}

export function execBytes(execMsg: ExecServerMessage, messageCase: ExecClientMessage["message"]["case"], value: unknown): Uint8Array {
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

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split(/\r\n|\r|\n/).length;
}
