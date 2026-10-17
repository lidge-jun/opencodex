/**
 * Explicit single-model diagnostic, isolated from discovery, routing health and request history.
 * Unsupported transports: TLS profiles, HTTP version pins, enabled pacing, custom fetch + proxy.
 * Adding an exclusion requires a regression test. No retries, failover, or output preview.
 */
import type { OcxConfig, OcxProviderConfig } from "../../types";
import { routedProviderConfig } from "../../providers/routed-config";
import { PROVIDER_REGISTRY } from "../../providers/registry";
import { resolveModelAlias } from "../../providers/default-aliases";
import { providerApiKeySelectionIsCurrent } from "../../providers/api-key-selection";
import { resolveWireProtocolOverride } from "../adapter-resolve";
import { openAIChatTransport, stripBracketedModelSuffix } from "../../adapters/openai-chat/wire";
import { buildResponsesTransport } from "../../adapters/openai-responses/transport";
import { openRouterProviderPayload, resolveOpenRouterRouting } from "../../providers/openrouter-routing";
import { resolveVercelGatewayRouting, vercelGatewayProviderPayload } from "../../providers/vercel-gateway-routing";
import { assertProviderDestinationAllowed, providerAllowsPrivateNetwork } from "../../lib/destination-policy";
import { providerOutboundPost, ProviderOutboundPolicyError, ProviderOutboundSendCancelledError,
  type ProviderOutboundDependencies } from "../../lib/provider-outbound";
import { redactSecretString } from "../../lib/redact";
import { decodeServerSentEvents } from "../../lib/sse-decoder";
import { createTranslatorBudget } from "../../lib/translator-budget";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";
import { managementBodyTooLargeResponse, readManagementJsonBody } from "./body";

export const COMPLETION_TEST_PROMPT = "Reply exactly OK.";
export const COMPLETION_TEST_OUTPUT_TOKEN_CAP = 32;
export const COMPLETION_TEST_TIMEOUT_MS = 20_000;
export const COMPLETION_TEST_MAX_BYTES = 64 * 1024;

type Wire = "openai-chat" | "openai-responses";
type Code = "destination_refused" | "credential_missing" | "credential_changed" | "http_status" | "redirect"
  | "network" | "stream_error" | "premature_eof" | "no_content" | "timeout" | "aborted" | "too_large";
const MESSAGES: Record<Code, string> = {
  destination_refused: "Provider destination refused by policy.",
  credential_missing: "Provider credential is missing.",
  credential_changed: "Provider request authority changed before send.",
  http_status: "Upstream returned an unsuccessful HTTP status.",
  redirect: "Upstream redirect refused.",
  network: "Upstream network request failed.",
  stream_error: "Upstream stream reported an error.",
  premature_eof: "Upstream stream ended without a terminal event.",
  no_content: "Upstream completed without a text delta.",
  timeout: "Completion test deadline exceeded.",
  aborted: "Completion test was cancelled.",
  too_large: "Upstream stream exceeded the byte limit.",
};
export type ProviderCompletionTestResult = {
  applicable: false;
  reason: "disabled" | "forward_auth" | "oauth_auth" | "unsupported_adapter" | "unsupported_transport";
  adapter?: string;
  detail?: "tls_profile" | "upstream_http_version" | "request_pacing" | "custom_executor_egress";
} | {
  applicable: true; ok: boolean; provider: string; requestedModel: string; wireModel: string; wire: Wire;
  upstreamModel: string | null; modelComparison: "match" | "mismatch" | "unknown";
  comparisonNote?: "missing_metadata" | "conflicting_metadata";
  identityVerified: false; ttftMs: number | null; totalLatencyMs: number; outputTokenCap: 32;
  termination: "completed" | "failed" | "timeout" | "aborted" | "too_large";
  error: null | { code: Code; status?: number; message: string };
};
export interface ProviderCompletionTestInput { config: OcxConfig; name: string; model: string; signal?: AbortSignal }
export interface ProviderCompletionTestDependencies {
  now?: () => number;
  timeoutMs?: number;
  outboundDependencies?: ProviderOutboundDependencies;
}

