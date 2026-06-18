import type { AdapterEvent, OcxParsedRequest } from "../types";

/** Metadata about the caller's incoming request, for auth-forwarding adapters. */
export interface IncomingMeta {
  headers: Headers;
}

export interface ProviderAdapter {
  name: string;

  buildRequest(parsed: OcxParsedRequest, incoming?: IncomingMeta): {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  };

  parseStream(response: Response): AsyncGenerator<AdapterEvent>;
  parseResponse?(response: Response): Promise<AdapterEvent[]>;
}
