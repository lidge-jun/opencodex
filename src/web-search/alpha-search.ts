/**
 * Serve Codex's built-in `/v1/alpha/search` when no ChatGPT forward provider exists.
 *
 * The ChatGPT relay in src/server/search.ts is byte-identical on purpose: the client talks an
 * unpublished alpha envelope, and the only honest answer while a forward provider is configured
 * is to copy bytes. That leaves API-key-only and routed-provider deployments with a 400 even
 * when they already paid for a web-search sidecar. This module is the empty-candidates branch
 * of that handler — it never runs when a forward provider is present, and it never borrows a
 * different paid backend than the one the operator named.
 *
 * Do not import `./index.ts` from here. The barrel is still evaluating when search.ts loads,
 * and pulling it in recreates the cycle sidecar-providers.ts exists to avoid.
 */
import { formatErrorResponse } from "../bridge";
import { signalWithTimeout } from "../lib/abort";
import { redactSecretString } from "../lib/redact";
import { sidecarEnter } from "../lib/sidecar-tracker";
import { admissionScopeDenial } from "../server/admission-model-scope";
import type { DataPlaneAdmission } from "../server/auth-cors";
import type { OcxConfig, OcxProviderConfig, OcxWebSearchSidecarConfig } from "../types";
import { runAnthropicWebSearch } from "./anthropic-executor";
import { resolveDevinWebSearchSnapshot, runDevinWebSearch } from "./devin-executor";
import { runExaWebSearch } from "./exa-executor";
import type { SidecarOutcome, SidecarSettings } from "./executor";
import { runGeminiWebSearch } from "./gemini-executor";
import {
  findAnthropicSidecarProvider,
  findGeminiSidecarProvider,
  findXaiSidecarProvider,
  resolveSidecarBackend,
  xaiSearchOptionsFromConfig,
} from "./sidecar-providers";
import { safeWebSearchSources } from "./sources";
import { runXaiWebSearch } from "./xai-executor";

/**
 * Same total-search budget the ChatGPT relay uses in src/server/search.ts. The sidecar loop's
 * 60s default is a different contract (a helper turn beside a routed model); alpha/search is
 * the whole request, so it keeps the relay's 200s ceiling unless config.search.timeoutMs says
 * otherwise.
 */
const SEARCH_UPSTREAM_TIMEOUT_MS = 200_000;
/** Queries honored from one alpha/search body; the rest are ignored rather than billed. */
const MAX_QUERIES_PER_CALL = 3;
const MAX_QUERY_CHARS = 1_000;
const DEFAULT_REASONING = "low";

/**
 * Search model each sidecar backend runs when the operator did not name one for THIS backend.
 * Copied from the passthrough bridge's table on purpose: sending a ChatGPT slug to Anthropic
 * is the failure that table exists to prevent, and alpha/search would reproduce it if it
 * trusted `webSearchSidecar.model` unconditionally.
 */
const DEFAULT_BACKEND_MODELS = {
  anthropic: "claude-sonnet-5",
  xai: "grok-4.6",
  gemini: "gemini-3.8-flash",
  // Exa ignores model; the placeholder only satisfies SidecarSettings.
  exa: "gpt-5.6-luna",
} as const;

export type AlphaSearchSidecarBackend = keyof typeof DEFAULT_BACKEND_MODELS;

type ResolvedAlphaSearchSidecar =
  | { backend: "anthropic"; providerName: string; provider: OcxProviderConfig }
  | { backend: "xai"; providerName: string; provider: OcxProviderConfig }
  | { backend: "gemini"; providerName: string; provider: OcxProviderConfig }
  | { backend: "exa"; apiKey: string };

/**
 * Why this path cannot serve the request, kept distinct from "nobody asked for it".
 *
 * The two refusals read identically to the operator but mean opposite things: `unconfigured` is
 * a deployment that never named a backend, while `missing-credential` is one that named a
 * backend the proxy cannot authenticate. Answering both with the ChatGPT-auth sentence is the
 * behaviour the feature request called out — it tells an operator who already chose Exa to go
 * set up ChatGPT OAuth, which is the one thing they were trying to avoid.
 */
