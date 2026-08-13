export interface InertToolDefinition {
  name: string;
  kind: "function" | "custom";
  description?: string;
  parameters?: Record<string, unknown>;
}

export interface InertToolResult {
  output: string;
}

const LAB_TOOLS: Record<string, InertToolDefinition & { staticResult: InertToolResult }> = {
  lookup: {
    name: "lookup",
    kind: "function",
    description: "Lab inert lookup tool",
    parameters: {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    },
    staticResult: { output: "RESULT" },
  },
  apply_patch: {
    name: "apply_patch",
    kind: "custom",
    description: "Lab inert patch tool",
    staticResult: { output: "PATCHED" },
  },
};

export function listInertToolDefinitions(): InertToolDefinition[] {
  return Object.values(LAB_TOOLS).map(({ staticResult: _r, ...tool }) => tool);
}

export function validateInertToolArgs(name: string, args: unknown): void {
  const tool = LAB_TOOLS[name];
  if (!tool) throw new Error(`unknown inert tool: ${name}`);
  if (tool.kind === "function") {
    if (!args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("invalid function tool arguments");
    }
    const record = args as Record<string, unknown>;
    if (typeof record.q !== "string") {
      throw new Error("lookup requires string q");
    }
  }
}

/** Execute an inert lab tool — validate args and return static results only. */
export function executeInertTool(name: string, args: unknown): InertToolResult {
  validateInertToolArgs(name, args);
  const tool = LAB_TOOLS[name];
  if (!tool) throw new Error(`unknown inert tool: ${name}`);
  return { ...tool.staticResult };
}
