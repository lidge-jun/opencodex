import { describe, expect, test } from "bun:test";
import { loadGatewayConfigFromEnv } from "../src/config";
import {
  MAX_CONFIG_CONCURRENT,
  MAX_CONFIG_HEADER_BYTES,
  MAX_CONFIG_PORT,
  MAX_CONFIG_REQUEST_BYTES,
  MAX_CONFIG_TIMEOUT_MS,
  MIN_CONFIG_CONCURRENT,
  MIN_CONFIG_HEADER_BYTES,
  MIN_CONFIG_PORT,
  MIN_CONFIG_REQUEST_BYTES,
  MIN_CONFIG_TIMEOUT_MS,
} from "../src/constants";

const VALID_ENV = {
  REPLIT_GATEWAY_KEY: "a".repeat(32),
  REPLIT_GATEWAY_PUBLIC_ORIGIN: "https://my-app.replit.app",
  REPLIT_GATEWAY_OPENAI_MODELS: "gpt-4o,gpt-4o-mini",
  REPLIT_GATEWAY_ANTHROPIC_MODELS: "claude-sonnet-4-6",
  AI_INTEGRATIONS_OPENAI_BASE_URL: "https://integrations.replit.com/openai/v1",
  AI_INTEGRATIONS_OPENAI_API_KEY: "replit-openai-secret",
  AI_INTEGRATIONS_ANTHROPIC_BASE_URL: "https://integrations.replit.com/anthropic",
  AI_INTEGRATIONS_ANTHROPIC_API_KEY: "replit-anthropic-secret",
  PORT: "8080",
};

