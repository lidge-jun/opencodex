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
import { isTranslatorBudgetExceededError } from "../../lib/translator-budget";
import { buildQoderConversationInput, qoderCnImageInputSupported } from "./image-input";

export type QoderAdapterDeps = CodingAgentDeps;

type QoderErrorEvent = Extract<AdapterEvent, { type: "error" }>;
export type QoderRecoverableNoticeReason = "auth" | "daily_limit" | "personal_credits" | "cn_pricing_url";

function hasExplicitErrorCode(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false;
  if (typeof raw === "string") return raw.trim().length > 0;
  return true;
}

// qodercli 1.1.91 may serialize numeric vendor error_code values as strings (e.g. "110", "114").
function parseQoderErrorCode(raw: unknown): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      if (Number.isSafeInteger(parsed)) return parsed;
    }
  }
  return undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const CN_REMOTE_CHAT_403_RE = /^inference\.remoteChat\.stream failed \(403\):\s*(\{[\s\S]*\})$/;
const EMBEDDED_ERROR_CODE_KEYS = [
  "code", "error_code", "errorCode", "err_code", "errCode", "biz_code", "bizCode", "statusCode", "status_code", "status",
] as const;

function hasEmbeddedNon403ErrorCode(record: Record<string, unknown>): boolean {
  for (const key of EMBEDDED_ERROR_CODE_KEYS) {
    const value = record[key];
    if (hasExplicitErrorCode(value) && parseQoderErrorCode(value) !== 403) return true;
  }
  return false;
}

function isCnPricingUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:"
    && url.hostname === "qoder.com.cn"
    && url.port === ""
    && url.username === ""
    && url.password === ""
    && url.pathname === "/pricing";
}

// qoder-cn surfaces account-level resource-pack exhaustion as a 403 remoteChat stream failure
// whose JSON response body carries the exact CN /pricing URL and no non-403 vendor error code.
// Parse that exact 403 JSON payload so embedded business codes (e.g. 114), wrong paths
// (/pricing-policy), or unrelated text never trigger key recovery.
function isCnQuotaPricingFailure(message: string): boolean {
  const match = CN_REMOTE_CHAT_403_RE.exec(message.trim());
  if (!match) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(match[1]!);
  } catch {
    return false;
  }
  if (!isPlainRecord(payload)) return false;
  if (hasEmbeddedNon403ErrorCode(payload)) return false;
  if (isPlainRecord(payload.error) && hasEmbeddedNon403ErrorCode(payload.error)) return false;
  if (isPlainRecord(payload.data) && hasEmbeddedNon403ErrorCode(payload.data)) return false;
  return isCnPricingUrl(payload.pricingUrl);
}

