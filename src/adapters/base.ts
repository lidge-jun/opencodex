import type { AdapterEvent, OcxParsedRequest } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
  translatorBudget: TranslatorBudget;
  abortSignal?: AbortSignal;
  /**
   * Image-normalization ladder bias for upstream-413 tightened retries: every image
   * starts one tier lower (devlog/260714_image_normalization_pipeline/030). Only the
   * anthropic adapter consumes it; others ignore it.
   */
  imageTierBias?: number;
}

export interface ProviderAdapter {
  name: string;

  /**
   * Convert an already-read provider HTTP error into client-safe text. This hook must be pure and
   * return fully redacted output: callers may pass untrusted provider headers and payload text.
   */
  formatErrorBody?(status: number, headers: Headers, payloadText: string): string;

  /**
   * Build the upstream request. May be async: adapters that resolve a short-lived credential
   * (e.g. Vertex AI ADC token) return a Promise. Sync adapters return the object directly; callers
   * must `await` the result (awaiting a non-Promise is a no-op).
   */
  buildRequest(parsed: OcxParsedRequest, incoming: IncomingMeta): AdapterRequest | Promise<AdapterRequest>;

  fetchResponse?(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response>;

  parseStream(response: Response, budget: TranslatorBudget): AsyncGenerator<AdapterEvent>;
  parseResponse?(response: Response, budget: TranslatorBudget): Promise<AdapterEvent[]>;
  runTurn?(
    parsed: OcxParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;
}

export interface AdapterRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    /** Releases observation of a serialized request body after its final fetch attempt settles. */
    releaseBodyObservation?: () => void;
    /** Exact reasoning parameter emitted by the adapter, for request-log diagnostics only. */
    reasoningLog?: {
      effectiveEffort: string;
      wireField: "reasoning_effort" | "thinking_budget" | "thinking.type";
      wireValue: string | number;
    };
    usageLog?: {
      inputTokens?: number;
      estimated?: boolean;
    };
}

export interface AdapterFetchContext {
  /** Remains attached to the returned response body after the response headers arrive. */
  abortSignal?: AbortSignal;
  /** Deadline for receiving response headers on each attempt, not for consuming the response body. */
  timeoutMs?: number;
  /** Return final non-2xx responses untouched so the caller can own the error-body read. */
  returnRawErrors?: boolean;
  /** Whether the upstream response will be consumed as a stream; adapters may select low-latency transport settings. */
  stream?: boolean;
}