export type AlphaSearchSidecarResolution =
  | { status: "ready"; sidecar: ResolvedAlphaSearchSidecar }
  | { status: "unconfigured" }
  | { status: "missing-credential"; backend: AlphaSearchSidecarBackend };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Only the operator's explicit sidecar backend can serve this path, and only with THAT
 * backend's own credential. `openai` is the ChatGPT forward path, which is absent by the
 * time we are here; auto-selecting a different paid backend from leftover keys is how an
 * anthropic-named config would silently spend Exa.
 */
export function resolveAlphaSearchSidecar(config: OcxConfig): AlphaSearchSidecarResolution {
  const sidecar = config.webSearchSidecar;
  // The master switch is the operator saying this sidecar may not run. planWebSearch honors it the
  // same way, and ignoring it here would make `enabled: false` mean "off for the routed loop, on
  // for alpha/search" — the one reading under which a disabled backend still spends money.
  if (sidecar?.enabled === false) return { status: "unconfigured" };
  const backend = resolveSidecarBackend(sidecar?.backend);
  if (backend === "openai") return { status: "unconfigured" };
  switch (backend) {
    case "anthropic": {
      const found = findAnthropicSidecarProvider(config);
      return found
        ? { status: "ready", sidecar: { backend, providerName: found.providerName, provider: found.provider } }
        : { status: "missing-credential", backend };
    }
    case "xai": {
      const found = findXaiSidecarProvider(config);
      return found
        ? { status: "ready", sidecar: { backend, providerName: found.providerName, provider: found.provider } }
        : { status: "missing-credential", backend };
    }
    case "gemini": {
      const found = findGeminiSidecarProvider(config);
      return found
        ? { status: "ready", sidecar: { backend, providerName: found.providerName, provider: found.provider } }
        : { status: "missing-credential", backend };
    }
    case "exa": {
      const apiKey = sidecar?.exaApiKey;
      return typeof apiKey === "string" && apiKey.length > 0
        ? { status: "ready", sidecar: { backend, apiKey } }
        : { status: "missing-credential", backend };
    }
  }
}

function pushQuery(queries: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length === 0 || queries.includes(trimmed)) return;
  if (queries.length < MAX_QUERIES_PER_CALL) queries.push(trimmed.slice(0, MAX_QUERY_CHARS));
}

/**
 * Codex's live-search client sends a Responses-shaped envelope whose primary operation is
 * `commands.search_query: [{ q }]`. Top-level `query` / `q` / `search_query` strings are the
 * fallback for tests and any thinner client; they are consulted only when the envelope form
 * produced nothing usable, so a present-but-empty `search_query` array cannot hide a
 * top-level query the operator actually sent.
 */
export function extractAlphaSearchQueries(body: unknown): string[] {
  const queries: string[] = [];
  if (!isRecord(body)) return queries;
  const searchQuery = isRecord(body.commands) ? body.commands.search_query : undefined;
  if (Array.isArray(searchQuery)) {
    for (const entry of searchQuery) {
      if (isRecord(entry)) pushQuery(queries, entry.q);
    }
  }
  if (queries.length === 0) {
    pushQuery(queries, body.query);
    if (queries.length === 0) pushQuery(queries, body.q);
    if (queries.length === 0) pushQuery(queries, body.search_query);
  }
  return queries;
}

function modelForAlphaSearchBackend(
  backend: AlphaSearchSidecarBackend,
  sidecar: Pick<OcxWebSearchSidecarConfig, "backend" | "model"> | undefined,
): string {
  const backendDefault = DEFAULT_BACKEND_MODELS[backend];
  if (resolveSidecarBackend(sidecar?.backend) !== backend) return backendDefault;
  return sidecar?.model ?? backendDefault;
}

function sidecarSettingsForAlphaSearch(
  backend: AlphaSearchSidecarBackend,
  config: OcxConfig,
): SidecarSettings {
  const sidecar = config.webSearchSidecar;
  return {
    model: modelForAlphaSearchBackend(backend, sidecar),
    reasoning: sidecar?.reasoning ?? DEFAULT_REASONING,
    timeoutMs: config.search?.timeoutMs ?? SEARCH_UPSTREAM_TIMEOUT_MS,
  };
}