function classifyQoderFailure(
  failure: CodingAgentFailure,
  recordReason?: (reason: QoderRecoverableNoticeReason | undefined) => void,
): QoderErrorEvent {
  recordReason?.(undefined);
  const { error, profile } = failure;
  const auth = (noticeReason?: QoderRecoverableNoticeReason): QoderErrorEvent => {
    if (noticeReason) recordReason?.(noticeReason);
    return {
      ...error, status: 401, errorType: "authentication_error", code: "invalid_api_key",
      retryable: false, apiKeyRecovery: true,
    };
  };
  if (failure.source === "process-exit") {
    return failure.exitCode === 41 || (failure.exitCode === 1
      && failure.stderr.includes("QoderAuthError")
      && !!profile.tokenEnv && failure.stderr.includes(profile.tokenEnv)
      && /token (?:that )?was rejected/i.test(failure.stderr))
      ? auth() : error;
  }
  const rawCode = failure.frame.error_code;
  const explicitErrorCode = hasExplicitErrorCode(rawCode);
  const code = parseQoderErrorCode(rawCode);
  if (code === 105) return auth("auth");
  if (code === 114) return {
    ...error, status: 403, errorType: "permission_error", code: "permission_denied", retryable: false,
  };
  if (typeof code === "number" && [110, 113, 115, 116, 117, 118, 119, 122].includes(code)) {
    const classified: QoderErrorEvent = {
      ...error, status: 429, errorType: "insufficient_quota", code: "insufficient_quota", retryable: false,
      ...(code === 110 || code === 118 ? { apiKeyRecovery: true as const } : {}),
    };
    if (code === 110) recordReason?.("daily_limit");
    else if (code === 118) recordReason?.("personal_credits");
    return classified;
  }
  // Live qodercn 1.1.91 captures emit error_code "112" (credit usage limit) alongside the 403
  // pricing-URL body on exhausted CN accounts, whereas older/wrapper surfaces may emit 403/"403"
  // or no code. Any other explicit error_code (including non-numeric codes such as
  // "PERMISSION_DENIED", oversized integer strings, and non-recoverable vendor codes such as
  // 114/130) takes precedence over CN pricing-URL and text fallbacks.
  if (explicitErrorCode && code !== 403 && code !== 112) return error;
  if (profile.region === "cn" && isCnQuotaPricingFailure(error.message)) {
    recordReason?.("cn_pricing_url");
    return {
      ...error, status: 429, errorType: "insufficient_quota", code: "insufficient_quota",
      retryable: false, apiKeyRecovery: true as const,
    };
  }
  if (explicitErrorCode) return error;
  if (/daily usage limit|credit usage limit/i.test(error.message)) {
    const trimmed = error.message.trim();
    // qodercli 1.1.81 reworded the per-key daily limit; both wordings stay account-scoped.
    const isAccountDaily = (/^You've reached your daily usage limit for Chat\b/i.test(trimmed)
      || /^You have reached the daily usage limit\b/i.test(trimmed))
      && !/\b(?:team|model|shared)\b/i.test(error.message);
    if (isAccountDaily) recordReason?.("daily_limit");
    return {
      ...error, status: 429, errorType: "insufficient_quota", code: "insufficient_quota",
      retryable: false,
      ...(isAccountDaily ? { apiKeyRecovery: true as const } : {}),
    };
  }
  if (/\binvalid (?:personal access )?token\b|\btoken (?:was |that was )?rejected\b|\bqoder authentication rejected\b/i.test(error.message)) {
    return auth("auth");
  }
  return error;
}

const QODER_MCP_SERVER_NAME = "opencodex";
const QODER_MCP_SERVER_PATH = fileURLToPath(new URL("../coding-agent/mcp-server.ts", import.meta.url));
const MAX_PENDING_BOUNDARY_CHARS = 64 * 1024;
const MAX_PENDING_BOUNDARY_EVENTS = 1024;

// qodercli prints its own API-error notice as an ordinary assistant text frame just before the
// error result. Forwarding it counts as turn output and bars preflight key recovery, so hold the
// exact notices for key-recoverable failures (105/110/118, plus the qoder-cn 403 pricing-URL
// exhaustion signature) downstream of the scaffolding guard and drop a complete held notice only
// when a key-recoverable error terminal matching that same failure reason follows; once any other
// client-visible output flows, pass everything through unchanged.
const QODER_RECOVERABLE_ERROR_NOTICES: ReadonlyArray<{
  readonly text: string;
  readonly reason: QoderRecoverableNoticeReason;
}> = [
  { text: "Your authentication has expired. Please sign in again.", reason: "auth" },
  { text: "You have reached the daily usage limit. Please try again later.", reason: "daily_limit" },
  { text: "Your personal Credits have been exhausted. Please check your plan.", reason: "personal_credits" },
  { text: 'inference.remoteChat.stream failed (403): {"pricingUrl":"https://qoder.com.cn/pricing?client=qoder"}', reason: "cn_pricing_url" },
];

export function suppressQoderErrorPreamble(
  emit: (event: AdapterEvent) => void,
  getFailureReason?: () => QoderRecoverableNoticeReason | undefined,
): (event: AdapterEvent) => void {
  let held = "";
  let passthrough = false;
  const flush = (): void => {
    passthrough = true;
    if (held) emit({ type: "text_delta", text: held });
    held = "";
  };
  return (event: AdapterEvent): void => {
    if (passthrough) {
      emit(event);
      return;
    }
    if (event.type === "text_delta") {
      const candidate = held + event.text;
      if (QODER_RECOVERABLE_ERROR_NOTICES.some(notice => notice.text.startsWith(candidate))) {
        held = candidate;
        return;
      }
      flush();
      emit(event);
      return;
    }
    if (event.type === "error") {
      const matchedNotice = QODER_RECOVERABLE_ERROR_NOTICES.find(notice => notice.text === held);
      const errorReason = event.apiKeyRecovery === true ? getFailureReason?.() : undefined;
      if (matchedNotice && errorReason === matchedNotice.reason) {
        held = "";
        passthrough = true;
      } else {
        flush();
      }
      emit(event);
      return;
    }
    if (event.type === "heartbeat") {
      emit(event);
      return;
    }
    flush();
    emit(event);
  };
}

