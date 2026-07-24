import { createHash } from "node:crypto";
import { sanitizeGeminiToolParameters } from "./google-tool-schema";

type JsonObject = Record<string, unknown>;

const GOOGLE_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const GOOGLE_THINKING_LEVELS = new Set(["minimal", "low", "medium", "high"]);

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toolNameCodec(names: readonly string[]): {
  toWire: (name: string) => string;
  fromWire: (name: string) => string;
} {
  const toWire = new Map<string, string>();
  const fromWire = new Map<string, string>();
  const used = new Set<string>();

  for (const name of names) {
    if (toWire.has(name)) continue;
    if (GOOGLE_TOOL_NAME.test(name) && !used.has(name)) {
      toWire.set(name, name);
      fromWire.set(name, name);
      used.add(name);
      continue;
    }

    let cleaned = name.replace(/[^A-Za-z0-9_-]/g, "_");
    if (!/^[A-Za-z_]/.test(cleaned)) cleaned = `_${cleaned}`;
    const prefix = (cleaned || "tool").slice(0, 55);
    for (let salt = 0; ; salt++) {
      const hashInput = salt === 0 ? name : `${name}#${salt}`;
      const suffix = createHash("sha256").update(hashInput).digest("hex").slice(0, 8);
      const candidate = `${prefix}_${suffix}`;
      if (used.has(candidate)) continue;
      toWire.set(name, candidate);
      fromWire.set(candidate, name);
      used.add(candidate);
      break;
    }
  }

  return {
    toWire: name => toWire.get(name) ?? name,
    fromWire: name => fromWire.get(name) ?? name,
  };
}

function collectToolNames(body: JsonObject): string[] {
  const names: string[] = [];
  if (Array.isArray(body.tools)) {
    for (const rawTool of body.tools) {
      if (!isObject(rawTool) || !Array.isArray(rawTool.functionDeclarations)) continue;
      for (const rawDeclaration of rawTool.functionDeclarations) {
        if (isObject(rawDeclaration) && typeof rawDeclaration.name === "string") names.push(rawDeclaration.name);
      }
    }
  }
  if (Array.isArray(body.contents)) {
    for (const rawContent of body.contents) {
      if (!isObject(rawContent) || !Array.isArray(rawContent.parts)) continue;
      for (const rawPart of rawContent.parts) {
        if (!isObject(rawPart)) continue;
        for (const key of ["functionCall", "functionResponse"]) {
          const call = rawPart[key];
          if (isObject(call) && typeof call.name === "string") names.push(call.name);
        }
      }
    }
  }
  return names;
}

function compileContents(value: unknown, toWireName: (name: string) => string): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(rawContent => {
    if (!isObject(rawContent)) return {};
    const content = { ...rawContent };
    if (!Array.isArray(rawContent.parts)) return content;
    content.parts = rawContent.parts.map(rawPart => {
      if (!isObject(rawPart)) return {};
      const part = { ...rawPart };
      for (const key of ["functionCall", "functionResponse"]) {
        const call = rawPart[key];
        if (isObject(call) && typeof call.name === "string") {
          part[key] = { ...call, name: toWireName(call.name) };
        }
      }
      return part;
    });
    return content;
  });
}