describe("loadGatewayConfigFromEnv", () => {
  test("loads a valid configuration", () => {
    const config = loadGatewayConfigFromEnv(VALID_ENV);
    expect(config.publicOrigin).toBe("https://my-app.replit.app");
    expect(config.gatewayKey).toBe("a".repeat(32));
    expect(config.openai.allowedModels).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(config.anthropic.allowedModels).toEqual(["claude-sonnet-4-6"]);
    expect(config.port).toBe(8080);
  });

  test("fails when gateway key is missing", () => {
    const { REPLIT_GATEWAY_KEY: _ignored, ...env } = VALID_ENV;
    expect(() => loadGatewayConfigFromEnv(env)).toThrow(/REPLIT_GATEWAY_KEY/);
  });

  test("fails when gateway key is too short", () => {
    expect(() => loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_KEY: "short",
    })).toThrow(/at least 32/);
  });

  test("fails when gateway key exceeds the maximum length", () => {
    expect(() => loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_KEY: "a".repeat(513),
    })).toThrow(/at most 512/);
  });

  test("fails when gateway key contains non-printable characters", () => {
    expect(() => loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_KEY: `${"a".repeat(16)}\n${"a".repeat(16)}`,
    })).toThrow(/invalid/i);
    expect(() => loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_KEY: "key with spaces 012345678901234567890123456",
    })).toThrow(/printable ASCII/i);
  });

  test("accepts gateway keys at the documented length boundaries", () => {
    expect(loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_KEY: "!".repeat(512),
    }).gatewayKey).toBe("!".repeat(512));
  });

  test("fails when public origin is not https", () => {
    expect(() => loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_PUBLIC_ORIGIN: "http://my-app.replit.app",
    })).toThrow(/https/i);
  });

  test("fails when AI integration credentials are missing", () => {
    const { AI_INTEGRATIONS_OPENAI_API_KEY: _ignored, ...env } = VALID_ENV;
    expect(() => loadGatewayConfigFromEnv(env)).toThrow(/AI_INTEGRATIONS_OPENAI_API_KEY/);
  });

  test("fails when model allowlists are empty", () => {
    expect(() => loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_OPENAI_MODELS: "",
    })).toThrow(/REPLIT_GATEWAY_OPENAI_MODELS/);
  });

  test("rejects duplicate model ids in allowlists", () => {
    expect(() => loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_OPENAI_MODELS: "gpt-4o,gpt-4o",
    })).toThrow(/duplicate/i);
  });

  test("rejects upstream base URLs that are not https", () => {
    expect(() => loadGatewayConfigFromEnv({
      ...VALID_ENV,
      AI_INTEGRATIONS_OPENAI_BASE_URL: "http://integrations.replit.com/openai/v1",
    })).toThrow(/https/i);
  });

  test("rejects permissive numeric overrides", () => {
    expect(() => loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_MAX_REQUEST_BYTES: "1e9",
    })).toThrow(/decimal integer/i);
    expect(() => loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_MAX_CONCURRENT: "1000junk",
    })).toThrow(/decimal integer/i);
  });

  test("requires client timeout to be at least upstream timeout", () => {
    expect(() => loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS: "5000",
      REPLIT_GATEWAY_CLIENT_TIMEOUT_MS: "1000",
    })).toThrow(/client timeout/i);
  });

  test("canonicalizes public origin on load", () => {
    const config = loadGatewayConfigFromEnv({
      ...VALID_ENV,
      REPLIT_GATEWAY_PUBLIC_ORIGIN: "https://my-app.replit.app/",
    });
    expect(config.publicOrigin).toBe("https://my-app.replit.app");
  });

  describe("numeric env bounds", () => {
    test("PORT rejects below minimum and above maximum", () => {
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        PORT: String(MIN_CONFIG_PORT - 1),
      })).toThrow(/PORT must be between/);
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        PORT: String(MAX_CONFIG_PORT + 1),
      })).toThrow(/PORT must be between/);
    });

    test("PORT accepts exact boundary values", () => {
      expect(loadGatewayConfigFromEnv({
        ...VALID_ENV,
        PORT: String(MIN_CONFIG_PORT),
      }).port).toBe(MIN_CONFIG_PORT);
      expect(loadGatewayConfigFromEnv({
        ...VALID_ENV,
        PORT: String(MAX_CONFIG_PORT),
      }).port).toBe(MAX_CONFIG_PORT);
    });

    test("REPLIT_GATEWAY_MAX_REQUEST_BYTES rejects below minimum and above maximum", () => {
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_REQUEST_BYTES: String(MIN_CONFIG_REQUEST_BYTES - 1),
      })).toThrow(/REPLIT_GATEWAY_MAX_REQUEST_BYTES must be between/);
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_REQUEST_BYTES: String(MAX_CONFIG_REQUEST_BYTES + 1),
      })).toThrow(/REPLIT_GATEWAY_MAX_REQUEST_BYTES must be between/);
    });

    test("REPLIT_GATEWAY_MAX_REQUEST_BYTES accepts exact boundary values", () => {
      const atMin = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_REQUEST_BYTES: String(MIN_CONFIG_REQUEST_BYTES),
      });
      expect(atMin.limits.maxRequestBytes).toBe(MIN_CONFIG_REQUEST_BYTES);

      const atMax = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_REQUEST_BYTES: String(MAX_CONFIG_REQUEST_BYTES),
      });
      expect(atMax.limits.maxRequestBytes).toBe(MAX_CONFIG_REQUEST_BYTES);
    });

    test("REPLIT_GATEWAY_MAX_HEADER_BYTES rejects below minimum and above maximum", () => {
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_HEADER_BYTES: String(MIN_CONFIG_HEADER_BYTES - 1),
      })).toThrow(/REPLIT_GATEWAY_MAX_HEADER_BYTES must be between/);
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_HEADER_BYTES: String(MAX_CONFIG_HEADER_BYTES + 1),
      })).toThrow(/REPLIT_GATEWAY_MAX_HEADER_BYTES must be between/);
    });

    test("REPLIT_GATEWAY_MAX_HEADER_BYTES accepts exact boundary values", () => {
      const atMin = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_HEADER_BYTES: String(MIN_CONFIG_HEADER_BYTES),
      });
      expect(atMin.limits.maxHeaderBytes).toBe(MIN_CONFIG_HEADER_BYTES);

      const atMax = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_HEADER_BYTES: String(MAX_CONFIG_HEADER_BYTES),
      });
      expect(atMax.limits.maxHeaderBytes).toBe(MAX_CONFIG_HEADER_BYTES);
    });

    test("REPLIT_GATEWAY_MAX_CONCURRENT rejects below minimum and above maximum", () => {
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_CONCURRENT: String(MIN_CONFIG_CONCURRENT - 1),
      })).toThrow(/REPLIT_GATEWAY_MAX_CONCURRENT must be between/);
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_CONCURRENT: String(MAX_CONFIG_CONCURRENT + 1),
      })).toThrow(/REPLIT_GATEWAY_MAX_CONCURRENT must be between/);
    });

    test("REPLIT_GATEWAY_MAX_CONCURRENT accepts exact boundary values", () => {
      const atMin = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_CONCURRENT: String(MIN_CONFIG_CONCURRENT),
      });
      expect(atMin.limits.maxConcurrentRequests).toBe(MIN_CONFIG_CONCURRENT);

      const atMax = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_MAX_CONCURRENT: String(MAX_CONFIG_CONCURRENT),
      });
      expect(atMax.limits.maxConcurrentRequests).toBe(MAX_CONFIG_CONCURRENT);
    });

    test("REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS rejects below minimum and above maximum", () => {
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS: String(MIN_CONFIG_TIMEOUT_MS - 1),
      })).toThrow(/REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS must be between/);
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS: String(MAX_CONFIG_TIMEOUT_MS + 1),
      })).toThrow(/REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS must be between/);
    });

    test("REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS accepts exact boundary values", () => {
      const atMin = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS: String(MIN_CONFIG_TIMEOUT_MS),
        REPLIT_GATEWAY_CLIENT_TIMEOUT_MS: String(MIN_CONFIG_TIMEOUT_MS),
      });
      expect(atMin.limits.upstreamTimeoutMs).toBe(MIN_CONFIG_TIMEOUT_MS);

      const atMax = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS: String(MAX_CONFIG_TIMEOUT_MS),
        REPLIT_GATEWAY_CLIENT_TIMEOUT_MS: String(MAX_CONFIG_TIMEOUT_MS),
      });
      expect(atMax.limits.upstreamTimeoutMs).toBe(MAX_CONFIG_TIMEOUT_MS);
    });

    test("REPLIT_GATEWAY_CLIENT_TIMEOUT_MS rejects below minimum and above maximum", () => {
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_CLIENT_TIMEOUT_MS: String(MIN_CONFIG_TIMEOUT_MS - 1),
      })).toThrow(/REPLIT_GATEWAY_CLIENT_TIMEOUT_MS must be between/);
      expect(() => loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_CLIENT_TIMEOUT_MS: String(MAX_CONFIG_TIMEOUT_MS + 1),
      })).toThrow(/REPLIT_GATEWAY_CLIENT_TIMEOUT_MS must be between/);
    });

    test("REPLIT_GATEWAY_CLIENT_TIMEOUT_MS accepts exact boundary values", () => {
      const atMin = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS: String(MIN_CONFIG_TIMEOUT_MS),
        REPLIT_GATEWAY_CLIENT_TIMEOUT_MS: String(MIN_CONFIG_TIMEOUT_MS),
      });
      expect(atMin.limits.clientTimeoutMs).toBe(MIN_CONFIG_TIMEOUT_MS);

      const atMax = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS: String(MIN_CONFIG_TIMEOUT_MS),
        REPLIT_GATEWAY_CLIENT_TIMEOUT_MS: String(MAX_CONFIG_TIMEOUT_MS),
      });
      expect(atMax.limits.clientTimeoutMs).toBe(MAX_CONFIG_TIMEOUT_MS);
    });

    test("accepts client timeout equal to upstream timeout", () => {
      const config = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS: "5000",
        REPLIT_GATEWAY_CLIENT_TIMEOUT_MS: "5000",
      });
      expect(config.limits.upstreamTimeoutMs).toBe(5000);
      expect(config.limits.clientTimeoutMs).toBe(5000);
    });

    test("accepts client timeout greater than upstream timeout", () => {
      const config = loadGatewayConfigFromEnv({
        ...VALID_ENV,
        REPLIT_GATEWAY_UPSTREAM_TIMEOUT_MS: "5000",
        REPLIT_GATEWAY_CLIENT_TIMEOUT_MS: "6000",
      });
      expect(config.limits.upstreamTimeoutMs).toBe(5000);
      expect(config.limits.clientTimeoutMs).toBe(6000);
    });
  });
});
