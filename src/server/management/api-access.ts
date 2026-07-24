import type { OcxConfig } from "../../types";
import { probeHostname } from "../proxy-liveness";

export interface ApiAccessEndpoints {
  baseUrl: string;
  responsesEndpoint: string;
  chatCompletionsEndpoint: string;
  messagesEndpoint: string;
  modelsEndpoint: string;
  claudeCodeEnabled: boolean;
  /** Back-compat alias for older GUI clients. */
  endpoint: string;
}

export function buildApiAccessEndpoints(config: OcxConfig): ApiAccessEndpoints {
  const port = config.port ?? 10100;
  const displayHost = probeHostname(config.hostname);
  const baseUrl = `http://${displayHost}:${port}/v1`;
  const responsesEndpoint = `${baseUrl}/responses`;
  return {
    baseUrl,
    responsesEndpoint,
    chatCompletionsEndpoint: `${baseUrl}/chat/completions`,
    messagesEndpoint: `${baseUrl}/messages`,
    modelsEndpoint: `${baseUrl}/models`,
    claudeCodeEnabled: config.claudeCode?.enabled !== false,
    endpoint: responsesEndpoint,
  };
}