function transportExclusion(row: OcxProviderConfig): Extract<ProviderCompletionTestResult, { applicable: false }>["detail"] {
  if (row.tlsProfile !== undefined) return "tls_profile";
  if (row.upstreamHttpVersion !== undefined) return "upstream_http_version";
  if (row.requestPacing?.enabled) return "request_pacing";
  if (typeof (row as { fetch?: unknown }).fetch === "function" && "proxy" in row) return "custom_executor_egress";
  return undefined;
}
function nativeModel(config: OcxConfig, row: OcxProviderConfig, model: string): string {
  const known = new Set([...(row.models ?? []), ...Object.keys(row.modelAliases ?? {})]);
  return known.has(model) ? model : resolveModelAlias(config, row, known, model) ?? model;
}
function derive(config: OcxConfig, name: string, row: OcxProviderConfig, model: string) {
  const resolved = routedProviderConfig(name, row);
  const native = nativeModel(config, resolved, model);
  const routed = resolveWireProtocolOverride(name, native, resolved);
  const wire = routed.adapter;
  if (wire !== "openai-chat" && wire !== "openai-responses") throw new Error("unsupported adapter");
  const transport = wire === "openai-chat" ? openAIChatTransport(routed)
    : buildResponsesTransport(routed, { headers: new Headers() });
  const headers = new Headers(transport.headers);
  headers.set("Accept", "text/event-stream");
  const wireModel = routed.modelSuffixBracketStrip ? stripBracketedModelSuffix(native) : native;
  const openRouterRouting = wire === "openai-chat" ? resolveOpenRouterRouting(routed, native) : undefined;
  const vercelRouting = wire === "openai-chat" ? resolveVercelGatewayRouting(routed, native) : undefined;
  const providerRouting = vercelRouting ? vercelGatewayProviderPayload(vercelRouting)
    : openRouterRouting ? openRouterProviderPayload(openRouterRouting) : undefined;
  // Normal inference admits registry-local defaults as well as the operator's explicit opt-in.
  // Materialize that effective policy for the outbound wrapper's narrower local HTTP safeguard.
  const allowLocalCleartextPost = providerAllowsPrivateNetwork(name, routed);
  // Capture primitive values now: rows and their nested header objects may mutate in place.
  const selection = routed._apiKeyAttempt;
  const fingerprint = JSON.stringify({ wire, providerRouting, allowLocalCleartextPost, url: transport.url, wireModel, headers: [...headers].sort(([a], [b]) => a.localeCompare(b)),
    authMode: routed.authMode, apiKey: routed.apiKey,
    selection: selection && { entryId: selection.entryId, reference: selection.reference, revision: selection.revision },
    allowPrivateNetwork: routed.allowPrivateNetwork, proxy: routed.proxy, noProxy: routed.noProxy, disabled: row.disabled });
  return { routed, wire: wire as Wire, wireModel, providerRouting, allowLocalCleartextPost, headers, url: transport.url, fingerprint };
}
function maskedModel(raw: string, secrets: Array<string | undefined>): string {
  if (secrets.some(secret => typeof secret === "string" && secret.length > 0 && raw.includes(secret))) return "[redacted]";
  return redactSecretString(raw.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 256));
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
class DiagnosticFailure extends Error { constructor(readonly code: Code) { super(MESSAGES[code]); } }

