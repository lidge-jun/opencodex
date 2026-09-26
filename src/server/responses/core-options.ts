import type { NativeResponseControl } from "./native-response-control";
import type { OcxUsage, OcxProviderContinuationState, OcxConfig } from "../../types";
import type { CodexAuthPolicyConfig, CodexAuthContext } from "../../codex/auth-context";
import type { AdmissionLease } from "../../lib/admission";
import type { DataPlaneAdmission } from "../auth-cors";
import { resolveCodexModelEntitlements } from "../../codex/model-entitlements";
import type { ResponsesTerminalStatus } from "../../bridge";
import type { ResponsesTerminalRepairScheduler } from "../responses-terminal-repair";
import type { BunRuntimeGateInput } from "./ws-upstream";
import type { NativeMainRefreshDependencies } from "../../codex/main-account";
import type { InboundWire } from "../../providers/registry";
import type { ExplicitOpenAiCallerAuth } from "../../providers/openai-sidecar";
import type { CallerDirectAuth } from "../../providers/caller-authorization";
import type { CompactionRoutingOverride } from "./compaction-routing";
import type { TranslatorBudget } from "../../lib/translator-budget";
import type { TransientSendBudget } from "../../lib/upstream-retry";
import type { RequestLogContext } from "../request-log";
import type { UpstreamHostAdmissionLease } from "../../codex/upstream-host-health";

export interface ConsumedComboFailure {
  response: Response;
  classificationText: string;
  /** Structured upstream `error.code` when present in the failure body. */
  upstreamCode?: string;
  /** Valid numeric/date value used only for cooldown calculation. */
  retryAfter?: string;
  /** Upstream Codex quota-window reset timestamps used for combo cooldowns. */
  resetAt?: string[];
  /** Reserved for 040 usage attribution without adding another body read. */
  usage?: OcxUsage;
  /**
   * The failed attempt's response was marked non-replayable, such as the answer to a spent
   * ambiguous-reset replacement. The re-wrapped {@link response} cannot carry that in-memory
   * marker, so the combo loop reads it here and stops instead of sending the turn to a later target.
   */
  nonReplayable?: boolean;
}




/**
 * Direct client encoding for a translated Chat or Messages turn (PF-09). `model` is the model
 * string the client asked for, which every client frame carries; `inputTokenFloor` is the
 * Messages prompt estimate `message_start` reports when no usage arrived first (#4857).
 */
export interface ClientEncoderOption {
  protocol: "chat" | "messages";
  stream: boolean;
  model: string;
  inputTokenFloor?: number;
}

