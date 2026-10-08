import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { fileURLToPath } from "node:url";
import type { AdapterRequest, ProviderAdapter } from "../base";
import { mapReasoningEffort } from "../../reasoning-effort";
import { buildSystemPrompt, MAX_TOOL_BLOCK_STARTS } from "../coding-agent/protocol";
import { buildCodingAgentToolCatalog, CodingAgentToolCatalogError } from "../coding-agent/tool-catalog";
import { baseScopedEnv, runCodingAgentTurn, type CodingAgentDeps, type CodingAgentToolBridgeInput } from "../coding-agent/turn";
import { QODER_PROFILES, type QoderProfile } from "./profiles";
import { QoderScaffoldFilter, QODER_SCAFFOLD_ERROR_CODE, qoderScaffoldErrorMessage } from "./scaffold-guard";

export type QoderAdapterDeps = CodingAgentDeps;

const QODER_MCP_SERVER_NAME = "opencodex";
const QODER_MCP_SERVER_PATH = fileURLToPath(new URL("../coding-agent/mcp-server.ts", import.meta.url));

export function buildQoderChildEnv(profile: QoderProfile, apiKey: string, systemPrompt?: string): Record<string, string> {
  const promptEnv = profile.region === "cn" ? "QODERCN_APPEND_SYSTEM_PROMPT" : "QODER_APPEND_SYSTEM_PROMPT";
  return { ...baseScopedEnv(), NO_COLOR: "1", [profile.tokenEnv]: apiKey,
    ...(systemPrompt ? { [promptEnv]: systemPrompt } : {}) };
}

/** Disable Qoder's built-in tools; only a request-scoped MCP catalog can be exposed. */
export function buildQoderArgs(parsed: OcxParsedRequest, provider: OcxProviderConfig): string[] {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--tools", "",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--max-turns", "1",
    "--no-session-persistence",
    "--model", parsed.modelId,
  ];
  const effort = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
  if (effort) args.push("--reasoning-effort", effort);
  return args;
}

/**
 * Wrap the turn's outbound channel with the scaffolding guard (#4190).
 *
 * The vendor CLI can put its own agent layer into the text channel despite built-in tools
 * being disabled, and the shared stream-json parser forwards a text delta
 * without inspecting it. This is the last point that is still qoder-specific, so the guard
 * sits here rather than in the parser every coding-agent CLI shares.
 *
 * A terminal event flushes both channels first. The held tail is text the filter could not
 * yet prove was not the start of a marker; dropping it would truncate a legitimate answer,
 * and swallowing an entire response before forwarding a "done" reads downstream as an empty
 * completion rather than as the refusal it is.
 */
export function guardQoderScaffolding(emit: (event: AdapterEvent) => void): (event: AdapterEvent) => void {
  const textFilter = new QoderScaffoldFilter();
  const thinkingFilter = new QoderScaffoldFilter();
  let closed = false;

  const refuse = (reason: string): void => {
    if (closed) return;
    closed = true;
    emit({
      type: "error",
      message: qoderScaffoldErrorMessage(reason),
      status: 502,
      errorType: "upstream_error",
      code: QODER_SCAFFOLD_ERROR_CODE,
      // Intermittent, but a silent retry spends the operator's vendor credits on a
      // contract violation the proxy cannot influence. Surface it instead.
      retryable: false,
    });
  };

  return (event: AdapterEvent): void => {
    if (closed) return;
    if (event.type === "text_delta") {
      const cleaned = textFilter.push(event.text);
      if (cleaned.text) emit({ ...event, text: cleaned.text });
      if (cleaned.fail) refuse(cleaned.fail);
      return;
    }
    if (event.type === "thinking_delta") {
      const cleaned = thinkingFilter.push(event.thinking);
      if (cleaned.text) emit({ ...event, thinking: cleaned.text });
      if (cleaned.fail) refuse(cleaned.fail);
      return;
    }
    if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      const tail = textFilter.flush();
      const reasoning = thinkingFilter.flush();
      if (tail.text) emit({ type: "text_delta", text: tail.text });
      if (reasoning.text) emit({ type: "thinking_delta", thinking: reasoning.text });
      const fail = tail.fail ?? reasoning.fail;
      // A vendor error already carries the better explanation for why the turn ended;
      // only a terminal that claims success is replaced.
      if (fail && event.type !== "error") {
        refuse(fail);
        return;
      }
      closed = true;
      emit(event);
      return;
    }
    emit(event);
  };
}

export function createQoderAdapter(provider: OcxProviderConfig, deps: QoderAdapterDeps = {}): ProviderAdapter {
  return {
    name: "qoder",
    buildRequest(): AdapterRequest {
      return { url: provider.baseUrl, method: "POST", headers: {}, body: "" };
    },
    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "Qoder adapter uses runTurn; the fetch/parseStream path is disabled." };
    },
    async runTurn(parsed, incoming, emit): Promise<void> {
      const hasImage = parsed.context.messages.some(message =>
        Array.isArray(message.content) && message.content.some(part => part.type === "image"),
      );
      if (hasImage) {
        emit({
          type: "error",
          message: "Qoder image input is not enabled because the CLI provider route has no verified multimodal contract.",
          status: 400,
          errorType: "invalid_request_error",
          code: "unsupported_input_modality",
          retryable: false,
        });
        return;
      }
      let catalog: ReturnType<typeof buildCodingAgentToolCatalog>;
      try {
        catalog = buildCodingAgentToolCatalog(parsed, QODER_MCP_SERVER_NAME);
      } catch (error) {
        if (!(error instanceof CodingAgentToolCatalogError)) throw error;
        emit({
          type: "error",
          message: "Invalid Qoder tool catalog.",
          status: 400,
          errorType: "invalid_request_error",
          code: "tool_catalog_invalid",
          retryable: false,
        });
        return;
      }
      const toolBridge: CodingAgentToolBridgeInput | undefined = catalog.tools.length > 0 || catalog.requireToolCall
        ? {
            serverName: QODER_MCP_SERVER_NAME,
            serverModulePath: QODER_MCP_SERVER_PATH,
            tools: catalog.tools,
            emittedNameMap: catalog.emittedNameMap,
            maxTurnToolCalls: MAX_TOOL_BLOCK_STARTS,
            projectHistoryToolNames: true,
            completeAssistantToolUse: true,
            toolTurnCompletionSignal: "assistant_tool_use_stop",
            allowedToolsFlag: "--allowed-tools",
            standaloneEntrypoint: "__qoder-mcp",
            requireToolCall: catalog.requireToolCall,
          }
        : undefined;
      // Keep the folded prompt out of argv and never inherit an ambient vendor prompt.
      const system = buildSystemPrompt(parsed);
      await runCodingAgentTurn({
          profiles: QODER_PROFILES,
          provider,
          parsed,
          incoming,
          emit: guardQoderScaffolding(emit),
          buildArgs: (_profile, req, prov) => buildQoderArgs(req, prov),
          buildEnv: (profile, apiKey) => buildQoderChildEnv(profile as QoderProfile, apiKey, system),
          deps,
          ...(toolBridge ? { toolBridge } : {}),
      });
    },
  };
}
