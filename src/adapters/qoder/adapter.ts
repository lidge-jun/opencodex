import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { fileURLToPath } from "node:url";
import type { AdapterRequest, ProviderAdapter } from "../base";
import { mapReasoningEffort } from "../../reasoning-effort";
import { buildSystemPrompt, MAX_TOOL_BLOCK_STARTS } from "../coding-agent/protocol";
import { buildCodingAgentToolCatalog, CodingAgentToolCatalogError } from "../coding-agent/tool-catalog";
import { baseScopedEnv, runCodingAgentTurn, type CodingAgentDeps, type CodingAgentToolBridgeInput, type CodingAgentFailure } from "../coding-agent/turn";
import { QODER_PROFILES, resolveQoderProfile, type QoderProfile } from "./profiles";
import { QoderScaffoldFilter, QODER_SCAFFOLD_ERROR_CODE, qoderScaffoldErrorMessage } from "./scaffold-guard";
import { ToolEnvelopeEchoFilter } from "../../lib/tool-envelope-echo-filter";
import { buildQoderConversationInput, qoderCnImageInputSupported } from "./image-input";

export type QoderAdapterDeps = CodingAgentDeps;

function classifyQoderFailure(failure: CodingAgentFailure): Extract<AdapterEvent, { type: "error" }> {
  const { error, profile } = failure;
  const auth = (): typeof error => ({
    ...error, status: 401, errorType: "authentication_error", code: "invalid_api_key",
    retryable: false, apiKeyRecovery: true,
  });
  if (failure.source === "process-exit") {
    return failure.exitCode === 41 || (failure.exitCode === 1
      && failure.stderr.includes("QoderAuthError")
      && !!profile.tokenEnv && failure.stderr.includes(profile.tokenEnv)
      && /token (?:that )?was rejected/i.test(failure.stderr))
      ? auth() : error;
  }
  const code = failure.frame.error_code;
  if (code === 105) return auth();
  if (code === 114) return {
    ...error, status: 403, errorType: "permission_error", code: "permission_denied", retryable: false,
  };
  if (typeof code === "number" && [110, 113, 115, 116, 117, 118, 119, 122].includes(code)) {
    return {
      ...error, status: 429, errorType: "insufficient_quota", code: "insufficient_quota", retryable: false,
      ...(code === 110 || code === 118 ? { apiKeyRecovery: true as const } : {}),
    };
  }
  if (typeof code === "number") return error;
  if (/daily usage limit|credit usage limit/i.test(error.message)) {
    const isAccountDaily = /^You've reached your daily usage limit for Chat\b/i.test(error.message.trim())
      && !/\b(?:team|model|shared)\b/i.test(error.message);
    return {
      ...error, status: 429, errorType: "insufficient_quota", code: "insufficient_quota",
      retryable: false,
      ...(isAccountDaily ? { apiKeyRecovery: true as const } : {}),
    };
  }
  if (/\binvalid (?:personal access )?token\b|\btoken (?:was |that was )?rejected\b|\bqoder authentication rejected\b/i.test(error.message)) return auth();
  return error;
}

const QODER_MCP_SERVER_NAME = "opencodex";
const QODER_MCP_SERVER_PATH = fileURLToPath(new URL("../coding-agent/mcp-server.ts", import.meta.url));
const MAX_PENDING_BOUNDARY_CHARS = 64 * 1024;
const MAX_PENDING_BOUNDARY_EVENTS = 1024;

