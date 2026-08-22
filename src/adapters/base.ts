import type { AdapterEvent, OcxParsedRequest } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import type { AdapterTierMetadata } from "../providers/fastwire";

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
  translatorBudget: TranslatorBudget;
  abortSignal?: AbortSignal;
  /**
   * Provider-scoped fetch prepared by the Responses router. Stateful transports that emit more
   * than one physical HTTP request per logical turn must reuse it so every request participates in
   * the same pacing queue and custom provider fetch seam.
   */
  providerFetch?: typeof globalThis.fetch;
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

  /**
   * Parse one upstream response. `tierMetadata` is the same live observer returned on the
   * corresponding AdapterRequest; adapters that receive a documented tier echo may update it.
   */
  parseStream(
    response: Response,
    budget: TranslatorBudget,
    tierMetadata?: AdapterTierMetadata,
  ): AsyncGenerator<AdapterEvent>;
  parseResponse?(
    response: Response,
    budget: TranslatorBudget,
    tierMetadata?: AdapterTierMetadata,
  ): Promise<AdapterEvent[]>;
  runTurn?(
    parsed: OcxParsedRequest,
    incoming: IncomingMeta,
    emit: (event: AdapterEvent) => void,
  ): Promise<void>;

  /** Exact no-field observation for runTurn adapters, which expose no AdapterRequest object. */
  tierLogForRunTurn?(parsed: OcxParsedRequest): AdapterTierMetadata | undefined;
}

export interface AdapterRequest {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
    /** Final upstream wire names of custom tools lowered to functions while building this request. */
    convertedRoutedCustomToolNames?: ReadonlySet<string>;
    /** Client tool-search names actually lowered to upstream function calls for this request. */
    convertedRoutedToolSearchNames?: ReadonlySet<string>;
    /** Upstream-only aliases for namespace tools flattened in this request. */
    convertedRoutedNamespaceToolAliases?: ReadonlyMap<string, { namespace: string; name: string }>;
    /** Releases observation of a serialized request body after its final fetch attempt settles. */
    releaseBodyObservation?: () => void;
    /** Exact reasoning parameter emitted by the adapter, for request-log diagnostics only. */
    reasoningLog?:
      | {
          effectiveEffort: string;
          wireField: "reasoning.enabled";
          wireValue: boolean;
        }
      | {
          effectiveEffort: string;
          wireField: "thinking_budget";
          wireValue: number;
        }
      | {
          effectiveEffort: string;
          wireField: "reasoning_effort" | "reasoning.effort" | "thinking.type";
          wireValue: string;
        };
    /**
     * Exact tier outcome seeded after this adapter serialized the outbound request.
     * This is a live shared observer: response-phase methods mutate `outcome`, so retain
     * the reference rather than cloning or snapshotting it.
     */
    tierLog?: AdapterTierMetadata;
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
  /** Custom fetch executor to use for physical upstream network requests (defaults to globalThis.fetch). */
  executor?: typeof globalThis.fetch;
}
