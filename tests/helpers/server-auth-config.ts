import type { OcxConfig } from "../../src/types";

export function serverAuthConfig(hostname?: string): OcxConfig {
  return {
    port: 10100,
    hostname,
    defaultProvider: "openai",
    providers: {
      openai: {
        adapter: "openai-chat",
        baseUrl: "https://api.example.test/v1",
        apiKey: "sk-secret-value",
        headers: { "X-Custom": "provider-secret" },
        defaultModel: "gpt-test",
      },
    },
  };
}
