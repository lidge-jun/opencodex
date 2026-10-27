import { REQUIRED_TOOL_CONTRACT_CODE } from "../../lib/errors";
import { applyReplayRefusalClientHeaders, isNonReplayableResponse, markResponseNonReplayable } from "../../lib/upstream-retry";
import { clientWireOf } from "../inference/client-wire";
import { isPreinspectedJsonResponse, markPreinspectedJsonResponse } from "../relay";
import { isAuthorizedProviderExecutedCall } from "../responses-undeclared-tool-guard";
import { carryResponseToolOwnership, responseToolOwnership } from "./response-tool-ownership";

export type RequiredToolContract =
  | { kind: "any"; hostedCallTypes: ReadonlySet<string> }
  | { kind: "named"; name: string };

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
    || !(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  const requirement = requiredToolContractOf(rawBody);
  return requirement ? judgeBufferedRequiredTool(response, requirement) : response;
}
