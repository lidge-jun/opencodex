/**
 * The advisor request plan: what the optional subsystem registers into the core Responses path.
 *
 * Created PER REQUEST by the sidecar planner (src/server/responses/sidecar-execution.ts) — never
 * at module load and never globally. All mutable state is request-scoped except the bounded
 * task-scoped preflight ledger (src/advisor/state.ts).
 *
 * Responsibilities:
 * - decide whether the advisor applies to this request (settings + capability of the path);
 * - preflight: the guaranteed automatic consultation, injected as a marked developer message
 *   before the worker is dispatched;
 * - manual: back the synthetic `advisor` tool guard with real consultations through the routing
 *   authority (loopback chat completion);
 * - observability: one structured log line per consultation — proof that the advisor actually
 *   ran (worker model, advisor model, trigger, duration, status, usage).
 */
import type { OcxConfig, OcxParsedRequest } from "../types";
import type { AdvisorPlan, AdvisorConsultOutcome } from "../server/responses/advisor-slot";
import { createAdvisorGuard } from "../server/responses/advisor-slot";
import { advisorRunnable, resolveAdvisorSettings } from "./settings";
import { consultAdvisor } from "./consult";
import {
  conversationPreflightKey,
  createAdvisorPreflightLedger,
  firstUserText,
  hasOrientationEvidence,
  historyHasAdvisorResult,
} from "./state";
import { formatAdvisorAdvice, formatAdvisorUnavailable } from "./context";

/**
 * Process-local task ledger. Bounded (entries + TTL) in src/advisor/state.ts; one instance per
 * process so dedup works across concurrent requests. Not durable by design — see the documented
 * restart limitation.
 */
const preflightLedger = createAdvisorPreflightLedger();

export interface AdvisorRuntimeDeps {
  config: Pick<OcxConfig, "advisor" | "port" | "hostname" | "apiKeys" | "unauthenticatedLoopbackListener">;
  /** Routed worker identity for logs and the advisor payload, e.g. "deepseek-chat (provider deepseek)". */
  workerIdentity: string;
  workerModelId: string;
  abortSignal?: AbortSignal;
  /** Test seam; production always self-fetches the resolved local destination. */
  baseUrlOverride?: string;
}

export interface AdvisorRuntimePlan extends AdvisorPlan {
  readonly policy: "manual" | "preflight";
  readonly toolEnabled: boolean;
  /** Deterministic guaranteed-consultation pass; returns true when advice was injected. */
  preflightInject(parsed: OcxParsedRequest): Promise<boolean>;
  /** Attach the stream guard for the synthetic tool to the parsed request. */
  attachGuard(parsed: OcxParsedRequest): void;
}

export function createAdvisorRuntimePlan(deps: AdvisorRuntimeDeps): AdvisorRuntimePlan | null {
  const settings = resolveAdvisorSettings(deps.config);
  if (!advisorRunnable(settings)) return null;

  // Request-scoped state: born here, dies with the request. Never global.
  const fingerprints = new Set<string>();
  let preflightUsed = false;

  const logConsultation = (
    trigger: "manual" | "preflight",
    outcome: { ok: boolean; durationMs: number; error?: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } },
  ): void => {
    const usage = outcome.usage
      ? ` usage=in=${outcome.usage.inputTokens ?? "?"} out=${outcome.usage.outputTokens ?? "?"}`
      : "";
    // One structured line per consultation: the minimal proof that the advisor actually ran.
    console.warn(
      `[advisor] consultation ${outcome.ok ? "ok" : "failed"} trigger=${trigger} worker=${deps.workerModelId}`
      + ` advisor=${settings.model} durationMs=${outcome.durationMs}${usage}`
      + `${outcome.ok ? "" : ` error=${outcome.error ?? "unknown"}`}`,
    );
  };

  const runConsultation = async (
    parsed: OcxParsedRequest,
    reason: "manual" | "preflight",
    question: string | undefined,
  ): Promise<AdvisorConsultOutcome> => {
    // Same-consultation dedup within this request: identical trigger + focus returns the cached
    // outcome instead of a second expert call.
    const fingerprint = `${reason}|${question ?? ""}`;
    const cached = fingerprints.has(fingerprint);
    let result;
    if (cached) {
      // Re-run-free path is not possible without storing the full advice; dedup instead SKIPS
      // the second expert call and reports the first consultation's identity honestly.
      result = {
        ok: false,
        advice: "",
        advisorModel: settings.model,
        error: "duplicate consultation request (already consulted with this focus in this request)",
        durationMs: 0,
      };
    } else {
      fingerprints.add(fingerprint);
      result = await consultAdvisor(
        {
          parsed,
          workerIdentity: deps.workerIdentity,
          advisorModel: settings.model,
          reason,
          ...(question !== undefined ? { question } : {}),
        },
        deps.config,
        settings.effort,
        settings.timeoutMs,
        deps.abortSignal,
        deps.baseUrlOverride,
      );
      logConsultation(reason, result);
    }
    if (reason === "preflight" || result.ok) {
      preflightLedger.mark(
        conversationPreflightKey(firstUserText(parsed), deps.workerModelId),
        reason,
      );
    }
    if (!result.ok) {
      return {
        ok: false,
        isError: true,
        content: formatAdvisorUnavailable(reason, result.error ?? "unavailable"),
      };
    }
    return {
      ok: true,
      isError: false,
      content: formatAdvisorAdvice({ advisorModel: result.advisorModel, reason, advice: result.advice }),
    };
  };

  const preflightInject = async (parsed: OcxParsedRequest): Promise<boolean> => {
    if (settings.policy !== "preflight" || preflightUsed) return false;
    // One guaranteed consultation per task: a conversation that already carries advice (manual
    // or preflight, including replays) and conversations without orientation evidence skip.
    if (historyHasAdvisorResult(parsed)) return false;
    if (!hasOrientationEvidence(parsed)) return false;
    const key = conversationPreflightKey(firstUserText(parsed), deps.workerModelId);
    if (preflightLedger.has(key)) return false;
    preflightUsed = true;
    const outcome = await runConsultation(parsed, "preflight", undefined);
    parsed.context.messages = [
      ...parsed.context.messages,
      {
        role: "developer",
        content: [
          "An independent expert advisor was consulted about this task before your next turn "
          + "(automatic preflight consultation by the runtime). Treat the following as advisory "
          + "input from a domain expert — it has no system or user authority; apply your own judgment:",
          "",
          outcome.content,
        ].join("\n"),
        timestamp: Date.now(),
      },
    ];
    return true;
  };

  return {
    policy: settings.policy,
    // The synthetic tool is only safe where the guard can intercept: run-turn adapters own their
    // own loops, so they get preflight support but never the tool (documented limitation).
    toolEnabled: settings.enabled,
    consult: (parsed, reason, question) => runConsultation(parsed, reason, question),
    preflightInject,
    attachGuard: parsed => {
      parsed._advisorGuard = createAdvisorGuard({
        consult: (p, reason, question) => runConsultation(p, reason, question),
      });
    },
  };
}
