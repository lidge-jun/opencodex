import { describe, expect, test } from "bun:test";
import {
  CHATGPT_BASE_URL_KEY,
  stripJournaledOpenaiBaseUrl,
} from "../../src/codex/injected-marker";
import {
  setRootChatGptBaseUrl,
  stripInjectedOpenaiBaseUrl,
} from "../../src/codex/inject/config-toml";
import { isEffectiveCodexQuotaMask } from "../../src/codex/loopback-target";
import { maskWhamUsageBody } from "../../src/server/chatgpt-backend-relay";
import { OCX_SECTION_MARKER } from "../../src/codex/injected-marker";

const MARKER_LINE = `# Auto-injected by opencodex (undo: ocx restore)`;
const ROUTING_URL = "http://127.0.0.1:10101/v1";
const CHATGPT_URL = "http://127.0.0.1:10101/backend-api";

describe("codex quota mask config injection", () => {
  test("injects chatgpt_base_url after the marker-owned routing pair", () => {
    const content = `${MARKER_LINE}\nopenai_base_url = "${ROUTING_URL}"\n\n[profiles.default]\nmodel = "gpt-5.5"\n`;
    const result = setRootChatGptBaseUrl(content, CHATGPT_URL);
    expect(result.keptUserChatGptBaseUrl).toBe(false);
    const lines = result.content.split("\n");
    const chatgptIndex = lines.findIndex(line => line.startsWith(CHATGPT_BASE_URL_KEY));
    expect(chatgptIndex).toBe(3);
    expect(lines[chatgptIndex - 1]).toBe(MARKER_LINE);
    expect(lines[1]).toContain(ROUTING_URL);
  });

  test("rewrites a marker-owned line in place and keeps idempotent output stable", () => {
    const content = `${MARKER_LINE}\nopenai_base_url = "${ROUTING_URL}"\n${MARKER_LINE}\n${CHATGPT_BASE_URL_KEY} = "http://127.0.0.1:9/backend-api"\n`;
    const once = setRootChatGptBaseUrl(content, CHATGPT_URL);
    const twice = setRootChatGptBaseUrl(once.content, CHATGPT_URL);
    expect(once.content).toBe(twice.content);
    expect(once.content).toContain(`${CHATGPT_BASE_URL_KEY} = "${CHATGPT_URL}"`);
    expect(once.content).not.toContain("127.0.0.1:9");
  });

  test("keeps a user-owned chatgpt_base_url and injects nothing", () => {
    const content = `${MARKER_LINE}\nopenai_base_url = "${ROUTING_URL}"\n${CHATGPT_BASE_URL_KEY} = "https://my-gateway.example/backend-api"\n`;
    const result = setRootChatGptBaseUrl(content, CHATGPT_URL);
    expect(result.keptUserChatGptBaseUrl).toBe(true);
    expect(result.content).toBe(content);
  });

  test("injects nothing when no marker-owned routing override exists", () => {
    const content = `model = "gpt-5.5"\n\n[profiles.default]\n`;
    const result = setRootChatGptBaseUrl(content, CHATGPT_URL);
    expect(result.content).toBe(content);
    expect(result.keptUserChatGptBaseUrl).toBe(false);
  });

  test("stripInjectedOpenaiBaseUrl removes the marker-owned pair and keeps a user line", () => {
    const injected = `${MARKER_LINE}\nopenai_base_url = "${ROUTING_URL}"\n${MARKER_LINE}\n${CHATGPT_BASE_URL_KEY} = "${CHATGPT_URL}"\n`;
    expect(stripInjectedOpenaiBaseUrl(injected)).not.toContain(CHATGPT_BASE_URL_KEY);

    const userOwned = `${CHATGPT_BASE_URL_KEY} = "https://my-gateway.example/backend-api"\n`;
    expect(stripInjectedOpenaiBaseUrl(userOwned)).toContain(CHATGPT_BASE_URL_KEY);
  });

  test("stripJournaledOpenaiBaseUrl removes our recorded value after an app rewrite drops comments", () => {
    // The Codex app reserializes config.toml without comments (#1798): the value is the
    // only ownership evidence left.
    const rewritten = `${CHATGPT_BASE_URL_KEY} = "${CHATGPT_URL}"\nmodel = "gpt-5.5"\n`;
    expect(stripJournaledOpenaiBaseUrl(rewritten, null, null, CHATGPT_URL))
      .not.toContain(CHATGPT_BASE_URL_KEY);
    const userValue = `${CHATGPT_BASE_URL_KEY} = "https://my-gateway.example/backend-api"\n`;
    expect(stripJournaledOpenaiBaseUrl(userValue, null, null, CHATGPT_URL))
      .toContain(CHATGPT_BASE_URL_KEY);
  });
});

describe("codex quota mask effectiveness", () => {
  test("requires the flag, a non-client role, and the dedicated loopback listener", () => {
    const base = {
      runtimeRole: "server",
      unauthenticatedLoopbackListener: { enabled: true, port: 10101 },
      codexQuotaMask: true,
    } as const;
    expect(isEffectiveCodexQuotaMask(base)).toBe(true);
    expect(isEffectiveCodexQuotaMask({ ...base, codexQuotaMask: false })).toBe(false);
    expect(isEffectiveCodexQuotaMask({ ...base, runtimeRole: "client" })).toBe(false);
    // A plain loopback public bind is NOT enough: the relay is served only by the
    // dedicated listener, so the flag must stay inert without it.
    expect(isEffectiveCodexQuotaMask({ ...base, unauthenticatedLoopbackListener: { enabled: false } })).toBe(false);
    expect(isEffectiveCodexQuotaMask({ ...base, unauthenticatedLoopbackListener: undefined })).toBe(false);
  });
});

describe("wham/usage mask", () => {
  test("rewrites the verdict and preserves every identifying field", () => {
    const body = {
      account_id: "11111111-2222-3333-4444-555555555555",
      user_id: "user-1",
      rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: { window_minutes: 300, used_percent: 100 },
        secondary_window: { window_minutes: 10080, used_percent: 92 },
      },
      rate_limit_upsell: { experiment: "upsell-a" },
      rate_limit_reached_type: "course_grain_rate_limit_reached",
      credits: "0",
    };
    const masked = maskWhamUsageBody(body);
    expect(masked.rate_limit.allowed).toBe(true);
    expect(masked.rate_limit.limit_reached).toBe(false);
    expect(masked.rate_limit_upsell).toBeNull();
    expect(masked.rate_limit_reached_type).toBeNull();
    expect(masked.account_id).toBe(body.account_id);
    expect(masked.user_id).toBe(body.user_id);
    expect(masked.rate_limit.primary_window).toEqual(body.rate_limit.primary_window);
    expect(masked.credits).toBe("0");
  });
});