export function buildQoderChildEnv(profile: QoderProfile, apiKey: string, systemPrompt?: string): Record<string, string> {
  // Each build reads its own brand prefix with no fallback: qodercn ignores QODER_EXPOSE_TOKEN_USAGE.
  const envPrefix = profile.region === "cn" ? "QODERCN_" : "QODER_";
  const promptEnv = `${envPrefix}APPEND_SYSTEM_PROMPT`;
  return { ...baseScopedEnv(), NO_COLOR: "1", [`${envPrefix}EXPOSE_TOKEN_USAGE`]: "true", [profile.tokenEnv]: apiKey,
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
 * Vendor-cleaned assistant text also uses the shared replay-envelope recognizer
 * (#7517), so internal history scaffolding cannot become a successful answer.
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
  let replayFilter = new ToolEnvelopeEchoFilter();
  let closed = false;
  let boundaries: { offset: number; event: AdapterEvent }[] = [];
  let boundaryChars = 0;
  let textCarry = "";

  const refuse = (reason: string): void => {
    if (closed) return;
    closed = true;
    boundaries = [];
    boundaryChars = 0;
    textCarry = "";
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

  const forwardText = (text: string, refuseOnMatch = true): void => {
    const safe = replayFilter.feed(text);
    // An overflowing fenced hold can release an unverified marker. Refuse it
    // before publication rather than leaking the envelope under a memory cap.
    if (replayFilter.unverifiedMarker) {
      if (refuseOnMatch) refuse("replayed tool envelope");
      return;
    }
    if (safe) emit({ type: "text_delta", text: safe });
    if (replayFilter.matched && refuseOnMatch) refuse("replayed tool envelope");
  };

  /*
   * Any other event ends the text block before it. Settle text the replay filter
   * still holds so the event cannot overtake it, and refuse before publishing the
   * event when that text completes an envelope. Heartbeats carry no content and
   * must not split a marker. The next text block starts at a line start, so an
   * envelope opening it is recognized even when the previous block ended mid-line.
   */
  const settleText = (refuseOnMatch = true): boolean => {
    const tail = replayFilter.finish();
    if (replayFilter.matched || replayFilter.unverifiedMarker) {
      if (refuseOnMatch) refuse("replayed tool envelope");
      return false;
    }
    if (tail) emit({ type: "text_delta", text: tail });
    replayFilter = new ToolEnvelopeEchoFilter();
    return true;
  };

  const forwardEvent = (event: AdapterEvent): void => {
    // A vendor prefix can still turn a replay marker into ordinary prose. Keep
    // its event cuts until the vendor filter resolves it instead of flushing it.
    const offset = textFilter.pendingTextLength + textCarry.length;
    if (offset > 0) {
      const size = event.type === "thinking_delta" ? event.thinking.length : JSON.stringify(event).length;
      if (boundaryChars + size > MAX_PENDING_BOUNDARY_CHARS
        || boundaries.length >= MAX_PENDING_BOUNDARY_EVENTS) {
        refuse("an unresolved text boundary exceeding its buffer limit");
        return;
      }
      boundaryChars += size;
      const last = boundaries.at(-1);
      if (last?.offset === offset
        && last.event.type === "thinking_delta" && event.type === "thinking_delta") {
        last.event = { type: "thinking_delta", thinking: last.event.thinking + event.thinking };
      } else boundaries.push({ offset, event });
      return;
    }
    if (settleText() && (event.type !== "thinking_delta" || event.thinking)) emit(event);
  };

  const drainBoundaries = (text: string, refuseOnMatch = true): void => {
    const queued = boundaries;
    boundaries = [];
    boundaryChars = 0;
    let at = 0;
    for (const boundary of queued) {
      // A suppressed prefix contributes no text; surviving prefixes keep their offsets.
      let end = text ? Math.min(text.length, Math.max(at, boundary.offset)) : 0;
      const before = text.charCodeAt(end - 1), after = text.charCodeAt(end);
      // A scalar completed by a later input belongs before events between its halves.
      if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end++;
      forwardText(text.slice(at, end), refuseOnMatch);
      if (closed || !settleText(refuseOnMatch)) return;
      if (boundary.event.type !== "thinking_delta" || boundary.event.thinking) emit(boundary.event);
      at = end;
    }
    if (!closed) forwardText(text.slice(at), refuseOnMatch);
  };

  const prepareText = (text: string, terminal = false): string => {
    let complete = textCarry + text;
    textCarry = "";
    const last = complete.charCodeAt(complete.length - 1);
    if (!terminal && last >= 0xd800 && last <= 0xdbff) {
      textCarry = complete.slice(-1);
      complete = complete.slice(0, -1);
    }
    return complete.toWellFormed();
  };

  const pushText = (text: string, refuseOnMatch = true): string | null => {
    let at = 0;
    while (boundaries.length && at < text.length) {
      const width = text.codePointAt(at)! > 0xffff ? 2 : 1;
      const cleaned = textFilter.push(text.slice(at, at + width));
      at += width;
      if (cleaned.fail) {
        if (refuseOnMatch) refuse(cleaned.fail);
        return cleaned.fail;
      }
      // A pending vendor suffix is one marker prefix, starting with its only
      // '<'. Its first release resolves the entire suffix and its saved cuts.
      if (cleaned.text || textFilter.pendingTextLength === 0) drainBoundaries(cleaned.text, refuseOnMatch);
      if (closed) return null;
    }
    const cleaned = textFilter.push(text.slice(at));
    if (cleaned.text) forwardText(cleaned.text, refuseOnMatch);
    if (cleaned.fail && refuseOnMatch) refuse(cleaned.fail);
    return cleaned.fail;
  };

  return (event: AdapterEvent): void => {
    if (closed) return;
    if (event.type === "text_delta") {
      if (event.text) pushText(prepareText(event.text));
      return;
    }
    if (event.type === "thinking_delta") {
      const cleaned = thinkingFilter.push(event.thinking);
      forwardEvent({ ...event, thinking: cleaned.text });
      if (cleaned.fail) refuse(cleaned.fail);
      return;
    }
    if (event.type === "done" || event.type === "error" || event.type === "incomplete") {
      const carryFailure = textCarry ? pushText(prepareText("", true), false) : null;
      const tail = textFilter.flush();
      const reasoning = thinkingFilter.flush();
      drainBoundaries(tail.text, false);
      if (closed) return;
      const replayTail = replayFilter.finish();
      if (replayTail && !replayFilter.unverifiedMarker) emit({ type: "text_delta", text: replayTail });
      if (reasoning.text && !replayFilter.matched && !replayFilter.unverifiedMarker) {
        emit({ type: "thinking_delta", thinking: reasoning.text });
      }
      const fail = carryFailure ?? tail.fail ?? reasoning.fail
        ?? (replayFilter.matched || replayFilter.unverifiedMarker ? "replayed tool envelope" : null);
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
    if (event.type === "heartbeat") emit(event);
    else forwardEvent(event);
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
      if (resolveQoderProfile(provider.baseUrl)?.region === "cn" && !qoderCnImageInputSupported(parsed)) {
        emit({
          type: "error", status: 400, errorType: "invalid_request_error",
          code: "unsupported_input_modality", retryable: false,
          message: "Qoder CN raw-image routing is verified only with qoderclicn 1.1.70, DeepSeek-Flash or Qwen3.8-Flash, and one base64 PNG in a single user turn on stream-json stdin. The PNG must be at most 1 MiB decoded, with each edge at most 8192 pixels and at most 16,000,000 total pixels. URL, multiple-image, tool-result and history replay surfaces remain unverified; use the vision sidecar for those inputs.",
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
          conversationInput: buildQoderConversationInput,
          classifyFailure: classifyQoderFailure,
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
