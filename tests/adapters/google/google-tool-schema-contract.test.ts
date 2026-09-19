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
const ENDPOINT_CASES: Array<{
  endpointClass: GoogleToolSchemaEndpointClass;
  provider: OcxProviderConfig;
}> = [
  {
    endpointClass: "ai-studio",
    provider: {
      adapter: "google",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "test-key",
      googleMode: "ai-studio",
    } as OcxProviderConfig,
  },
  {
    endpointClass: "vertex",
    provider: {
      adapter: "google",
      baseUrl: "https://aiplatform.googleapis.com",
      apiKey: "test-key",
      googleMode: "vertex",
    } as OcxProviderConfig,
  },
  {
    endpointClass: "cloud-code-assist",
    provider: {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      apiKey: "test-token",
      googleMode: "cloud-code-assist",
      project: "test-project",
    } as OcxProviderConfig,
  },
];

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

function endpointRequestUncertain(): OcxParsedRequest {
  const values = Array.from({ length: 1_100 }, (_, index) => `value-${index}`);
  return {
    modelId: "gemini-test-model",
    stream: false,
    options: {},
    context: {
      messages: [{ role: "user", content: "use the tool", timestamp: 0 }],
      tools: [{
        name: "ENDPOINT_TOOL_CANARY_5112",
        description: "endpoint profile fixture",
        parameters: {
          type: "object",
          properties: {
            ENDPOINT_PROPERTY_CANARY_5112: {
              $ref: "#/$defs/Value",
              enum: [...values.slice(0, -1), "value-late-difference"],
            },
          },
          $defs: { Value: { type: "string", enum: [...values] } },
        },
      }],
    },
  } as unknown as OcxParsedRequest;
}

function endpointRequest(lossy: boolean): OcxParsedRequest {
  return {
    modelId: "gemini-test-model",
    stream: false,
    options: {
      textFormat: {
        type: "json_schema",
        schema: {
          type: "object",
          properties: { OUTPUT_SCHEMA_CANARY_5112: { type: "integer", minimum: 1 } },
        },
      },
    },
    context: {
      messages: [{ role: "user", content: "use the tool", timestamp: 0 }],
      tools: [{
        name: "ENDPOINT_TOOL_CANARY_5112",
        description: "endpoint profile fixture",
        parameters: {
          type: "object",
          properties: {
            ENDPOINT_PROPERTY_CANARY_5112: {
              type: "string",
              enum: lossy ? ["ENDPOINT_VALUE_CANARY_5112", 7] : ["ENDPOINT_VALUE_CANARY_5112"],
            },
          },
        },
      }],
    },
  } as OcxParsedRequest;
}

function stableWireBody(body: string, endpointClass: GoogleToolSchemaEndpointClass): string {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (endpointClass === "cloud-code-assist") parsed.requestId = "<generated-request-id>";
  return JSON.stringify(parsed);
}

