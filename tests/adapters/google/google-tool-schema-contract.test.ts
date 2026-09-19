import { afterEach, describe, expect, test } from "bun:test";
import { createGoogleAdapter as createGoogleAdapterProduction } from "../../../src/adapters/google";
import {
  GOOGLE_TOOL_SCHEMA_LOSS_COUNT_LIMIT,
  sanitizeGeminiToolParametersWithReport,
  type GoogleToolSchemaEndpointClass,
} from "../../../src/adapters/google-tool-schema";
import { compileGoogleWireBody } from "../../../src/adapters/google-wire-compiler";
import { getDebugLogEntries, resetDebugLogBufferForTests } from "../../../src/lib/debug-log-buffer";
import { resetDebugSettingsForTests, setDebugSettings } from "../../../src/lib/debug-settings";
import type { OcxParsedRequest, OcxProviderConfig } from "../../../src/types";
import { withTestTranslatorBudget } from "../../helpers/translator-budget";

const createGoogleAdapter = (...args: Parameters<typeof createGoogleAdapterProduction>) =>
  withTestTranslatorBudget(createGoogleAdapterProduction(...args));

const ENDPOINTS: GoogleToolSchemaEndpointClass[] = ["ai-studio", "vertex", "cloud-code-assist"];

function sanitize(parameters: unknown, endpointClass: GoogleToolSchemaEndpointClass = "ai-studio") {
  return sanitizeGeminiToolParametersWithReport(parameters, { endpointClass });
}

function nestedObject(depth: number): Record<string, unknown> {
  let node: Record<string, unknown> = { type: "string" };
  for (let index = 0; index < depth; index++) {
    node = { type: "object", properties: { child: node } };
  }
  return node;
}

function dereferenceChain(length: number): Record<string, unknown> {
  const defs: Record<string, unknown> = {};
  for (let index = length - 1; index >= 0; index--) {
    defs[`Node${index}`] = index === length - 1
      ? { type: "string" }
      : { $ref: `#/$defs/Node${index + 1}` };
  }
  return {
    type: "object",
    properties: { value: { $ref: "#/$defs/Node0" } },
    $defs: defs,
  };
}

afterEach(() => {
  resetDebugSettingsForTests();
  resetDebugLogBufferForTests();
});

