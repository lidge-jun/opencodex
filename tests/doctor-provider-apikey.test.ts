import { describe, expect, test } from "bun:test";
import { collectProviderApiKeyDiagnostics } from "../src/cli/doctor";

const prototypePropertyNames = [
  "toString",
  "valueOf",
  "constructor",
  "hasOwnProperty",
  "__proto__",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
] as const;

describe("doctor provider apiKey env diagnostics (#762)", () => {
  test("warns when a key-auth env reference resolves empty without printing secrets", () => {
    const rows = collectProviderApiKeyDiagnostics({
      openrouter: {
        authMode: "key",
        apiKey: "${OPENROUTER_API_KEY}",
      },
    }, {});
    expect(rows).toEqual([{
      provider: "openrouter",
      envName: "OPENROUTER_API_KEY",
      detail: "provider openrouter: env reference OPENROUTER_API_KEY is unset or empty in this process",
    }]);
  });

  test("passes when the referenced env var is set", () => {
    const rows = collectProviderApiKeyDiagnostics({
      openrouter: {
        authMode: "key",
        apiKey: "${OPENROUTER_API_KEY}",
      },
    }, { OPENROUTER_API_KEY: "secret-value" });
    expect(rows).toEqual([]);
  });

  test.each(prototypePropertyNames)("diagnoses inherited env reference $%s instead of throwing", (envName) => {
    const rows = collectProviderApiKeyDiagnostics({
      openrouter: {
        authMode: "key",
        apiKey: `$${envName}`,
      },
    }, {});

    expect(rows).toEqual([{
      provider: "openrouter",
      envName,
      detail: `provider openrouter: env reference ${envName} is unset or empty in this process`,
    }]);
  });

  test("ignores literal keys and non-key providers", () => {
    const rows = collectProviderApiKeyDiagnostics({
      openrouter: { authMode: "key", apiKey: "sk-live-not-an-env-ref" },
      openai: { authMode: "forward", apiKey: "${SHOULD_NOT_MATTER}" },
    }, {});
    expect(rows).toEqual([]);
  });
});