function compileTools(value: unknown, toWireName: (name: string) => string): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools = value.flatMap(rawTool => {
    if (!isObject(rawTool) || !Array.isArray(rawTool.functionDeclarations)) return [];
    const functionDeclarations = rawTool.functionDeclarations.flatMap(rawDeclaration => {
      if (!isObject(rawDeclaration) || typeof rawDeclaration.name !== "string") return [];
      return [{
        name: toWireName(rawDeclaration.name),
        ...(typeof rawDeclaration.description === "string" ? { description: rawDeclaration.description } : {}),
        parameters: sanitizeGeminiToolParameters(rawDeclaration.parameters),
      }];
    });
    return functionDeclarations.length > 0 ? [{ functionDeclarations }] : [];
  });
  return tools.length > 0 ? tools : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compileGenerationConfig(value: unknown): JsonObject | undefined {
  if (!isObject(value)) return undefined;
  const out: JsonObject = {};
  const maxOutputTokens = finiteNumber(value.maxOutputTokens);
  if (maxOutputTokens !== undefined && maxOutputTokens > 0) out.maxOutputTokens = Math.floor(maxOutputTokens);
  const temperature = finiteNumber(value.temperature);
  if (temperature !== undefined && temperature >= 0) out.temperature = Math.min(2, temperature);
  const topP = finiteNumber(value.topP);
  if (topP !== undefined && topP >= 0) out.topP = Math.min(1, topP);
  if (Array.isArray(value.stopSequences)) {
    const stopSequences = [...new Set(value.stopSequences.filter(
      (item): item is string => typeof item === "string" && item.length > 0,
    ))].slice(0, 5);
    if (stopSequences.length > 0) out.stopSequences = stopSequences;
  }
  if (isObject(value.thinkingConfig) && typeof value.thinkingConfig.thinkingLevel === "string") {
    const raw = value.thinkingConfig.thinkingLevel.toLowerCase();
    const thinkingLevel = GOOGLE_THINKING_LEVELS.has(raw)
      ? raw
      : (["xhigh", "max", "ultra"].includes(raw) ? "high" : undefined);
    if (thinkingLevel) out.thinkingConfig = { thinkingLevel };
  }
  if (Array.isArray(value.responseModalities)) {
    const valid = value.responseModalities.filter((m): m is string => typeof m === "string" && ["TEXT", "IMAGE", "AUDIO"].includes(m));
    if (valid.length > 0) out.responseModalities = valid;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function compileToolConfig(value: unknown, toWireName: (name: string) => string): JsonObject | undefined {
  if (!isObject(value) || !isObject(value.functionCallingConfig)) return undefined;
  const raw = value.functionCallingConfig;
  const out: JsonObject = {};
  if (typeof raw.mode === "string" && ["AUTO", "ANY", "NONE", "VALIDATED"].includes(raw.mode.toUpperCase())) {
    out.mode = raw.mode.toUpperCase();
  }
  if (Array.isArray(raw.allowedFunctionNames)) {
    const names = raw.allowedFunctionNames
      .filter((name): name is string => typeof name === "string")
      .map(toWireName);
    if (names.length > 0) out.allowedFunctionNames = names;
  }
  return Object.keys(out).length > 0 ? { functionCallingConfig: out } : undefined;
}

/**
 * Final trust boundary for every Google-family request. The adapter may build a convenient
 * Gemini-shaped object; only this compiler is allowed to decide what reaches the wire.
 */
export function compileGoogleWireBody(input: unknown): {
  body: JsonObject;
  restoreToolName: (name: string) => string;
} {
  const source = isObject(input) ? input : {};
  const names = toolNameCodec(collectToolNames(source));
  const body: JsonObject = {};
  const contents = compileContents(source.contents, names.toWire);
  if (contents) body.contents = contents;
  if (isObject(source.systemInstruction)) body.systemInstruction = source.systemInstruction;
  const tools = compileTools(source.tools, names.toWire);
  if (tools) body.tools = tools;
  const generationConfig = compileGenerationConfig(source.generationConfig);
  if (generationConfig) body.generationConfig = generationConfig;
  const toolConfig = compileToolConfig(source.toolConfig, names.toWire);
  if (toolConfig) body.toolConfig = toolConfig;
  if (typeof source.sessionId === "string" && source.sessionId.length > 0) body.sessionId = source.sessionId;
  return { body, restoreToolName: names.fromWire };
}

function functionDeclarations(root: JsonObject): JsonObject[] {
  if (!Array.isArray(root.tools)) return [];
  return root.tools.flatMap(rawTool => {
    if (!isObject(rawTool) || !Array.isArray(rawTool.functionDeclarations)) return [];
    return rawTool.functionDeclarations.filter(isObject);
  });
}

/** Build a changed request for one known-safe replay of an INVALID_ARGUMENT response. */
export function repairGoogleInvalidRequestBody(body: string, errorPayload: string): string | undefined {
  const schemaError = /(?:input[_ ]schema|json schema|function[_ ]declarations?|x-mcp-header)/i.test(errorPayload);
  const thinkingError = /thinking[_ ]?(?:config|level)/i.test(errorPayload);
  if (!schemaError && !thinkingError) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const root = isObject(parsed.request) ? parsed.request : parsed;
  let changed = false;

  if (thinkingError && isObject(root.generationConfig) && "thinkingConfig" in root.generationConfig) {
    delete root.generationConfig.thinkingConfig;
    if (Object.keys(root.generationConfig).length === 0) delete root.generationConfig;
    changed = true;
  }

  if (schemaError) {
    const declarations = functionDeclarations(root);
    if (declarations.length > 0) {
      const indexed = /tools(?:\.|\[)(\d+)(?:\])?\.custom\.input_schema/i.exec(errorPayload)?.[1]
        ?? /function[_]?declarations(?:\.|\[)(\d+)/i.exec(errorPayload)?.[1];
      const index = indexed === undefined ? -1 : Number.parseInt(indexed, 10);
      const rejected = declarations[index];
      const targets = rejected ? [rejected] : declarations;
      for (const declaration of targets) {
        declaration.parameters = { type: "object", properties: {} };
        delete declaration.parametersJsonSchema;
      }
      changed = true;
    }
  }
  return changed ? JSON.stringify(parsed) : undefined;
}
