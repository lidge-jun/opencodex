import type { GatewayConfig } from "../config";

export interface RelayContext {
  requestId: string;
  clientSignal: AbortSignal;
  upstreamSignal: AbortSignal;
  callerAborted: () => boolean;
  clientTimedOut: () => boolean;
  upstreamTimedOut: () => boolean;
  config: GatewayConfig;
}

export interface OpenAiRelay {
  handleChatCompletions(request: Request, context: RelayContext): Promise<Response>;
}

export interface AnthropicRelay {
  handleMessages(request: Request, context: RelayContext): Promise<Response>;
}

export interface GatewayRelayDeps {
  openAiRelay?: OpenAiRelay;
  anthropicRelay?: AnthropicRelay;
}

export { buildOpenAiUpstreamHeaders, buildAnthropicUpstreamHeaders } from "./upstream-headers";
