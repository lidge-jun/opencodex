import { randomUUID } from "node:crypto";
import type { OcxConfig, OcxParsedRequest } from "../types";
import type { HandleResponsesOptions } from "../server/responses/core-options";
import { codexRequestProvenance, codexRequestTurn } from "../codex/request-provenance";
import { getAccountSet } from "../oauth/store";
import { appendUsageEntry } from "../usage/log";
import { CodexCacheRuntime } from "../codex/cache-runtime-state";
import { AnthropicCacheRenewal, cacheUsage, renewalBody, type CachePrefixComparison, type RenewalResult, type RenewalWire } from "./cache-renewal";
import { attachCacheObservation } from "../lib/anthropic-cache-observation";

export interface NaturalCacheScope {
  observeSend: typeof observeNaturalCacheSend;
  observationId?: string;
  threadId: string;
  turnId: string;
  role: "main" | "subagent";
  purpose?: "turn" | "compaction";
  provider: string;
  config: OcxConfig;
  oauth: boolean;
  conversationId?: string;
}

export type PinnedRenewalSend = (url: string, headers: Headers, body: string, signal: AbortSignal, dispatched: () => void) => Promise<Response>;

function renewalConfigAllowed(config: OcxConfig): boolean {
  // Detached renewals cannot reserve the original workflow's spend scopes yet.
  return config.anthropicCacheRenewal === true
    && ![config.spend?.root, config.spend?.identity, config.spend?.pool].some(scope => scope?.maxTokens !== undefined);
}

// Diagnostic correlation is process-local evidence, never an input to cache or task identity.
function naturalDiagnostic(scope: { observationId?: string; threadId?: string; turnId?: string; role?: string; purpose?: string },
  phase: "scope" | "response" | "usage", reason: string, usage?: unknown, comparison?: CachePrefixComparison): void {
  const id = (value?: string) => value && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value : "unavailable";
  const parsed = cacheUsage(usage);
  try {
    console.info("[anthropic-cache-natural]", JSON.stringify({ version: 1, observedAt: Date.now(),
      observationId: id(scope.observationId), threadId: id(scope.threadId), turnId: id(scope.turnId),
      role: ["main", "subagent"].includes(scope.role ?? "") ? scope.role : "unknown",
      purpose: ["turn", "compaction", "helper"].includes(scope.purpose ?? "") ? scope.purpose : "unknown", phase, reason,
      ...(usage && typeof usage === "object" ? { usageFieldMask: ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
        .map(key => Number.isSafeInteger((usage as Record<string, unknown>)[key]) && Number((usage as Record<string, unknown>)[key]) >= 0 ? "1" : "0").join("") } : {}),
      ...(parsed ? { cachedTokens: parsed.cache_read_input_tokens + parsed.cache_creation_input_tokens } : {}),
      ...(comparison ? { prefixComparison: comparison } : {}) }));
  } catch { /* Logging must not affect natural requests or cache confirmation. */ }
}

export function naturalCacheScope(input: {
  parsed: OcxParsedRequest; req: Request; config: OcxConfig; options: HandleResponsesOptions;
  adapterName: string; providerName: string; oauth: boolean; conversationId?: string;
}): NaturalCacheScope | undefined {
  const { parsed, req, options } = input;
  if (input.adapterName !== "anthropic" || !renewalConfigAllowed(input.config)) return;
  const diagnostic = { observationId: randomUUID(), threadId: parsed._codexOwnThreadId };
  if (!parsed._codexOwnThreadId) { naturalDiagnostic(diagnostic, "scope", "missing-own-thread"); return; }
  const turn = codexRequestTurn(parsed._rawBody, req.headers);
  if (!turn || turn.threadId !== parsed._codexOwnThreadId) {
    naturalDiagnostic(diagnostic, "scope", "missing-or-mismatched-turn"); return;
  }
  const origin = codexRequestProvenance(parsed._rawBody, req.headers, {
    transport: options.inboundTransport,
    internalHelper: !!(options.internalDecisionCall || options.memoryModelPhase || options.shadowCallIntercepted
      || options.visionDescribeTerminal || options.advisorInternal),
  });
  if ((origin.role !== "main" && origin.role !== "subagent") || !["turn", "compaction"].includes(origin.purpose)) {
    naturalDiagnostic({ ...diagnostic, ...turn, ...origin }, "scope", "ineligible-provenance"); return;
  }
  naturalDiagnostic({ ...diagnostic, ...turn, ...origin }, "scope", "eligible");
  return { ...turn, observeSend: observeNaturalCacheSend, observationId: diagnostic.observationId, role: origin.role, purpose: origin.purpose as "turn" | "compaction", provider: input.providerName, config: input.config,
    oauth: input.oauth, conversationId: input.conversationId };
}