async function runAlphaSearchQuery(
  query: string,
  resolved: ResolvedAlphaSearchSidecar,
  settings: SidecarSettings,
  config: OcxConfig,
  signal?: AbortSignal,
): Promise<SidecarOutcome> {
  switch (resolved.backend) {
    case "anthropic":
      return runAnthropicWebSearch(query, resolved.providerName, resolved.provider, settings, signal);
    case "xai":
      return runXaiWebSearch(
        query,
        resolved.providerName,
        resolved.provider,
        settings,
        xaiSearchOptionsFromConfig(config.webSearchSidecar ?? {}),
        signal,
      );
    case "gemini":
      return runGeminiWebSearch(query, resolved.providerName, resolved.provider, settings, signal);
    case "exa":
      return runExaWebSearch(query, resolved.apiKey, settings, signal);
  }
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

export async function handleDevinAlphaSearch(
  body: unknown,
  providerName: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const queries = extractAlphaSearchQueries(body);
  if (queries.length === 0) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Built-in web search request is missing a usable query (commands.search_query, query, q, or search_query).",
    );
  }
  const deadline = signalWithTimeout(timeoutMs, signal);
  try {
    const resolved = await raceAbort(resolveDevinWebSearchSnapshot(providerName), deadline.signal);
    if ("error" in resolved) {
      return formatErrorResponse(502, "upstream_error", `devin web search failed: ${redactSecretString(resolved.error)}`);
    }
    const texts: string[] = [];
    const sources: SidecarOutcome["sources"] = [];
    for (const query of queries) {
      const outcome = await runDevinWebSearch(query, resolved.snapshot, deadline.signal);
      if (outcome.error) {
        if (signal?.aborted) {
          return formatErrorResponse(499, "client_closed_request", "search request canceled by client");
        }
        if (deadline.signal.aborted) {
          return formatErrorResponse(504, "upstream_error", "devin web search timed out");
        }
        const detail = redactSecretString(outcome.error);
        return formatErrorResponse(502, "upstream_error", `devin web search failed: ${detail}`);
      }
      texts.push(queries.length > 1 ? `Results for "${query}":\n${outcome.text}` : outcome.text);
      for (const source of outcome.sources) {
        if (!sources.some(existing => existing.url === source.url)) sources.push(source);
      }
    }
    return new Response(JSON.stringify(formatAlphaSearchBody(texts.join("\n\n"), sources)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    if (signal?.aborted) {
      return formatErrorResponse(499, "client_closed_request", "search request canceled by client");
    }
    if (deadline.signal.aborted) {
      return formatErrorResponse(504, "upstream_error", "devin web search timed out");
    }
    const detail = redactSecretString(error instanceof Error ? error.message : String(error));
    return formatErrorResponse(502, "upstream_error", `devin web search failed: ${detail}`);
  } finally {
    deadline.cleanup();
  }
}

function formatAlphaSearchBody(text: string, sources: SidecarOutcome["sources"]): {
  encrypted_output: null;
  output: string;
  results: Array<{ title: string; url: string }>;
} {
  // Title falls back to the URL so the client always sees both fields; unsafe URLs are
  // dropped entirely rather than echoed into `results`.
  return {
    encrypted_output: null,
    output: text,
    results: safeWebSearchSources(sources).map(source => ({
      url: source.url,
      title: source.title ?? source.url,
    })),
  };
}

const NO_FORWARD_PROVIDER_MESSAGE =
  "Built-in web search needs a ChatGPT forward provider, but none is configured in opencodex. "
  + "Routed and OpenAI API-key providers cannot serve /v1/alpha/search. "
  + "Configure webSearchSidecar.backend (anthropic, xai, gemini, or exa) with that backend's credential instead.";

/**
 * What a named backend is missing, said in the operator's own terms.
 *
 * An operator who already chose a backend does not need to be told to configure ChatGPT auth —
 * that answer is what the request asked this path to stop giving. They need to know which
 * credential the backend they named could not find.
 */
function missingCredentialMessage(backend: AlphaSearchSidecarBackend): string {
  const detail: Record<AlphaSearchSidecarBackend, string> = {
    anthropic: "no usable stored Anthropic OAuth account was found",
    xai: "no usable stored Grok OAuth account was found",
    gemini: "no usable stored Antigravity OAuth account with a discovered project was found",
    exa: "webSearchSidecar.exaApiKey is not set",
  };
  return "Built-in web search is configured to use the " + backend + " backend, but "
    + detail[backend] + ". Restore that backend's credential, or choose another "
    + "webSearchSidecar.backend. This request was not sent to any other backend.";
}

/**
 * Run the named sidecar backend against an alpha/search body. Callers must already know there
 * is no ChatGPT forward candidate — this function does not re-check that, so a mis-call would
 * spend the sidecar even when the relay could have copied bytes.
 */
export async function handleAlphaSearchSidecarFallback(
  body: unknown,
  config: OcxConfig,
  signal?: AbortSignal,
  logCtx?: { provider: string },
  admission?: DataPlaneAdmission,
): Promise<Response> {
  const resolution = resolveAlphaSearchSidecar(config);
  if (resolution.status === "missing-credential") {
    // Never the ChatGPT-auth sentence here: the operator already named a backend, so the honest
    // answer names what that backend is missing.
    if (logCtx) logCtx.provider = resolution.backend;
    return formatErrorResponse(400, "invalid_request_error", missingCredentialMessage(resolution.backend));
  }
  if (resolution.status !== "ready") {
    return formatErrorResponse(400, "invalid_request_error", NO_FORWARD_PROVIDER_MESSAGE);
  }
  const resolved = resolution.sidecar;
  if (logCtx) logCtx.provider = resolved.backend;

  // This backend is a paid destination like any other, and the operator's
  // configuration -- not the caller -- decides which one and which model. A key
  // scoped away from it must not spend it by asking the search endpoint instead
  // of the inference one. Exa has no configured provider entry, so its own
  // backend name is the destination.
  const settings = sidecarSettingsForAlphaSearch(resolved.backend, config);
  const requestedModel = (body as { model?: unknown } | null)?.model;
  const denial = admissionScopeDenial(
    config,
    admission,
    typeof requestedModel === "string" && requestedModel.trim() ? requestedModel : undefined,
    {
      providerName: resolved.backend === "exa" ? resolved.backend : resolved.providerName,
      modelId: settings.model,
    },
  );
  if (denial) return denial;

  const queries = extractAlphaSearchQueries(body);
  if (queries.length === 0) {
    return formatErrorResponse(
      400,
      "invalid_request_error",
      "Built-in web search request is missing a usable query (commands.search_query, query, q, or search_query).",
    );
  }

  const sidecarExit = sidecarEnter("search");
  try {
    const texts: string[] = [];
    const sources: SidecarOutcome["sources"] = [];
    const errors: string[] = [];
    for (const query of queries) {
      if (signal?.aborted) break;
      const outcome = await runAlphaSearchQuery(query, resolved, settings, config, signal);
      if (outcome.error) {
        errors.push(outcome.error);
        continue;
      }
      texts.push(queries.length > 1 ? `Results for "${query}":\n${outcome.text}` : outcome.text);
      for (const source of outcome.sources) {
        if (!sources.some(existing => existing.url === source.url)) sources.push(source);
      }
    }
    if (signal?.aborted) {
      return formatErrorResponse(499, "client_closed_request", "search request canceled by client");
    }
    if (texts.length === 0) {
      const detail = redactSecretString(errors[0] ?? "web search produced no results");
      return formatErrorResponse(
        502,
        "upstream_error",
        resolved.backend + " web search failed: " + detail,
      );
    }
    return new Response(JSON.stringify(formatAlphaSearchBody(texts.join("\n\n"), sources)), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    if (signal?.aborted) {
      return formatErrorResponse(499, "client_closed_request", "search request canceled by client");
    }
    const detail = redactSecretString(err instanceof Error ? err.message : String(err));
    return formatErrorResponse(
      502,
      "upstream_error",
      resolved.backend + " web search failed: " + detail,
    );
  } finally {
    sidecarExit();
  }
}
