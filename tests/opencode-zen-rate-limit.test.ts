import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import {
  OPENCODE_ZEN_OBSERVED_RPM_HINT,
  OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC,
  enrichOpenCodeZenRateLimitMessage,
  isOpenCodeZenRateLimitProvider,
} from "../src/providers/opencode-zen-rate-limit";
import { resolveClientRetryAfter } from "../src/lib/retry-after";
import { safeConfigDTO } from "../src/server/auth-cors";
import type { OcxConfig } from "../src/types";

describe("opencode-zen rate-limit guidance (#1145)", () => {
  test("registry note documents the observed short-window RPM", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-zen");
    expect(entry?.note).toBeDefined();
    expect(entry!.note!.toLowerCase()).toContain("15-20");
    expect(entry!.note!.toLowerCase()).toContain("retry-after");
    expect(entry!.note!.toLowerCase()).toMatch(/may return|when retry-after is omitted/);
    expect(entry!.note!.toLowerCase()).toContain("opencode-free");
  });

  test("opencode-free note cross-references the short-window RPM", () => {
    const entry = PROVIDER_REGISTRY.find(e => e.id === "opencode-free");
    expect(entry?.note?.toLowerCase()).toContain("200");
    expect(entry?.note?.toLowerCase()).toContain("15-20");
  });

  test("safeConfigDTO surfaces the registry note for a saved opencode-zen row", () => {
    const dto = safeConfigDTO({
      port: 10100,
      hostname: "127.0.0.1",
      defaultProvider: "opencode-zen",
      providers: {
        "opencode-zen": {
          adapter: "openai-chat",
          baseUrl: "https://opencode.ai/zen/v1",
          authMode: "key",
          apiKey: "zen-key",
        },
      },
    } as OcxConfig) as {
      providers: Record<string, { note?: string }>;
    };

    expect(dto.providers["opencode-zen"].note?.toLowerCase()).toContain("15-20");
  });

  test("isOpenCodeZenRateLimitProvider matches zen, free, and destination aliases", () => {
    expect(isOpenCodeZenRateLimitProvider({ providerName: "opencode-zen" })).toBe(true);
    expect(isOpenCodeZenRateLimitProvider({ providerName: "opencode-free" })).toBe(true);
    expect(isOpenCodeZenRateLimitProvider({ providerName: "openai" })).toBe(false);
    expect(isOpenCodeZenRateLimitProvider({
      baseUrl: "https://opencode.ai/zen/v1",
      adapter: "openai-chat",
    })).toBe(true);
    expect(isOpenCodeZenRateLimitProvider({
      baseUrl: "https://opencode.ai/zen/go/v1",
      adapter: "openai-chat",
    })).toBe(false);
  });

  test("enrichOpenCodeZenRateLimitMessage adds guidance and a parseable retry hint", () => {
    const enriched = enrichOpenCodeZenRateLimitMessage(
      "Provider error 429: Rate limit exceeded. Please try again later.",
      { status: 429, providerName: "opencode-zen", hasApiKey: true },
    );
    expect(enriched).toContain(OPENCODE_ZEN_OBSERVED_RPM_HINT);
    expect(enriched).toContain(`Try again in ${OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC}s`);
    expect(enriched).toContain("retryOn429");
    expect(resolveClientRetryAfter({
      status: 429,
      message: enriched,
    })).toBe(String(OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC));
  });

  test("enrichOpenCodeZenRateLimitMessage skips synthetic hint when upstream Retry-After is set", () => {
    const enriched = enrichOpenCodeZenRateLimitMessage(
      "Provider error 429: Rate limit exceeded.",
      {
        status: 429,
        providerName: "opencode-zen",
        hasApiKey: true,
        upstreamRetryAfter: "120",
      },
    );
    expect(enriched).toContain(OPENCODE_ZEN_OBSERVED_RPM_HINT);
    expect(enriched).not.toContain(`Try again in ${OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC}s`);
    expect(resolveClientRetryAfter({
      status: 429,
      message: enriched,
      upstreamRetryAfter: "120",
    })).toBe("120");
  });

  test("enrichOpenCodeZenRateLimitMessage omits retryOn429 tip on keyless or non-HTTP routes", () => {
    const keyless = enrichOpenCodeZenRateLimitMessage(
      "Provider error 429: Rate limit exceeded.",
      { status: 429, providerName: "opencode-free", hasApiKey: false },
    );
    expect(keyless).toContain("Slow the request pace.");
    expect(keyless).not.toContain("retryOn429");

    const runTurn = enrichOpenCodeZenRateLimitMessage(
      "Provider error 429: Rate limit exceeded.",
      {
        status: 429,
        providerName: "opencode-zen",
        hasApiKey: true,
        supportsHttpSameKeyRetry: false,
      },
    );
    expect(runTurn).not.toContain("retryOn429");
  });

  test("enrichOpenCodeZenRateLimitMessage is a no-op for other providers and non-429s", () => {
    const other = "Provider error 429: Rate limit exceeded. Please try again later.";
    expect(enrichOpenCodeZenRateLimitMessage(other, {
      status: 429,
      providerName: "openrouter",
    })).toBe(other);
    expect(enrichOpenCodeZenRateLimitMessage("Provider error 500: boom", {
      status: 500,
      providerName: "opencode-zen",
    })).toBe("Provider error 500: boom");
  });

  test("enrichOpenCodeZenRateLimitMessage does not double-append", () => {
    const once = enrichOpenCodeZenRateLimitMessage(
      "Provider error 429: Rate limit exceeded.",
      { status: 429, providerName: "opencode-zen", hasApiKey: true },
    );
    expect(enrichOpenCodeZenRateLimitMessage(once, {
      status: 429,
      providerName: "opencode-zen",
      hasApiKey: true,
    })).toBe(once);
  });
});
