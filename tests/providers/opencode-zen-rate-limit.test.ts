import { describe, expect, test } from "bun:test";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import {
  OPENCODE_ZEN_OBSERVED_RPM_HINT,
  OPENCODE_ZEN_SYNTHETIC_RETRY_AFTER_SEC,
  enrichOpenCodeZenFreeTierMessage,
  enrichOpenCodeZenRateLimitMessage,
  enrichOpenCodeZenUpstreamMessage,
  isTransientConsoleGoUploadRejection,
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

describe("Console Go transient upload refusal", () => {
  // The observed Go-route refusal, byte-for-byte as Console serves it.
  const GO_MESSAGE = "Error from provider (Console Go): Upstream request failed: [invalid_request_error] Invalid upload request.";
  // The Zen key route names the same gateway without the Go suffix.
  const ZEN_MESSAGE = "Error from provider (Console): Upstream request failed: [invalid_request_error] Invalid upload request.";
  const envelope = (message: string) => JSON.stringify({ model: "muse-spark-1.3-contributor", error: { param: null, type: "invalid_request_error", message } });
  const GO_ROUTE = { providerName: "opencode-go", baseUrl: "https://opencode.ai/zen/go/v1" };
  const ZEN_ROUTE = { providerName: "opencode-zen", baseUrl: "https://opencode.ai/zen/v1" };

  test("accepts the canonical refusal on both canonical Console routes", () => {
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), ...GO_ROUTE })).toBe(true);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(ZEN_MESSAGE), ...ZEN_ROUTE })).toBe(true);
    // A custom row pointed at the same destination is still Console: the base URL decides.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), providerName: "my-go-row", baseUrl: "https://opencode.ai/zen/go/v1" })).toBe(true);
  });

  test("rejects the refusal text from a non-Console route", () => {
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), providerName: "deepseek", baseUrl: "https://api.deepseek.com/v1" })).toBe(false);
    // opencode.ai without the /zen segment is not the Console gateway.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), providerName: "other", baseUrl: "https://opencode.ai/v1" })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE) })).toBe(false);
  });

  test("rejects noncanonical envelopes, suffixes, and other statuses", () => {
    // A bare string is not the structured envelope.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: JSON.stringify({ error: "Invalid upload request." }), ...GO_ROUTE })).toBe(false);
    // A suffix means the gateway said something else; do not guess.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE + " Please retry."), ...GO_ROUTE })).toBe(false);
    // Different status: only the gateway 400 is the flap.
    expect(isTransientConsoleGoUploadRejection({ status: 500, errorBody: envelope(GO_MESSAGE), ...GO_ROUTE })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: undefined, ...GO_ROUTE })).toBe(false);
    // Other 400s on the same wire are verdicts on the request, not flaps.
    expect(isTransientConsoleGoUploadRejection({
      status: 400,
      errorBody: envelope("Error from provider (Console Go): Upstream request failed: [invalid_request_error] reasoning_effort max requires an active Muse Code subscription for model muse-spark-1.3-contributor."),
      ...GO_ROUTE,
    })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({
      status: 400,
      errorBody: JSON.stringify({ type: "error", error: { type: "MissingSessionID", message: "Request is missing x-opencode-session" } }),
      ...GO_ROUTE,
    })).toBe(false);
  });

  test("rejects partial envelopes and padded messages", () => {
    const withError = (error: unknown) => JSON.stringify({ model: "muse-spark-1.3-contributor", error });
    // type carries the refusal identity; a partial envelope is a different error.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ param: null, message: GO_MESSAGE }), ...GO_ROUTE })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ param: null, type: "server_error", message: GO_MESSAGE }), ...GO_ROUTE })).toBe(false);
    // param must be present and null.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ type: "invalid_request_error", message: GO_MESSAGE }), ...GO_ROUTE })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ param: "input", type: "invalid_request_error", message: GO_MESSAGE }), ...GO_ROUTE })).toBe(false);
    // Padding means the gateway wrapped or appended something.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ param: null, type: "invalid_request_error", message: " " + GO_MESSAGE }), ...GO_ROUTE })).toBe(false);
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: withError({ param: null, type: "invalid_request_error", message: GO_MESSAGE + "\n" }), ...GO_ROUTE })).toBe(false);
    // The exact canonical envelope still matches.
    expect(isTransientConsoleGoUploadRejection({ status: 400, errorBody: envelope(GO_MESSAGE), ...GO_ROUTE })).toBe(true);
  });
});