/** Direct diagnostic; callers supply an existing provider name and an already validated model. */
export async function runProviderCompletionTest(
  { config, name, model, signal: requestSignal }: ProviderCompletionTestInput,
  deps: ProviderCompletionTestDependencies = {},
): Promise<ProviderCompletionTestResult> {
  const row = config.providers[name];
  if (!Object.hasOwn(config.providers, name) || !row) throw new Error("unknown provider");
  if (row.disabled) return { applicable: false, reason: "disabled" };
  const authKind = PROVIDER_REGISTRY.find(entry => entry.id === name)?.authKind;
  if (row.authMode === "forward" || authKind === "forward") return { applicable: false, reason: "forward_auth" };
  if (row.authMode === "oauth" || authKind === "oauth") return { applicable: false, reason: "oauth_auth" };
  const detail = transportExclusion(row);
  if (detail) return { applicable: false, reason: "unsupported_transport", detail };
  // Metadata resolution must never dereference keychain/env/pool credentials.
  const { apiKey: _key, apiKeyPool: _pool, _apiKeyAttempt: _attempt, ...metadata } = row;
  let snapshot: OcxProviderConfig = metadata;
  let destinationRefused = false;
  try { snapshot = routedProviderConfig(name, metadata); } catch { destinationRefused = true; }
  const native = nativeModel(config, snapshot, model);
  const wire = resolveWireProtocolOverride(name, native, snapshot).adapter;
  if (wire !== "openai-chat" && wire !== "openai-responses") return { applicable: false, reason: "unsupported_adapter", adapter: wire };
  const now = deps.now ?? (() => performance.now());
  const result: Extract<ProviderCompletionTestResult, { applicable: true }> = {
    applicable: true, ok: false, provider: name, requestedModel: model,
    wireModel: snapshot.modelSuffixBracketStrip ? stripBracketedModelSuffix(native) : native, wire,
    upstreamModel: null, modelComparison: "unknown", comparisonNote: "missing_metadata", identityVerified: false,
    ttftMs: null, totalLatencyMs: 0, outputTokenCap: COMPLETION_TEST_OUTPUT_TOKEN_CAP, termination: "failed", error: null,
  };
  const fail = (code: Code, status?: number) => {
    result.error = { code, message: MESSAGES[code], ...(status !== undefined ? { status } : {}) };
    result.termination = code === "timeout" || code === "aborted" || code === "too_large" ? code : "failed";
    return result;
  };
  if (destinationRefused) return fail("destination_refused");
  try { assertProviderDestinationAllowed(name, snapshot); } catch { return fail("destination_refused"); }
  let resolved: OcxProviderConfig;
  try { resolved = routedProviderConfig(name, row); } catch { return fail("credential_missing"); }
  if (resolved.authMode === "key" && !resolved.keyOptional && !resolved.apiKey?.trim()) return fail("credential_missing");
  let authority: ReturnType<typeof derive>;
  try { authority = derive(config, name, row, model); } catch { return fail("network"); }
  const secrets = [authority.routed.apiKey, ...Object.values(authority.routed.headers ?? {}),
    ...[...authority.headers].filter(([name]) => name === "authorization" || name === "x-api-key").map(([, value]) => value)];
  result.wire = authority.wire;
  result.wireModel = authority.wireModel;
  const controller = new AbortController();
  const deadline = AbortSignal.timeout(deps.timeoutMs ?? COMPLETION_TEST_TIMEOUT_MS);
  const signal = AbortSignal.any([...(requestSignal ? [requestSignal] : []), deadline, controller.signal]);
  const started = now();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const translatorBudget = createTranslatorBudget();
  let observed: string | undefined;
  let conflicting = false, terminal = false, content = false, finishReason = false;
  const observe = (value: unknown) => {
    if (typeof value !== "string") return;
    if (observed === undefined) observed = value;
    else if (value !== observed) conflicting = true;
  };
  try {
    signal.throwIfAborted();
    const body = JSON.stringify(authority.wire === "openai-chat"
      ? { model: authority.wireModel, messages: [{ role: "user", content: COMPLETION_TEST_PROMPT }], stream: true, max_tokens: 32,
        ...(authority.providerRouting ? { provider: authority.providerRouting } : {}) }
      : { model: authority.wireModel, input: COMPLETION_TEST_PROMPT, stream: true, max_output_tokens: 32, store: false });
    const pending = providerOutboundPost(name, { ...authority.routed, allowPrivateNetwork: authority.allowLocalCleartextPost }, authority.url, { headers: authority.headers, body, signal }, {
      ...deps.outboundDependencies,
      allowLocalCleartextPost: authority.allowLocalCleartextPost,
      beforeSend: () => {
        try {
          const current = config.providers[name];
          return current === row && !current.disabled && !transportExclusion(current)
            && derive(config, name, current, model).fingerprint === authority.fingerprint
            && (!authority.routed.apiKey || providerApiKeySelectionIsCurrent(config, name, authority.routed));
        } catch { return false; }
      },
    });
    // Even an executor ignoring AbortSignal cannot retain a late response body.
    void pending.then(late => { if (signal.aborted) void late.body?.cancel().catch(() => {}); }, () => {});
    response = await abortable(pending, signal);
    if (response.status >= 300 && response.status < 400) return fail("redirect");
    if (!response.ok) return fail("http_status", response.status);
    if (!response.body) return fail("premature_eof");
    reader = response.body.getReader();
    let bytes = 0;
    const counted = new ReadableStream<Uint8Array>({
      async pull(target) {
        try {
          const next = await abortable(reader!.read(), signal);
          if (next.done) { target.close(); return; }
          bytes += next.value.byteLength;
          if (bytes > COMPLETION_TEST_MAX_BYTES) throw new DiagnosticFailure("too_large");
          target.enqueue(next.value);
        } catch (error) { target.error(error); }
      },
      cancel() { void reader!.cancel().catch(() => {}); },
    }, { highWaterMark: 0 });
    for await (const event of decodeServerSentEvents(counted, { signal, translatorBudget })) {
      if (authority.wire === "openai-chat" && event.data.trim() === "[DONE]") { terminal = true; break; }
      let chunk: Record<string, any>;
      try { chunk = JSON.parse(event.data); } catch { throw new DiagnosticFailure("stream_error"); }
      if (!chunk || typeof chunk !== "object" || chunk.error || event.event === "error" || chunk.type === "error" || chunk.type === "response.failed") {
        throw new DiagnosticFailure("stream_error");
      }
      let text = false;
      if (authority.wire === "openai-chat") {
        observe(chunk.model);
        if (Array.isArray(chunk.choices)) for (const choice of chunk.choices) {
          if (typeof choice?.delta?.content === "string" && choice.delta.content.length > 0) text = true;
          if (choice?.finish_reason != null) finishReason = true;
        }
      } else {
        const type = chunk.type ?? event.event;
        if (["response.created", "response.completed", "response.incomplete"].includes(type)) observe(chunk.response?.model);
        text = type === "response.output_text.delta" && typeof chunk.delta === "string" && chunk.delta.length > 0;
        terminal = type === "response.completed" || type === "response.incomplete";
        if (type === "response.failed") throw new DiagnosticFailure("stream_error");
      }
      if (text) { content = true; result.ttftMs ??= Math.max(0, Math.round(now() - started)); }
      if (terminal) break;
    }
    signal.throwIfAborted();
    if (!terminal && !(authority.wire === "openai-chat" && finishReason)) return fail("premature_eof");
    if (!content) return fail("no_content");
    result.ok = true;
    result.termination = "completed";
    return result;
  } catch (error) {
    return fail(requestSignal?.aborted ? "aborted" : deadline.aborted ? "timeout"
      : error instanceof DiagnosticFailure ? error.code
      : error instanceof ProviderOutboundSendCancelledError ? "credential_changed"
      : error instanceof ProviderOutboundPolicyError ? "destination_refused" : "network");
  } finally {
    translatorBudget.dispose();
    result.totalLatencyMs = Math.max(0, Math.round(now() - started));
    if (observed !== undefined && !conflicting) {
      result.modelComparison = observed === authority.wireModel ? "match" : "mismatch";
      delete result.comparisonNote;
      result.upstreamModel = maskedModel(observed, secrets);
    } else if (conflicting) result.comparisonNote = "conflicting_metadata";
    controller.abort();
    // Cancellation is initiated on every exit; do not wait on a misbehaving executor.
    if (reader) { void reader.cancel().catch(() => {}); try { reader.releaseLock(); } catch { /* read pending */ } }
    else void response?.body?.cancel().catch(() => {});
  }
}

