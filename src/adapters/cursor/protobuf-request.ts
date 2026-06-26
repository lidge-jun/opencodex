import { create, toBinary } from "@bufbuild/protobuf";
import type { CursorRunRequest } from "./types";
import { storeCursorBlob } from "./native-exec";
import {
  AgentClientMessageSchema,
  AgentRunRequestSchema,
  ConversationActionSchema,
  ConversationStateStructureSchema,
  ModelDetailsSchema,
  ResumeActionSchema,
  UserMessageActionSchema,
  UserMessageSchema,
} from "./gen/agent_pb";

const encoder = new TextEncoder();

function jsonBlob(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

function rootPromptMessages(request: CursorRunRequest): Uint8Array[] {
  // Each entry is a SHA-256 blob ID (not inline JSON); Cursor fetches the bytes back via getBlobArgs.
  const roots = request.system.length > 0
    ? request.system.map(content => storeCursorBlob(jsonBlob({ role: "system", content })))
    : [storeCursorBlob(jsonBlob({ role: "system", content: "You are a helpful assistant." }))];

  const prior = request.messages.slice(0, -1).map(message => storeCursorBlob(jsonBlob({
    role: message.role === "developer" ? "user" : message.role,
    content: [{ type: "text", text: message.content }],
  })));

  return [...roots, ...prior];
}

function lastUserText(request: CursorRunRequest): string {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i];
    if (message.role === "user" || message.role === "developer") return message.content;
  }
  return "";
}

export function encodeCursorRunRequest(request: CursorRunRequest): Uint8Array {
  const text = lastUserText(request);
  const action = create(ConversationActionSchema, {
    action: text.trim().length > 0
      ? {
          case: "userMessageAction",
          value: create(UserMessageActionSchema, {
            userMessage: create(UserMessageSchema, {
              text,
              messageId: crypto.randomUUID(),
            }),
          }),
        }
      : {
          case: "resumeAction",
          value: create(ResumeActionSchema, {}),
        },
  });

  const runRequest = create(AgentRunRequestSchema, {
    conversationId: request.conversationId,
    conversationState: create(ConversationStateStructureSchema, {
      rootPromptMessagesJson: rootPromptMessages(request),
      turns: [],
      todos: [],
      pendingToolCalls: [],
      previousWorkspaceUris: [],
      fileStates: {},
      fileStatesV2: {},
      summaryArchives: [],
      turnTimings: [],
      subagentStates: {},
      readPaths: [],
    }),
    action,
    modelDetails: create(ModelDetailsSchema, {
      modelId: request.modelId,
      displayModelId: request.modelId,
      displayName: request.modelId,
      displayNameShort: request.modelId,
      aliases: [],
    }),
  });

  const message = create(AgentClientMessageSchema, {
    message: { case: "runRequest", value: runRequest },
  });
  return toBinary(AgentClientMessageSchema, message);
}
