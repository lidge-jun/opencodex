import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import {
  OPENCODE_ZEN_OBSERVED_RPM_HINT,
  OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC,
  enrichOpenCodeZenFreeTierMessage,
  enrichOpenCodeZenRateLimitMessage,
  enrichOpenCodeZenUpstreamMessage,
  isOpenCodeZenFreeTierLockIn,
  isOpenCodeZenRateLimitProvider,
} from "../../src/providers/opencode-zen-rate-limit";
import { resolveClientRetryAfter } from "../../src/lib/retry-after";
import { safeConfigDTO } from "../../src/server/auth-cors";
import type { OcxConfig } from "../../src/types";

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

/**
 * Zen closed the keyless tier to non-OpenCode clients. The gate is the mere presence of
 * `x-opencode-session`, so opencodex could pass it by inventing a value; it does not, and the
 * user-facing failure has to say that rather than leaking `MissingSessionID` through.
 */
describe("opencode-free keyless tier lock-in (#4121)", () => {
  /** Verbatim upstream body from the issue, as the Responses wire forwards it. */
  const RAW_UPSTREAM = String.raw`{"type":"error","error":{"type":"MissingSessionID","message":"Error from provider (Console): OpenCode's free tier can only be used in OpenCode"}}`;
  const FREE_TIER_ROUTE = {
    providerName: "opencode-free",
    baseUrl: "https://opencode.ai/zen/v1",
    adapter: "openai-chat",
  };

  test("registry note states the gate, the refusal to impersonate, and the keyed alternative", () => {
    const note = PROVIDER_REGISTRY.find(e => e.id === "opencode-free")?.note?.toLowerCase();
    expect(note).toBeDefined();
    expect(note).toContain("x-opencode-session");
    expect(note).toContain("missingsessionid");
    expect(note).toContain("opencode-zen");
    // The quota figures the preset already documented must survive the rewrite.
    expect(note).toContain("200");
    expect(note).toContain("15-20");
  });

  test("isOpenCodeZenFreeTierLockIn recognises both the raw body and the parsed error type", () => {
    expect(isOpenCodeZenFreeTierLockIn(RAW_UPSTREAM)).toBe(true);
    // Native Chat parses the envelope, so the marker survives only in `error.type`.
    expect(isOpenCodeZenFreeTierLockIn(
      "Provider error 400: Error from provider (Console)",
      "MissingSessionID",
    )).toBe(true);
    expect(isOpenCodeZenFreeTierLockIn(
      "Provider error 400: OpenCode's free tier can only be used in OpenCode",
    )).toBe(true);
    expect(isOpenCodeZenFreeTierLockIn("Provider error 500: boom")).toBe(false);
    expect(isOpenCodeZenFreeTierLockIn("Provider error 500: boom", "server_error")).toBe(false);
  });

  test("the client error explains the gate and names the supported keyed route", () => {
    const enriched = enrichOpenCodeZenFreeTierMessage(
      `Provider error 400: ${RAW_UPSTREAM}`,
      FREE_TIER_ROUTE,
    );
    expect(enriched).toContain("x-opencode-session");
    expect(enriched).toContain("opencode-zen");
    expect(enriched).toContain("https://opencode.ai/auth");
    expect(enriched).toContain("https://opencode.ai/docs/zen/");
    // The user is told opencodex declines to impersonate, not that the request merely failed.
    expect(enriched).toContain("does not send a fabricated OpenCode session header");
  });

  test("enrichment is scoped to Zen destinations and to this error", () => {
    expect(enrichOpenCodeZenFreeTierMessage(`Provider error 400: ${RAW_UPSTREAM}`, {
      providerName: "openrouter",
    })).toBe(`Provider error 400: ${RAW_UPSTREAM}`);
    expect(enrichOpenCodeZenFreeTierMessage("Provider error 500: boom", FREE_TIER_ROUTE))
      .toBe("Provider error 500: boom");
    // Destination match, not just the preset id: a custom row pointed at the same gateway.
    expect(enrichOpenCodeZenFreeTierMessage(
      `Provider error 400: ${RAW_UPSTREAM}`,
      { baseUrl: "https://opencode.ai/zen/v1", adapter: "openai-chat" },
    )).toContain("opencode-zen");
  });

  test("enrichment does not double-append across layers", () => {
    const once = enrichOpenCodeZenFreeTierMessage(
      `Provider error 400: ${RAW_UPSTREAM}`,
      FREE_TIER_ROUTE,
    );
    expect(enrichOpenCodeZenFreeTierMessage(once, FREE_TIER_ROUTE)).toBe(once);
  });

  test("enrichOpenCodeZenUpstreamMessage keeps the 429 guidance and adds the lock-in case", () => {
    const rateLimited = enrichOpenCodeZenUpstreamMessage(
      "Provider error 429: Rate limit exceeded.",
      { status: 429, providerName: "opencode-zen", hasApiKey: true },
    );
    expect(rateLimited).toContain(OPENCODE_ZEN_OBSERVED_RPM_HINT);
    expect(rateLimited).not.toContain("x-opencode-session");

    const lockedOut = enrichOpenCodeZenUpstreamMessage(
      `Provider error 400: ${RAW_UPSTREAM}`,
      { status: 400, ...FREE_TIER_ROUTE },
    );
    expect(lockedOut).toContain("x-opencode-session");
    expect(lockedOut).not.toContain(OPENCODE_ZEN_OBSERVED_RPM_HINT);
  });
});
