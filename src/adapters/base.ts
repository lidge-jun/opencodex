import type { AdapterEvent, OcxParsedRequest } from "../types";

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
  abortSignal?: AbortSignal;
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
  buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta): AdapterRequest | Promise<AdapterRequest>;

  fetchResponse?(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response>;

  parseStream(response: Response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response: Response): Promise<AdapterEvent[]>;
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
}