function compiledRequest(body: string, endpointClass: GoogleToolSchemaEndpointClass): Record<string, unknown> {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  return endpointClass === "cloud-code-assist"
    ? parsed.request as Record<string, unknown>
    : parsed;
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
      uncertainComparisons: 0,
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

  test("reports when nullable anyOf resolution replaces an explicit sibling type", () => {
    const result = sanitize({
      type: "object",
      properties: {
        value: { type: "number", anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
    expect(result.parameters).toEqual({
      type: "object",
      properties: { value: { type: "string", nullable: true } },
    });
    expect(result.lossReport.categories).toEqual({ "union-sibling-replaced": 1 });
  });

  test("classifies type unions and unsupported type values", () => {
    const result = sanitize({
      type: "object",
      properties: {
        union: { type: ["string", "number"] },
        unknown: { type: "future-type" },
        empty: { type: [] },
        nullConflict: { type: ["string", "null"], nullable: false },
      },
    });
    expect(result.parameters).toEqual({
      type: "object",
      properties: {
        union: { type: "string" },
        unknown: {},
        empty: {},
        nullConflict: { type: "string", nullable: false },
      },
    });
    expect(result.lossReport.categories).toEqual({
      "type-union-collapsed": 1,
      "unsupported-type-widened": 2,
      "nullability-overridden": 1,
    });
  });

  test("classifies conditionals, tuple prefixes, and closed-list semantic constraints", () => {
    const result = sanitize({
      type: "object",
      properties: {
        conditional: {
          type: "string",
          if: { const: "a" },
          then: { minLength: 2 },
          else: { maxLength: 4 },
        },
        tuple: { type: "array", prefixItems: [{ type: "string" }] },
        patterned: { type: "string", pattern: "^[a-z]+$" },
      },
    });
    expect(result.lossReport.categories).toEqual({
      "conditional-dropped": 3,
      "tuple-prefix-dropped": 1,
      "unsupported-constraint-dropped": 1,
    });
  });

  test("does not classify inert annotations or lossless normalization as loss", () => {
    const result = sanitize({
      type: "object",
      title: "annotation",
      default: {},
      examples: [{}],
      $comment: "annotation",
      contentEncoding: "base64",
      contentMediaType: "application/json",
      readOnly: true,
      properties: {
        normalized: { type: "STRING", const: "fixed", enum: ["fixed", "fixed"] },
        constOnly: { type: "string", const: "fixed" },
        nullable: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
      required: ["normalized", "normalized"],
    });
    expect(result.lossReport).toEqual({
      version: 1,
      endpointClass: "ai-studio",
      lossy: false,
      truncated: false,
      uncertainComparisons: 0,
      categories: {},
    });
  });

  test("classifies root object coercion and malformed supported constraints", () => {
    const root = sanitize({ type: "string" });
    expect(root.parameters).toEqual({ type: "object", properties: {} });
    expect(root.lossReport.categories).toEqual({ "root-object-coerced": 1 });

    const malformed = sanitize({
      type: "object",
      properties: {
        value: { type: "string", enum: [], format: 7 },
      },
      required: "value",
    });
    expect(malformed.lossReport.categories).toEqual({
      "invalid-schema-widened": 2,
      "enum-constraint-dropped": 1,
    });
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

  test("counts a numeric const inside a local reference exactly once", () => {
    const result = sanitize({
      type: "object",
      properties: { value: { $ref: "#/$defs/NumericConst" } },
      $defs: { NumericConst: { type: "integer", const: 7 } },
    });
    expect(result.parameters).toEqual({
      type: "object",
      properties: { value: { type: "integer" } },
    });
    expect(result.lossReport.categories).toEqual({ "const-value-filtered": 1 });
  });

  test("reports when a reference sibling replaces a target constraint", () => {
    const result = sanitize({
      type: "object",
      properties: { value: { $ref: "#/$defs/Value", type: "number" } },
      $defs: { Value: { type: "string" } },
    });
    expect(result.parameters).toEqual({
      type: "object",
      properties: { value: { type: "number" } },
    });
    expect(result.lossReport.categories).toEqual({ "ref-overlay-replaced": 1 });
  });

  test("separately allocated equal ref overlays are not classified as loss", () => {
    const result = sanitize({
      type: "object",
      properties: {
        enumValue: { $ref: "#/$defs/EnumValue", enum: ["b", "a", "a"] },
        typeValue: { $ref: "#/$defs/TypeValue", type: "STRING" },
        objectValue: {
          $ref: "#/$defs/ObjectValue",
          properties: { name: { type: "string" } },
        },
        requiredValue: { $ref: "#/$defs/RequiredValue", required: ["other", "name", "name"] },
      },
      $defs: {
        EnumValue: { type: "string", enum: ["a", "b"] },
        TypeValue: { type: "string" },
        ObjectValue: { type: "object", properties: { name: { type: "string" } } },
        RequiredValue: {
          type: "object",
          properties: { name: { type: "string" }, other: { type: "string" } },
          required: ["name", "other"],
        },
      },
    });
    expect(result.lossReport).toEqual({
      version: 1,
      endpointClass: "ai-studio",
      lossy: false,
      truncated: false,
      uncertainComparisons: 0,
      categories: {},
    });
  });

  test.each([
    {
      name: "target filtering excluded by overlay",
      target: ["a", 1],
      overlay: ["a"],
      expectedEnum: ["a"],
      expectedCategories: {},
    },
    {
      name: "same filtered value in both schemas",
      target: ["a", 1],
      overlay: ["a", 1],
      expectedEnum: ["a"],
      expectedCategories: { "enum-value-filtered": 1 },
    },
    {
      name: "overlay-only filtered value",
      target: ["a"],
      overlay: ["a", 1],
      expectedEnum: ["a"],
      expectedCategories: {},
    },
    {
      name: "overlay widens beyond target",
      target: ["a"],
      overlay: ["a", "b"],
      expectedEnum: ["a", "b"],
      expectedCategories: { "ref-overlay-replaced": 1 },
    },
  ] as const)("enum ref overlay uses effective intersection: $name", ({ target, overlay, expectedEnum, expectedCategories }) => {
    const result = sanitize({
      type: "object",
      properties: { value: { $ref: "#/$defs/Value", enum: [...overlay] } },
      $defs: { Value: { enum: [...target] } },
    });
    const value = (result.parameters.properties as Record<string, Record<string, unknown>>).value;
    expect(value.enum).toEqual(expectedEnum);
    expect(result.lossReport.categories).toEqual(expectedCategories);
    expect(result.lossReport.uncertainComparisons).toBe(0);
  });

  test("a referenced enum without an overlay keeps its existing filtered-loss report", () => {
    const result = sanitize({
      type: "object",
      properties: { value: { $ref: "#/$defs/Value" } },
      $defs: { Value: { enum: ["a", 1] } },
    });
    const value = (result.parameters.properties as Record<string, Record<string, unknown>>).value;
    expect(value.enum).toEqual(["a"]);
    expect(result.lossReport.categories).toEqual({ "enum-value-filtered": 1 });
    expect(result.lossReport.uncertainComparisons).toBe(0);
  });

  test.each([
    [
      "enum",
      { type: "string", enum: ["a"] },
      { enum: ["b"] },
    ],
    [
      "properties",
      { type: "object", properties: { name: { type: "string" } } },
      { properties: { name: { type: "number" } } },
    ],
    [
      "required",
      {
        type: "object",
        properties: { name: { type: "string" }, other: { type: "string" } },
        required: ["name"],
      },
      { required: ["other"] },
    ],
  ] as const)("a genuinely different %s ref overlay reports exactly one loss", (_name, target, overlay) => {
    const result = sanitize({
      type: "object",
      properties: { value: { $ref: "#/$defs/Value", ...overlay } },
      $defs: { Value: target },
    });
    expect(result.lossReport.categories).toEqual({ "ref-overlay-replaced": 1 });
  });

  test("comparison budget exhaustion is unknown and is not counted as proven loss", () => {
    // The overlay differs only AFTER the bounded comparison budget: identical prefixes exhaust
    // the cap, so the late difference is indeterminate rather than proven loss.
    const values = Array.from({ length: 1_100 }, (_, index) => `value-${index}`);
    const overlayValues = [...values.slice(0, -1), "value-late-difference"];
    const result = sanitize({
      type: "object",
      properties: { value: { $ref: "#/$defs/Value", enum: [...overlayValues] } },
      $defs: { Value: { type: "string", enum: [...values] } },
    });
    expect(result.lossReport).toEqual({
      version: 1,
      endpointClass: "ai-studio",
      lossy: false,
      truncated: false,
      uncertainComparisons: 1,
      categories: {},
    });
    // Compatible mode keeps the overlay bytes, which genuinely differ from the target.
    // The stacked strict child must refuse uncertainty.
    const value = (result.parameters.properties as Record<string, Record<string, unknown>>).value;
    expect(value.enum).toEqual(overlayValues);
    expect(value.enum).not.toEqual(values);
    const compiled = compileGoogleWireBody({
      tools: [{ functionDeclarations: [{
        name: "uncertain_comparison",
        parameters: {
          type: "object",
          properties: { value: { $ref: "#/$defs/Value", enum: [...overlayValues] } },
          $defs: { Value: { type: "string", enum: [...values] } },
        },
      }] }],
    }, { endpointClass: "ai-studio" });
    expect(compiled.toolSchemaLossReport.uncertainComparisons).toBe(1);
    expect(compiled.toolSchemaLossReport.lossy).toBe(false);
    const declaration = (compiled.body.tools as Array<{
      functionDeclarations: Array<{ parameters: Record<string, unknown> }>;
    }>)[0]!.functionDeclarations[0]!;
    expect(declaration.parameters).toEqual(result.parameters);
  });

  test("default-equivalent constraints are neutral", () => {
    const result = sanitize({
      type: "object",
      additionalProperties: true,
      minProperties: 0,
      properties: {
        text: { type: "string", minLength: 0 },
        list: { type: "array", minItems: 0, uniqueItems: false, prefixItems: [] },
      },
    });
    expect(result.lossReport).toEqual({
      version: 1,
      endpointClass: "ai-studio",
      lossy: false,
      truncated: false,
      uncertainComparisons: 0,
      categories: {},
    });
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
      uncertainComparisons: 0,
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
      uncertainComparisons: 0,
      categories: {
        "unsupported-constraint-dropped": 1,
        "enum-value-filtered": 1,
        "recursive-ref-widened": 1,
      },
    });
  });

  test.each(ENDPOINT_CASES)("derives and consumes the $endpointClass profile at the adapter boundary", async ({ endpointClass, provider }) => {
    const adapter = createGoogleAdapter(provider);
    const realError = console.error;
    console.error = () => {};
    try {
      setDebugSettings({ debug: true });
      resetDebugLogBufferForTests();
      await adapter.buildRequest(endpointRequest(false));
      expect(getDebugLogEntries().some(entry => entry.line.includes("google-tool-schema-loss"))).toBe(false);

      resetDebugLogBufferForTests();
      setDebugSettings({ debug: false });
      const off = await adapter.buildRequest(endpointRequest(true));
      expect(getDebugLogEntries().some(entry => entry.line.includes("google-tool-schema-loss"))).toBe(false);

      setDebugSettings({ debug: true });
      const on = await adapter.buildRequest(endpointRequest(true));
      const lines = getDebugLogEntries().map(entry => entry.line)
        .filter(entry => entry.includes("google-tool-schema-loss"));
      expect(lines).toHaveLength(1);
      const line = lines[0]!;
      expect(stableWireBody(on.body, endpointClass)).toBe(stableWireBody(off.body, endpointClass));
      expect(on.url).toBe(off.url);
      expect(on.headers).toEqual(off.headers);
      for (const canary of [
        "ENDPOINT_TOOL_CANARY_5112",
        "ENDPOINT_PROPERTY_CANARY_5112",
        "ENDPOINT_VALUE_CANARY_5112",
        "OUTPUT_SCHEMA_CANARY_5112",
      ]) {
        expect(getDebugLogEntries().map(entry => entry.line).join("\n")).not.toContain(canary);
      }
      expect(line).toContain(`"endpointClass":"${endpointClass}"`);
      expect(line).toContain('"enum-value-filtered":1');

      const request = compiledRequest(on.body, endpointClass);
      const declarations = (request.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>)[0]!
        .functionDeclarations;
      expect(declarations[0]!.parameters).toEqual({
        type: "object",
        properties: {
          ENDPOINT_PROPERTY_CANARY_5112: {
            type: "string",
            enum: ["ENDPOINT_VALUE_CANARY_5112"],
          },
        },
      });
      const generationConfig = request.generationConfig as Record<string, unknown>;
      expect(generationConfig.responseMimeType).toBe("application/json");
      expect(generationConfig.responseJsonSchema).toEqual({
        type: "object",
        properties: { OUTPUT_SCHEMA_CANARY_5112: { type: "integer", minimum: 1 } },
      });
   } finally {
     console.error = realError;
   }
 });

  test.each(ENDPOINT_CASES)("report-only mode emits one content-free $endpointClass diagnostic for an indeterminate comparison", async ({ endpointClass, provider }) => {
    const adapter = createGoogleAdapter(provider);
    const realError = console.error;
    console.error = () => {};
    try {
      setDebugSettings({ debug: true });
      resetDebugLogBufferForTests();
      const built = await adapter.buildRequest(endpointRequestUncertain());
      const lines = getDebugLogEntries().map((entry) => entry.line)
        .filter((entry) => entry.includes("google-tool-schema-loss"));
      expect(lines).toHaveLength(1);
      expect(lines[0]!).toContain(`"uncertainComparisons":1`);
      expect(lines[0]!).toContain(`"lossy":false`);
      expect(lines[0]!).toContain(`"endpointClass":"` + `${endpointClass}` + `"`);
      expect(built.body).toBeDefined();
      for (const canary of [
        "ENDPOINT_TOOL_CANARY_5112",
        "ENDPOINT_PROPERTY_CANARY_5112",
        "value-late-difference",
      ]) {
        expect(getDebugLogEntries().map((entry) => entry.line).join("\n")).not.toContain(canary);
      }
    } finally {
      console.error = realError;
    }
  });
});