export function buildQoderChildEnv(profile: QoderProfile, apiKey: string, systemPrompt?: string): Record<string, string> {
  // Each build reads its own brand prefix with no fallback: qodercn ignores QODER_EXPOSE_TOKEN_USAGE.
  const envPrefix = profile.region === "cn" ? "QODERCN_" : "QODER_";
  const promptEnv = `${envPrefix}APPEND_SYSTEM_PROMPT`;
  return { ...baseScopedEnv(), NO_COLOR: "1", [`${envPrefix}EXPOSE_TOKEN_USAGE`]: "true", [profile.tokenEnv]: apiKey,
    ...(systemPrompt ? { [promptEnv]: systemPrompt } : {}) };
}

/**
 * Disable Qoder's built-in tools; only a request-scoped MCP catalog can be exposed.
 *
 * MCP lazy loading is switched off inline (#8704). Qoder defaults it on when no setting names it,
 * and then calls its own `mcp_get`/`mcp_call`/`mcp_list` wrappers instead of the catalog tools,
 * which the undeclared-tool guard rightly refuses. `--settings` is an explicit flag, so it
 * still applies while `--setting-sources ""` keeps every settings file out.
 */
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
    "--settings", JSON.stringify({ mcp: { lazyLoad: false } }),
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

  const filterReplay = (filter: () => string): string | undefined => {
    try {
      return filter();
    } catch (error) {
      if (!isTranslatorBudgetExceededError(error)) throw error;
      refuse("an unresolved tool envelope exceeding its buffer limit");
    }
  };

  const forwardText = (text: string, refuseOnMatch = true): void => {
    const safe = filterReplay(() => replayFilter.feed(text));
    if (safe === undefined) return;
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
    const tail = filterReplay(() => replayFilter.finish());
    if (tail === undefined) return false;
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
      const replayTail = filterReplay(() => replayFilter.finish());
      if (replayTail === undefined) return;
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

/** Build the regional Qoder adapter with a request-scoped capture-only tool catalog. */
export function createQoderAdapter(provider: OcxProviderConfig, deps: QoderAdapterDeps = {}): ProviderAdapter {
  return {
    name: "qoder",
    reportsPhysicalSends: true,
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
        for (const wireName of catalog.emittedNameMap.values()) {
          const restored = catalog.emittedNameMap.get(wireName);
          if (restored !== undefined && restored !== wireName) {
            throw new CodingAgentToolCatalogError("ambiguous selected tool identity");
          }
        }
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
            // Qoder can mix exact client wire names with MCP names in one reply.
            acceptWireToolNames: true,
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
      // Keep the classified failure reason in a per-turn closure instead of attaching it to the
      // error object: runCodingAgentTurn redacts and clones error events before emitting them.
      let classifiedFailureReason: QoderRecoverableNoticeReason | undefined;
      await runCodingAgentTurn({
          profiles: QODER_PROFILES,
          conversationInput: buildQoderConversationInput,
          classifyFailure: failure => classifyQoderFailure(failure, reason => {
            classifiedFailureReason = reason;
          }),
          provider,
          parsed,
          incoming,
          emit: guardQoderScaffolding(suppressQoderErrorPreamble(emit, () => classifiedFailureReason)),
          buildArgs: (_profile, req, prov) => buildQoderArgs(req, prov),
          buildEnv: (profile, apiKey) => buildQoderChildEnv(profile as QoderProfile, apiKey, system),
          deps,
          ...(toolBridge ? { toolBridge } : {}),
      });
    },
  };
}