const inFlight = new Set<string>();
export async function handleProviderCompletionTestRoute(
  { req, url, config }: Pick<ManagementContext, "req" | "url" | "config">,
  deps: ProviderCompletionTestDependencies = {},
): Promise<Response> {
  let body: unknown;
  try { body = await readManagementJsonBody(req); } catch (error) {
    return managementBodyTooLargeResponse(error, req, config) ?? jsonResponse({ error: "invalid completion test request" }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some(key => key !== "model" && key !== "confirm")
    || (body as { confirm?: unknown }).confirm !== true || typeof (body as { model?: unknown }).model !== "string") {
    return jsonResponse({ error: "invalid completion test request" }, 400);
  }
  const model = (body as { model: string }).model.trim();
  if (!model || model.length > 256 || /[\x00-\x1f\x7f-\x9f]/.test((body as { model: string }).model)) {
    return jsonResponse({ error: "invalid completion test request" }, 400);
  }
  const name = url.searchParams.get("name") ?? "";
  if (!Object.hasOwn(config.providers, name) || !config.providers[name]) return jsonResponse({ error: "unknown provider" }, 404);
  if (inFlight.has(name)) return jsonResponse({ error: "completion test already running for this provider" }, 409);
  inFlight.add(name);
  try { return jsonResponse(await runProviderCompletionTest({ config, name, model, signal: req.signal }, deps)); }
  finally { inFlight.delete(name); }
}
