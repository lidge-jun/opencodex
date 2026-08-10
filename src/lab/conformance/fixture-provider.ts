import type { OcxProviderConfig } from "../../types";

export function fixtureProviderConfig(adapter: string): OcxProviderConfig {
  return {
    adapter,
    // The Chat fixture intentionally exercises native OpenAI Chat semantics (including
    // role:"developer" and named single-tool selection). Other fixture adapters remain
    // loopback-only and never perform network I/O.
    baseUrl: adapter === "openai-chat" ? "https://api.openai.com/v1" : "http://127.0.0.1:1/v1",
    apiKey: "fixture-key",
    allowPrivateNetwork: true,
    models: ["fixture-model"],
    defaultModel: "fixture-model",
    liveModels: false,
  };
}

export function upstreamAdapterForProtocol(protocol: string): string {
  switch (protocol) {
    case "openai-chat":
      return "openai-chat";
    case "openai-responses":
      return "openai-responses";
    default:
      throw new Error(`unsupported upstream protocol: ${protocol}`);
  }
}
