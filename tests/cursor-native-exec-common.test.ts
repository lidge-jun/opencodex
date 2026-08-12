import { create, fromBinary } from "@bufbuild/protobuf";
import { describe, expect, test } from "bun:test";
import { execBytes } from "../src/adapters/cursor/native-exec-common";
import {
  AgentClientMessageSchema,
  DiagnosticsErrorSchema,
  DiagnosticsResultSchema,
  ExecServerMessageSchema,
  McpResultSchema,
  McpSuccessSchema,
  RequestContextSuccessSchema,
  RequestContextResultSchema,
  RequestContextSchema,
} from "../src/adapters/cursor/gen/agent_pb";

function execServerMessage(message: Parameters<typeof create<typeof ExecServerMessageSchema>>[1]["message"]) {
  return create(ExecServerMessageSchema, { id: 7, execId: "exec-test", message });
}

describe("execBytes serialization (TS 7 generic signature)", () => {
  test("mcpResult round-trips the typed value", () => {
    const bytes = execBytes(
      execServerMessage({ case: "mcpArgs", value: create(McpResultSchema, {}) }),
      "mcpResult",
      create(McpResultSchema, {
        result: { case: "success", value: create(McpSuccessSchema, { isError: false, content: [] }) },
      }),
    );

    const decoded = fromBinary(AgentClientMessageSchema, bytes);
    expect(decoded.message.case).toBe("execClientMessage");
    expect(decoded.message.value.message.case).toBe("mcpResult");
    expect(decoded.message.value.message.value.result.case).toBe("success");
  });

  test("requestContextResult round-trips the typed value", () => {
    const bytes = execBytes(
      execServerMessage({ case: "requestContextArgs", value: create(RequestContextResultSchema, {}) }),
      "requestContextResult",
      create(RequestContextResultSchema, {
        result: {
          case: "success",
          value: create(RequestContextSuccessSchema, {
            requestContext: create(RequestContextSchema, {
              tools: [{
                name: "fs_read",
                providerIdentifier: "opencodex",
                toolName: "fs_read",
                description: "read a file",
                inputSchema: new Uint8Array(),
              }],
            }),
          }),
        },
      }),
    );

    const decoded = fromBinary(AgentClientMessageSchema, bytes);
    expect(decoded.message.case).toBe("execClientMessage");
    expect(decoded.message.value.message.case).toBe("requestContextResult");
    expect(decoded.message.value.message.value.result.case).toBe("success");
    expect(decoded.message.value.message.value.result.value.requestContext.tools[0].name).toBe("fs_read");
  });

  test("diagnosticsResult round-trips an error result", () => {
    const bytes = execBytes(
      execServerMessage({ case: "diagnosticsArgs", value: create(DiagnosticsResultSchema, {}) }),
      "diagnosticsResult",
      create(DiagnosticsResultSchema, {
        result: {
          case: "error",
          value: create(DiagnosticsErrorSchema, { path: "/tmp/x", error: "unsupported" }),
        },
      }),
    );

    const decoded = fromBinary(AgentClientMessageSchema, bytes);
    expect(decoded.message.case).toBe("execClientMessage");
    expect(decoded.message.value.message.case).toBe("diagnosticsResult");
  });
});
