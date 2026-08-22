import { describe, expect, test } from "bun:test";
import { redactGatewaySecrets, containsAiIntegrationsSecret } from "../src/secrets";

describe("secret redaction", () => {
  test("detects AI_INTEGRATIONS secret material", () => {
    expect(containsAiIntegrationsSecret("AI_INTEGRATIONS_OPENAI_API_KEY")).toBe(true);
    expect(containsAiIntegrationsSecret("REPLIT_GATEWAY_KEY")).toBe(false);
  });

  test("never returns raw integration credentials in redacted output", () => {
    const secret = "replit-managed-upstream-key-value";
    const text = `failed upstream auth AI_INTEGRATIONS_ANTHROPIC_API_KEY=${secret}`;
    expect(redactGatewaySecrets(text)).not.toContain(secret);
  });
});
