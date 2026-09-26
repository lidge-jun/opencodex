import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "./base";
import { openCodeFreeCompatibility } from "./opencode-free-compatibility";

export interface ProviderRequestContext {
  parsed?: OcxParsedRequest;
  incomingHeaders?: Headers;
  /** Stable lane for request paths that do not build an `OcxParsedRequest`. */
  requestSessionLane?: string;
}

export interface CompatibilityFunctionTool {
  name: string;
  /** Any one of these names satisfies the declaration. Defaults to `name`. */
  satisfiedBy?: readonly string[];
  description: string;
  parameters: Record<string, unknown>;
}

export interface ProviderRequestCompatibility {
  applies(provider: OcxProviderConfig): boolean;
  amendHeaders?(
    headers: Record<string, string>,
    provider: OcxProviderConfig,
    context: ProviderRequestContext,
  ): void;
  requiredFunctionTools?(provider: OcxProviderConfig): readonly CompatibilityFunctionTool[];
}

const PROVIDER_COMPATIBILITY: readonly ProviderRequestCompatibility[] = [
  openCodeFreeCompatibility,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function functionToolName(tool: unknown, chat: boolean): string | undefined {
  if (!isRecord(tool)) return undefined;
  const name = chat && isRecord(tool.function) ? tool.function.name : tool.name;
  return typeof name === "string" ? name : undefined;
}

function serializeFunctionTool(tool: CompatibilityFunctionTool, chat: boolean): Record<string, unknown> {
  const declaration = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
  return chat ? { type: "function", function: declaration } : { type: "function", ...declaration };
}

/** Apply provider-owned compatibility after the selected wire serializes its request. */
export function transformProviderRequest(
  provider: OcxProviderConfig,
  request: AdapterRequest,
  context: ProviderRequestContext = {},
): AdapterRequest {
  const profile = PROVIDER_COMPATIBILITY.find(candidate => candidate.applies(provider));
  if (!profile) return request;

  const headers = { ...request.headers };
  profile.amendHeaders?.(headers, provider, context);

  const required = profile.requiredFunctionTools?.(provider) ?? [];
  const chat = provider.adapter === "openai-chat";
  if (required.length === 0 || (!chat && provider.adapter !== "openai-responses")) {
    return { ...request, headers };
  }

  let body: unknown;
  try { body = JSON.parse(request.body); } catch { return { ...request, headers }; }
  if (!isRecord(body)) return { ...request, headers };

  const tools = Array.isArray(body.tools) ? body.tools : [];
  const names = new Set<string>();
  for (const tool of tools) {
    const name = functionToolName(tool, chat);
    if (name) names.add(name);
  }
  const missing = required.filter(tool => !(tool.satisfiedBy ?? [tool.name]).some(name => names.has(name)));
  if (missing.length === 0) return { ...request, headers };

  return {
    ...request,
    headers,
    body: JSON.stringify({ ...body, tools: [...tools, ...missing.map(tool => serializeFunctionTool(tool, chat))] }),
  };
}

/** Install the transform seam on adapters that use ordinary `buildRequest`. */
export function withProviderRequestCompatibility(
  adapter: ProviderAdapter,
  provider: OcxProviderConfig,
): ProviderAdapter {
  const buildRequest = adapter.buildRequest.bind(adapter);
  return {
    ...adapter,
    buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta) {
      const apply = (request: AdapterRequest) => transformProviderRequest(provider, request, {
        parsed,
        incomingHeaders: incoming?.headers,
      });
      const request = buildRequest(parsed, incoming);
      return request instanceof Promise ? request.then(apply) : apply(request);
    },
  };
}
