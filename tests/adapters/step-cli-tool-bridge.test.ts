import { describe, expect, test } from "bun:test";

import {
  buildStepSdkTools,
  resolveStepToolName,
  StepToolCatalogError,
  STEP_CLI_TOOL_SERVER,
} from "../../src/adapters/step-cli/tool-bridge";
import type { OcxParsedRequest, OcxTool } from "../../src/types";

function tool(overrides: Partial<OcxTool> = {}): OcxTool {
  return {
    name: "shell",
    description: "Run a shell command",
    parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
    ...overrides,
  } as OcxTool;
}

function parsed(tools: OcxTool[], options: Record<string, unknown> = {}): OcxParsedRequest {
  return { modelId: "step-5-preview", context: { messages: [], tools }, options } as unknown as OcxParsedRequest;
}

describe("Step SDK tool bridge", () => {
  test("projects a client tool into an inline-schema sdkTool under the ocx namespace", () => {
    const { sdkTools, emittedNameMap } = buildStepSdkTools(parsed([tool()]));
    expect(sdkTools).toEqual([
      {
        serverName: STEP_CLI_TOOL_SERVER,
        toolName: "shell",
        description: "Run a shell command",
        inputSchema: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
      },
    ]);
    // StepCode names a declared tool `${serverName}__${toolName}`; the map is how a call it reports
    // back becomes the client's own name again.
    expect(emittedNameMap.get("ocx__shell")).toBe("shell");
  });

  test("recovers the client name from a namespaced wire name", () => {
    const { emittedNameMap } = buildStepSdkTools(parsed([tool({ name: "apply_patch" })]));
    expect(resolveStepToolName("ocx__apply_patch", emittedNameMap)).toBe("apply_patch");
  });

  test("returns undefined for a tool this proxy never declared", () => {
    const { emittedNameMap } = buildStepSdkTools(parsed([tool()]));
    // A StepCode built-in, a host MCP tool, or a name with no namespace: none may be forwarded,
    // because a call the client cannot satisfy is worse than a refused one.
    expect(resolveStepToolName("ocx__not_declared", emittedNameMap)).toBeUndefined();
    expect(resolveStepToolName("read_file", emittedNameMap)).toBeUndefined();
    expect(resolveStepToolName("", emittedNameMap)).toBeUndefined();
  });

  test("keeps a namespaced client tool distinct under its flattened wire name", () => {
    const namespaced = tool({ name: "read", namespace: "fs" });
    const { sdkTools, emittedNameMap } = buildStepSdkTools(parsed([namespaced]));
    expect(sdkTools[0]?.toolName).toBe("fs__read");
    expect(emittedNameMap.get("ocx__fs__read")).toBe("fs__read");
  });

  test("surfaces an invalid catalog as a tool-catalog error rather than a bare throw", () => {
    const invalid = tool({ name: "bad name" });
    expect(() => buildStepSdkTools(parsed([invalid]))).toThrow(StepToolCatalogError);
  });

  test("passes through a required-tool choice so the catalog is not silently widened", () => {
    const { requireToolCall } = buildStepSdkTools(parsed([tool()], { toolChoice: "required" }));
    expect(requireToolCall).toBe(true);
    const optional = buildStepSdkTools(parsed([tool()], { toolChoice: "auto" }));
    expect(optional.requireToolCall).toBe(false);
  });
});
