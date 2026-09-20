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
    // The wire role is no longer read from the hostname, and an undeclared destination folds
    // `developer` to `system` because one that rejects the role answers 400 and the turn never
    // starts. This fixture is the one place that asserts the forwarded role, so the destination
    // it stands for records that it accepts it. Only the Chat adapter reaches that decision.
    ...(adapter === "openai-chat" ? { foldDeveloperRoleToSystem: false } : {}),
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
