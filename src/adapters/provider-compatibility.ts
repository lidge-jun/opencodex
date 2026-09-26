import type { OcxParsedRequest, OcxProviderConfig } from "../types";
import type { AdapterRequest } from "./base";
import { openCodeFreeCompatibility } from "./opencode-free-compatibility";

export interface ProviderRequestContext {
  /** Config key for the selected provider row. */
  providerId?: string;
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

export type CompatibilityFunctionCallRedirect = NonNullable<AdapterRequest["compatibilityFunctionCallRedirect"]>;

export interface ProviderCompatibilityProfile {
  applies(provider: OcxProviderConfig, context: ProviderRequestContext): boolean;
  amendHeaders?(
    headers: Record<string, string>,
    provider: OcxProviderConfig,
    context: ProviderRequestContext,
  ): void;
  requiredFunctionTools?(provider: OcxProviderConfig): readonly CompatibilityFunctionTool[];
  injectedFunctionCallGuidance?(name: string, callerNames: readonly string[]): string;
}

const PROVIDER_COMPATIBILITY: readonly ProviderCompatibilityProfile[] = [
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

function callerFunctionToolNames(body: Record<string, unknown>, chat: boolean): Set<string> {
  const names = new Set<string>();
  const visit = (specs: unknown) => {
    if (!Array.isArray(specs)) return;
    for (const tool of specs) {
      if (!chat && isRecord(tool) && tool.type === "namespace") {
        visit(tool.tools);
        continue;
      }
      const name = functionToolName(tool, chat);
      if (name) names.add(name);
    }
  };
  visit(body.tools);
  if (!chat && Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isRecord(item) && (item.type === "additional_tools" || item.type === "tool_search_output")) {
        visit(item.tools);
      }
    }
  }
  return names;
}

function serializeFunctionTool(tool: CompatibilityFunctionTool, chat: boolean): Record<string, unknown> {
  const declaration = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  };
  return chat ? { type: "function", function: declaration } : { type: "function", ...declaration };
}

/** Return required declarations not satisfied by any name already on the wire. */
export function missingCompatibilityFunctionTools(
  required: readonly CompatibilityFunctionTool[],
  names: Iterable<string> | undefined,
): readonly CompatibilityFunctionTool[] {
  const declared = new Set(names ?? []);
  return required.filter(tool =>
    !(tool.satisfiedBy ?? [tool.name]).some(name => declared.has(name))
  );
}

function matchingProfile(
  provider: OcxProviderConfig,
  context: ProviderRequestContext,
): ProviderCompatibilityProfile | undefined {
  return PROVIDER_COMPATIBILITY.find(candidate => candidate.applies(provider, context));
}

function callRedirect(
  profile: ProviderCompatibilityProfile,
  injected: readonly CompatibilityFunctionTool[],
  callerNames: readonly string[],
): CompatibilityFunctionCallRedirect | undefined {
  if (injected.length === 0 || !profile.injectedFunctionCallGuidance) return undefined;
  const guidance = profile.injectedFunctionCallGuidance;
  return {
    names: new Set(injected.map(tool => tool.name)),
    message: name => guidance(name, callerNames),
  };
}

/** Response policy for declarations this profile, rather than the caller, supplied. */
export function providerCompatibilityFunctionCallRedirect(
  provider: OcxProviderConfig,
  context: ProviderRequestContext,
  callerNames: Iterable<string>,
): CompatibilityFunctionCallRedirect | undefined {
  const profile = matchingProfile(provider, context);
  if (!profile) return undefined;
  const caller = [...callerNames];
  const injected = missingCompatibilityFunctionTools(profile.requiredFunctionTools?.(provider) ?? [], caller);
  return callRedirect(profile, injected, caller);
}

/** Apply provider-owned compatibility after the selected wire serializes its request. */
export function transformProviderRequest(
  provider: OcxProviderConfig,
  request: AdapterRequest,
  context: ProviderRequestContext = {},
): AdapterRequest {
  const profile = matchingProfile(provider, context);
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
  const callerNames = callerFunctionToolNames(body, chat);
  const missing = missingCompatibilityFunctionTools(required, callerNames);
  if (missing.length === 0) return { ...request, headers };
  const redirect = callRedirect(profile, missing, [...callerNames]);
  return {
    ...request,
    headers,
    body: JSON.stringify({ ...body, tools: [...tools, ...missing.map(tool => serializeFunctionTool(tool, chat))] }),
    ...(redirect ? { compatibilityFunctionCallRedirect: redirect } : {}),
  };
}
