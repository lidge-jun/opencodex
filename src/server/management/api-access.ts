import type { OcxConfig } from "../../types";

export interface ApiAccessEndpoints {
  baseUrl: string;
  responsesEndpoint: string;
  chatCompletionsEndpoint: string;
  messagesEndpoint: string;
  modelsEndpoint: string;
  /** Back-compat alias for older GUI clients. */
  endpoint: string;
}

export function buildApiAccessEndpoints(config: OcxConfig): ApiAccessEndpoints {
  const host = config.hostname ?? "127.0.0.1";
  const port = config.port ?? 10100;
  const baseUrl = `http://${host}:${port}/v1`;
  const responsesEndpoint = `${baseUrl}/responses`;
  return {
    baseUrl,
    responsesEndpoint,
    chatCompletionsEndpoint: `${baseUrl}/chat/completions`,
    messagesEndpoint: `${baseUrl}/messages`,
    modelsEndpoint: `${baseUrl}/models`,
    endpoint: responsesEndpoint,
  };
}