export interface HandleResponsesOptions {
  /** Internal Claude replay identity; consumed only by the final canonical Go transport. */
  claudeGoAffinity?: { sessionLane?: string };
  /** Validated Claude metadata identity; projected only into final canonical attempt headers. */
  claudeNativeSessionId?: string;
  /** Original live policy owner; separate from caller-specific routing/sidecar snapshots. */
  codexAuthPolicy?: CodexAuthPolicyConfig;
  turnAdmissionLease?: AdmissionLease;
  /**
   * How the caller proved data-plane admission (#1686).
   *
   * A bearer-presented admission secret is one of OUR OWN secrets, so a Direct turn must
   * SUBSTITUTE the stored main credential rather than forward it. Without this fact at the
   * decision point, Direct cannot tell an admission bearer from the user own ChatGPT bearer,
   * which is why it refused the whole env_key flow instead of serving it.
   */
  admission?: DataPlaneAdmission;
  /** Called at most once after the complete client body is read and accepted for dispatch. */
  onRequestBodyRead?: () => void;
  /** Internal handoff for retry wrappers that must reuse the already-accounted request body. */
  onRequestBodyParsed?: (body: unknown) => void;
  forceEmptyResponseId?: boolean;
  /** Internal, connection-owned control channel; never reconstructed from headers. */
  nativeControl?: NativeResponseControl;
  abortSignal?: AbortSignal;
  /** One-shot TTFT callback: first non-empty model output observed (WP4). */
  onFirstOutput?: () => void;
  onCodexAuthContextResolved?: (context: CodexAuthContext | undefined) => void;
  /** Internal deterministic seam for account-gated native fallback tests. */
  resolveCodexModelEntitlements?: typeof resolveCodexModelEntitlements;
  /** Internal: validated final client-visible model, after completed terminal success only. */
  onResponseComplete?: (model: string) => void;
  recordTerminalOutcomes?: boolean;
  setTerminalOutcomeRecorder?: (recorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined) => void;
  onNativePassthroughTerminal?: (status: ResponsesTerminalStatus) => void;
  onNativePassthroughCancel?: () => void;
  /** Internal deterministic clock/timer seam for provider terminal repair. */
  responsesTerminalRepairScheduler?: ResponsesTerminalRepairScheduler;
  /** Internal deterministic runtime-identity seam for Codex upstream WS selection tests. */
  codexWsRuntimeIdentity?: BunRuntimeGateInput;
  /** Test seam for native main refresh without live OAuth traffic. */
  nativeMainRefreshDependencies?: NativeMainRefreshDependencies;
  /**
   * When true, body `prompt_cache_key` is a Claude Desktop shared cache cohort
   * (system/tools hash), not a per-session id — do not use it for Anthropic pool affinity.
   */
  promptCacheKeyIsSharedCohort?: boolean;
  /**
   * Wire protocol the ORIGINAL client spoke. The Chat and Anthropic surfaces translate
   * their body into a Responses shape and replay through this function, so without an
   * explicit value the replay would look like a native Responses request and an
   * inbound-scoped registry wire default would fire for a client that never asked for
   * it. Omitted means a genuine Responses inbound.
   */
  inboundWire?: InboundWire;
  /** PF-07: the Chat source a combo child may send natively; set only by the Chat ingress. */
  protocolSource?: import("./core-combo-native").ComboProtocolSource;
  /** Internal transport identity for route-scoped upstream compatibility policy. */
  inboundTransport?: "websocket";
  /**
   * Claude replay may add native-main auth so OpenAI sidecars remain available.
   * Strip only that internal credential when the final route is a noncanonical
   * forward/caller-auth destination; final routing can differ from Claude's preflight route.
   */
  stripClaudeMainAuthForNoncanonicalForward?: boolean;
  /** In-memory credential proven by Claude's native-main turn claim; never persist or log. */
  trustedClaudeMainAuth?: { authorization: string; chatgptAccountId?: string };
  /** Sidecar-only auth captured before route changes; null means no usable original pair. */
  openAiSidecarAuth?: ExplicitOpenAiCallerAuth | null;
  /** Internal Chat bridge permission to obtain claimed stored auth only for a final Direct sidecar. */
  allowStoredOpenAiSidecarAuth?: boolean;
  /** Original caller-owned native pair; separate from any claimed sidecar enrichment. */
  nativeCallerAuth?: ExplicitOpenAiCallerAuth | null;
  /** Caller Direct credential under Direct\'s own predicate; restored only for the canonical OpenAI final route. */
  callerDirectAuth?: CallerDirectAuth | null;
  /** Internal recursion guard; callers outside this module must not set it. */
  comboAttempt?: boolean;
  /** Internal handoff: this combo was selected by shadow-call interception. */
  shadowCallIntercepted?: boolean;
  /** Internal handoff: the memory phase this turn belongs to, so combo children keep its routing. */
  memoryModelPhase?: "extract" | "consolidation";
  compactionRoutingOverride?: CompactionRoutingOverride | null;
  /** Internal combo handoff for one parent-validated continuation snapshot. */
  comboReplaySnapshot?: {
    sourceBody: unknown;
    previousResponseInputExpanded: boolean;
    providerContinuation: OcxProviderContinuationState | undefined;
    recoveredPlaintext: boolean;
  };
  /** Internal combo handoff: allow a later same-provider model after a reset-derived 429/402. */
  deferCodexResetDerivedCooldown?: boolean;
  /** 030-owned handoff when a child consumed the original failure under bounds. */
  onConsumedComboFailure?: (failure: ConsumedComboFailure) => void;
  /** A stored Pool credential was refreshed and its one allowed same-account replay was sent. */
  onStoredPool401ReplayDispatched?: () => void;
  /** Caller-owned for Chat/Claude replay; omitted only at genuine Responses ingress. */
  translatorBudget?: TranslatorBudget;
  /**
   * Transient sends already spent by this logical request. Combo children inherit the parent's
   * holder through the options spread, so a fan-out shares one allowance instead of taking a
   * fresh one per target (#4546).
   */
  sendBudget?: TransientSendBudget;
  /**
   * Terminal vision-describe marker (roadmap 180): true when the inbound
   * request IS the vision sidecar's own loopback describe call. The plan site
   * then STRIPS images instead of planning another describe — a depth cap of 1
   * that holds under predicate drift and combo re-resolution. The Chat surface
   * detects the raw `x-opencodex-vision-describe` header before its bridge
   * rebuilds headers and carries the fact through this flag.
   */
  visionDescribeTerminal?: boolean;
  /**
   * Set only by the Chat and Messages ingresses when `protocols.rollout.directEncoders` is on and
   * the settled route is one non-Responses target. Adapter delivery then encodes the adapter
   * events straight into the client's wire and returns a response marked with `markClientWire`.
   * Passthrough, run-turn adapters, combo children and compaction turns ignore it and keep
   * returning a Responses body, which the ingress converts as before.
   */
  clientEncoder?: ClientEncoderOption;
}

/** Values shared by the call, not a bag of mutable pipeline state. */
export interface ResponsesRequestContext {
  req: Request;
  config: OcxConfig;
  logCtx: RequestLogContext;
  options: HandleResponsesOptions & { translatorBudget: TranslatorBudget };
}

/** Admission leases remain owned by the outer finally until explicitly transferred. */
export interface ResponsesAdmissionState {
  pendingHostAdmissionLease: UpstreamHostAdmissionLease | null;
  authCtx: CodexAuthContext;
}

export interface PassthroughAdmissionState {
  lease: UpstreamHostAdmissionLease | null;
}

/** Recursive combo children enter the same ingress without a runtime import cycle. */
export interface ResponsesDispatchers {
  handleResponses(req: Request, config: OcxConfig, logCtx: RequestLogContext, options?: HandleResponsesOptions): Promise<Response>;
  handleComboResponses(req: Request, body: unknown, comboId: string, config: OcxConfig, logCtx: RequestLogContext, options: HandleResponsesOptions & { translatorBudget: TranslatorBudget }): Promise<Response>;
}