describe("Google tool-schema loss report", () => {
  test("uses an explicit endpoint profile without changing compatible wire bytes", () => {
    const input = {
      tools: [{ functionDeclarations: [{
        name: "calculate",
        parameters: {
          type: "object",
          properties: { amount: { type: "integer", enum: [1, 2, "other"] } },
        },
      }] }],
    };
    const compiled = ENDPOINTS.map(endpointClass => compileGoogleWireBody(input, { endpointClass }));
    const bytes = compiled.map(result => JSON.stringify(result.body));
    expect(new Set(bytes).size).toBe(1);
    expect(compiled.map(result => result.toolSchemaLossReport)).toEqual(ENDPOINTS.map(endpointClass => ({
      version: 1,
      endpointClass,
      lossy: true,
      truncated: false,
      categories: { "enum-value-filtered": 2 },
    })));
  });

  test("reports filtered enum members and dropped numeric and size bounds", () => {
    const result = sanitize({
      type: "object",
      properties: {
        amount: { type: "number", enum: [1, "fixed", 2], minimum: 0, exclusiveMaximum: 10 },
        label: { type: "string", minLength: 1, maxLength: 20 },
        list: { type: "array", minItems: 1, maxItems: 3, items: { type: "string" } },
      },
    });
    expect(result.parameters).toEqual({
      type: "object",
      properties: {
        amount: { type: "number", enum: ["fixed"] },
        label: { type: "string" },
        list: { type: "array", items: { type: "string" } },
      },
    });
    expect(result.lossReport.categories).toEqual({
      "numeric-bound-dropped": 2,
      "enum-value-filtered": 2,
      "size-bound-dropped": 4,
    });
  });

  test("reports a mixed union only when it widens the node", () => {
    const result = sanitize({
      type: "object",
      properties: { value: { anyOf: [{ type: "string" }, { type: "number" }] } },
    });
    expect(result.parameters).toEqual({
      type: "object",
      properties: { value: {} },
    });
    expect(result.lossReport.categories).toEqual({ "union-widened": 1 });
  });

  test("reports recursive-reference widening without losing an ordinary sibling", () => {
    const result = sanitize({
      type: "object",
      properties: { tree: { $ref: "#/$defs/Tree" } },
      $defs: {
        Tree: {
          type: "object",
          properties: {
            left: { $ref: "#/$defs/Tree" },
            label: { type: "string" },
          },
        },
      },
    });
    const tree = (result.parameters.properties as Record<string, Record<string, unknown>>).tree;
    expect(tree).toEqual({ type: "object", properties: { left: {}, label: { type: "string" } } });
    expect(result.lossReport.categories).toEqual({ "recursive-ref-widened": 1 });
  });

  test("reports depth and dereference ceilings at their existing boundaries", () => {
    const depth = sanitize(nestedObject(25));
    expect(depth.lossReport.categories).toEqual({ "depth-limit-widened": 1 });

    const dereference = sanitize(dereferenceChain(18));
    expect(dereference.lossReport.categories).toEqual({ "dereference-limit-widened": 1 });
  });

  test("reports node-budget widening without reading the first omitted property", () => {
    const properties = Object.fromEntries(Array.from(
      { length: 1_024 },
      (_, index) => [`field_${index}`, { type: "string" }],
    ));
    let readPastBudget = false;
    Object.defineProperty(properties, "field_1023", {
      enumerable: true,
      configurable: true,
      get() {
        readPastBudget = true;
        throw new Error("read past node budget");
      },
    });
    const result = sanitize({ type: "object", properties });
    expect(readPastBudget).toBe(false);
    expect(Object.keys(result.parameters.properties as object)).toHaveLength(1_023);
    expect(result.lossReport.categories).toEqual({ "node-budget-widened": 1 });
  });

  test("saturates aggregate category counts across declarations", () => {
    const declarations = Array.from({ length: GOOGLE_TOOL_SCHEMA_LOSS_COUNT_LIMIT + 2 }, (_, index) => ({
      name: `tool_${index}`,
      parameters: { type: "object", pattern: `value-${index}` },
    }));
    const compiled = compileGoogleWireBody(
      { tools: [{ functionDeclarations: declarations }] },
      { endpointClass: "vertex" },
    );
    expect(compiled.toolSchemaLossReport).toEqual({
      version: 1,
      endpointClass: "vertex",
      lossy: true,
      truncated: true,
      categories: { "unsupported-constraint-dropped": GOOGLE_TOOL_SCHEMA_LOSS_COUNT_LIMIT },
    });
  });

  test("preserves the current body and never treats native output schemas as tool input", () => {
    const outputCanary = "OUTPUT_SCHEMA_CANARY_5112";
    const compiled = compileGoogleWireBody({
      tools: [{ functionDeclarations: [{
        name: "lookup",
        parameters: { type: "object", properties: { count: { type: "integer", enum: [1, 2] } } },
      }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { [outputCanary]: { type: "integer", minimum: 1 } },
        },
      },
    }, { endpointClass: "ai-studio" });
    expect(JSON.stringify(compiled.body)).toBe(JSON.stringify({
      tools: [{ functionDeclarations: [{
        name: "lookup",
        parameters: { type: "object", properties: { count: { type: "integer" } } },
      }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: { [outputCanary]: { type: "integer", minimum: 1 } },
        },
      },
    }));
    expect(compiled.toolSchemaLossReport.categories).toEqual({ "enum-value-filtered": 2 });
  });

  test("retains no tool, property, description, enum, reference, or constraint value", () => {
    const canaries = {
      tool: "TOOL_CANARY_5112",
      property: "PROPERTY_CANARY_5112",
      description: "DESCRIPTION_CANARY_5112",
      enumValue: "ENUM_CANARY_5112",
      reference: "REFERENCE_CANARY_5112",
      constraint: "CONSTRAINT_CANARY_5112",
    };
    const compiled = compileGoogleWireBody({
      tools: [{ functionDeclarations: [{
        name: canaries.tool,
        description: canaries.description,
        parameters: {
          type: "object",
          properties: {
            [canaries.property]: {
              type: "string",
              description: canaries.description,
              enum: [canaries.enumValue, 7],
              pattern: canaries.constraint,
            },
            recursive: { $ref: `#/$defs/${canaries.reference}` },
          },
          $defs: {
            [canaries.reference]: {
              type: "object",
              properties: { next: { $ref: `#/$defs/${canaries.reference}` } },
            },
          },
        },
      }] }],
    }, { endpointClass: "cloud-code-assist" });
    const report = JSON.stringify(compiled.toolSchemaLossReport);
    for (const canary of Object.values(canaries)) expect(report).not.toContain(canary);
    expect(compiled.toolSchemaLossReport).toEqual({
      version: 1,
      endpointClass: "cloud-code-assist",
      lossy: true,
      truncated: false,
      categories: {
        "unsupported-constraint-dropped": 1,
        "enum-value-filtered": 1,
        "recursive-ref-widened": 1,
      },
    });
  });

  test("emits only the content-free report when provider diagnostics are enabled", async () => {
    const toolCanary = "DIAGNOSTIC_TOOL_CANARY_5112";
    const propertyCanary = "DIAGNOSTIC_PROPERTY_CANARY_5112";
    const valueCanary = "DIAGNOSTIC_VALUE_CANARY_5112";
    const adapter = createGoogleAdapter({
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      googleMode: "ai-studio",
    } as OcxProviderConfig);
    const request = {
      modelId: "test-model",
      stream: false,
      options: {},
      context: {
        messages: [{ role: "user", content: "use the tool" }],
        tools: [{
          name: toolCanary,
          description: "test",
          parameters: {
            type: "object",
            properties: { [propertyCanary]: { type: "string", enum: [valueCanary, 1] } },
          },
        }],
      },
    } as OcxParsedRequest;
    const realError = console.error;
    console.error = () => {};
    try {
      setDebugSettings({ debug: false });
      const off = await adapter.buildRequest(request);
      expect(getDebugLogEntries()).toEqual([]);

      setDebugSettings({ debug: true });
      const on = await adapter.buildRequest(request);
      const line = getDebugLogEntries().map(entry => entry.line)
        .find(entry => entry.includes("google-tool-schema-loss"));
      expect(line).toBeDefined();
      expect(on.body).toBe(off.body);
      expect(on.url).toBe(off.url);
      expect(on.headers).toEqual(off.headers);
      for (const canary of [toolCanary, propertyCanary, valueCanary]) {
        expect(line).not.toContain(canary);
      }
      expect(line).toContain('"endpointClass":"ai-studio"');
      expect(line).toContain('"enum-value-filtered":1');
    } finally {
      console.error = realError;
    }
  });
});
