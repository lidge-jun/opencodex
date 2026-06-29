import type { AdapterEvent, OcxParsedRequest } from "../types";

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
}

export interface ProviderAdapter {
  name: string;

  /**
   * Build the upstream request. May be async: adapters that resolve a short-lived credential
   * (e.g. Vertex AI ADC token) return a Promise. Sync adapters return the object directly; callers
   * must `await` the result (awaiting a non-Promise is a no-op).
   */
  buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta): AdapterRequest | Promise<AdapterRequest>;

  fetchResponse?(request: AdapterRequest, ctx?: AdapterFetchContext): Promise<Response>;

  parseStream(response: Response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response: Response): Promise<AdapterEvent[]>;
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
  abortSignal?: AbortSignal;
  timeoutMs?: number;
}
