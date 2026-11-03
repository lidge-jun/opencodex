import { REQUIRED_TOOL_CONTRACT_CODE } from "../../lib/errors";
import { mapToolChoice } from "../../responses/parser-tools";
import { modelInList, type OcxProviderConfig } from "../../types";
import { hasResponseMediaType } from "../../lib/http-response-semantics";
import { applyReplayRefusalClientHeaders, isNonReplayableResponse, markResponseNonReplayable } from "../../lib/upstream-retry";
import { clientWireOf } from "../inference/client-wire";
import { isPreinspectedJsonResponse, markPreinspectedJsonResponse } from "../relay";
import { isAuthorizedProviderExecutedCall } from "../responses-undeclared-tool-guard";
import { carryResponseToolOwnership, responseToolOwnership } from "./response-tool-ownership";

export type RequiredToolContract =
  | { kind: "any"; hostedCallTypes: ReadonlySet<string> }
  | { kind: "named"; name: string };

const allowedHostedSelectors = new Set([
  "web_search", "web_search_preview", "file_search", "computer_use_preview", "computer_use",
  "code_interpreter", "image_generation", "image_gen", "tool_search",
]);

function knownToolSelector(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.type === "mcp") return typeof entry.server_label === "string" && !!entry.server_label.trim()
    && (entry.name === undefined || entry.name === null || (typeof entry.name === "string" && !!entry.name.trim()));
  if (entry.name !== undefined && (typeof entry.name !== "string" || !entry.name.trim())) return false;
  if (entry.type === "function" || entry.type === "custom") return typeof entry.name === "string";
  return typeof entry.type === "string" && allowedHostedSelectors.has(entry.type);
}

/** Only definite, well-formed mandatory selectors justify excluding a destination. */
export function hasMandatoryToolChoice(rawBody: unknown): boolean {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return false;
  const choice = (rawBody as Record<string, unknown>).tool_choice;
  if (choice === "required") return true;
  if (!choice || typeof choice !== "object" || Array.isArray(choice)) return false;
  const selector = choice as Record<string, unknown>;
  // Eligibility is broader than terminal inspection: hosted selectors retain their own terminal owner.
  if (selector.type !== "allowed_tools") return knownToolSelector(selector);
  return selector.mode === "required"
    && Array.isArray(selector.tools) && selector.tools.length > 0
    && selector.tools.every(knownToolSelector);
}

/** A translated Chat target must not turn a mandatory selector into auto or none. */
export function chatCanPreserveMandatoryToolChoice(rawBody: unknown, provider: OcxProviderConfig, modelId: string): boolean {
  if (!hasMandatoryToolChoice(rawBody)) return true;
  if (modelInList(provider.autoToolChoiceOnlyModels, modelId)) return false;
  const mapped = mapToolChoice((rawBody as Record<string, unknown>).tool_choice);
  return mapped === "required" || (!!mapped && typeof mapped === "object");
}

const hostedCalls = new Map([
  ["web_search", "web_search_call"], ["web_search_preview", "web_search_call"],
  ["file_search", "file_search_call"], ["code_interpreter", "code_interpreter_call"],
  ["image_generation", "image_generation_call"], ["image_gen", "image_generation_call"],
  ["mcp", "mcp_call"], ["computer_use", "computer_call"],
  ["computer_use_preview", "computer_call"],
]);

/** Unknown declarations abstain: their successful output spelling is not ours to guess. */
export function requiredToolContractOf(rawBody: unknown): RequiredToolContract | undefined {
  if (!rawBody || typeof rawBody !== "object" || Array.isArray(rawBody)) return;
  const { tools, tool_choice: choice } = rawBody as Record<string, unknown>;
  if (!Array.isArray(tools) || tools.length === 0) return;
  if (choice === "required") {
    const hostedCallTypes = new Set<string>();
    for (const tool of tools) {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return;
      const type = (tool as Record<string, unknown>).type;
      if (type === "function" || type === "custom") continue;
      const callType = typeof type === "string" ? hostedCalls.get(type) : undefined;
      if (!callType) return;
      hostedCallTypes.add(callType);
    }
    return { kind: "any", hostedCallTypes };
  }
  if (choice && typeof choice === "object" && !Array.isArray(choice)) {
    const named = choice as Record<string, unknown>;
    if ((named.type === "function" || named.type === "custom")
      && typeof named.name === "string" && named.name.trim()) {
      return { kind: "named", name: named.name };
    }
  }
}

/** Only a parsed completed output array can prove a missing required call. */
export async function judgeBufferedRequiredTool(response: Response, requirement: RequiredToolContract): Promise<Response> {
  const text = await response.text();
  let payload: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
  } catch { /* An opaque body is not evidence of a required-tool violation. */ }
  const output = payload?.output;
  if (payload?.status === "completed" && Array.isArray(output)) {
    const calls = output.filter((item): item is Record<string, unknown> =>
      !!item && typeof item === "object" && !Array.isArray(item));
    const ownership = responseToolOwnership(response);
    const providerExecuted = (call: Record<string, unknown>) =>
      ownership !== undefined && isAuthorizedProviderExecutedCall(call, ownership);
    const satisfied = calls.some(call => {
      if (requirement.kind === "any" && requirement.hostedCallTypes.has(String(call.type))) return true;
      if (providerExecuted(call)) return false;
      if (call.type !== "function_call" && call.type !== "custom_tool_call") return false;
      // Name-less calls cannot prove a selected-name mismatch.
      return requirement.kind === "any" || typeof call.name !== "string" || call.name === requirement.name;
    });
    if (!satisfied) {
      const hostedEffect = calls.some(call => providerExecuted(call)
        || (typeof call.type === "string" && call.type.endsWith("_call")
          && call.type !== "function_call" && call.type !== "custom_tool_call"));
      const failure = Response.json({
        error: {
          type: "upstream_error", code: REQUIRED_TOOL_CONTRACT_CODE,
          message: "Target completed the response without the tool call required by tool_choice",
        },
        ...(payload.usage !== undefined ? { usage: payload.usage } : {}),
      }, { status: hostedEffect ? 400 : 502 });
      // Hosted/unknown call items can already have executed remotely. Report the violation,
      // but never buy another execution merely because the required client call is missing.
      if (hostedEffect) {
        markResponseNonReplayable(failure);
        applyReplayRefusalClientHeaders(failure.headers);
      }
      return failure;
    }
  }
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  const rebuilt = new Response(text, { status: response.status, statusText: response.statusText, headers });
  if (isPreinspectedJsonResponse(response)) markPreinspectedJsonResponse(rebuilt);
  return carryResponseToolOwnership(response, rebuilt);
}

/** Native buffered Responses only; translated Chat and runTurn retain their terminal owners. */
export async function guardBufferedComboRequiredTool(response: Response, rawBody: unknown, adapter?: string): Promise<Response> {
  if (!response.ok || adapter !== "openai-responses" || clientWireOf(response) !== undefined
    || isNonReplayableResponse(response)
    || !hasResponseMediaType(response.headers, "application/json")) return response;
  const requirement = requiredToolContractOf(rawBody);
  return requirement ? judgeBufferedRequiredTool(response, requirement) : response;
}