export function renewalDiagnosticRecord(scope: NaturalCacheScope, event: RenewalResult, requestId: string) {
  const id = (value: string) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value) ? value : "unavailable";
  return { version: 1, requestId, threadId: id(scope.threadId), turnId: id(scope.turnId),
    role: scope.role, status: event.status, reason: event.reason, sent: event.sent,
    durationMs: event.duration, ...event.diagnostics };
}

const runtime = new CodexCacheRuntime();
const manager = new AnthropicCacheRenewal({
  now: () => performance.now(),
  later: (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return timer; },
  clear: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
  watch: (thread, update, turn) => runtime.watch(thread, update, turn),
});

export async function observeNaturalCacheSend(
  scope: NaturalCacheScope,
  input: Parameters<typeof fetch>[0],
  init: RequestInit,
  physical: typeof fetch,
  renew: PinnedRenewalSend,
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const original = typeof init.body === "string" ? init.body : undefined;
  if (!original || !renewalBody(original) || scope.config.cacheRetention === "none" || !renewalConfigAllowed(scope.config)) {
    naturalDiagnostic(scope, "response", scope.config.cacheRetention === "none" ? "cache-disabled" : "ineligible-body");
    manager.forget(scope.threadId);
    return physical(input, init);
  }
  const parsed = JSON.parse(original);
  const body = JSON.stringify({ ...parsed, stream: true });
  const headers = new Headers(init.headers);
  headers.delete("content-length");
  headers.set("accept", "text/event-stream");
  const credential = headers.get("authorization") ?? headers.get("x-api-key") ?? "";
  const identity = JSON.stringify([scope.provider, url, parsed.model, credential, headers.get("anthropic-organization-id")]);
  const allowed = () => {
    if (scope.config.cacheRetention === "none" || !renewalConfigAllowed(scope.config)) return false;
    if (!scope.oauth) return true;
    const token = headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    return !!token && !!getAccountSet(scope.provider)?.accounts.some(row => row.credential.access === token && !row.paused && !row.needsReauth);
  };
  const wire: RenewalWire = {
    identity, turnId: scope.turnId, model: String(parsed.model), body, allowed,
    async send(nextBody, signal, dispatched) {
      if (!await runtime.active(scope.threadId) || signal.aborted || !allowed()) throw new Error("cache-runtime-not-active");
      const renewalHeaders = new Headers(headers);
      renewalHeaders.delete("content-length");
      renewalHeaders.set("accept", "application/json");
      return renew(url, renewalHeaders, nextBody, signal, dispatched);
    },
    record(event) {
      const usage = event.usage;
      const requestId = `ocx-${randomUUID().replaceAll("-", "")}`;
      console.info("[anthropic-cache-renewal]", JSON.stringify(renewalDiagnosticRecord(scope, event, requestId)));
      appendUsageEntry({ requestId, timestamp: Date.now() - event.duration,
        provider: scope.provider, model: wire.model, conversationId: scope.conversationId,
        status: event.status, durationMs: event.duration, usageStatus: usage ? "reported" : "unreported",
        cacheProvenance: usage ? "observed" : "unknown", errorCode: `cache_renewal_${event.reason}`,
        ...(usage ? { usage: { inputTokens: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
          outputTokens: usage.output_tokens, cachedInputTokens: usage.cache_read_input_tokens,
          cacheReadInputTokens: usage.cache_read_input_tokens, cacheCreationInputTokens: usage.cache_creation_input_tokens } } : {}),
      });
    },
  };
  wire.body = manager.prepare(scope.threadId, wire);
  const acceptUsage = manager.begin(scope.threadId, wire, (reason, raw, comparison) => naturalDiagnostic(scope, "usage", reason, raw, comparison));
  const response = await physical(input, { ...init, headers, body: wire.body });
  naturalDiagnostic(scope, "response", response.ok ? "attached" : "http-error");
  if (response.ok) attachCacheObservation(response, acceptUsage);
  return response;
}

export function stopAnthropicCacheRenewal(): void { manager.close(); }
