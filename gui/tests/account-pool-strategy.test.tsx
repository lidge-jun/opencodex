import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_ACCOUNT_POOL_STICKY_LIMIT,
  DEFAULT_ACCOUNT_POOL_STRATEGY,
  normalizeAccountPoolStickyLimit,
  normalizeAccountPoolStrategy,
  parseAccountPoolStickyLimitDraft,
  putCodexPoolStrategy,
} from "../src/account-pool-strategy";
import AccountPoolStrategyControls from "../src/components/AccountPoolStrategyControls";
import { LanguageProvider } from "../src/i18n/provider";

let previousLanguage: unknown;

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

describe("account pool strategy helpers", () => {
  test("normalizes known strategies and defaults unknowns to quota", () => {
    expect(normalizeAccountPoolStrategy("quota")).toBe("quota");
    expect(normalizeAccountPoolStrategy("round-robin")).toBe("round-robin");
    expect(normalizeAccountPoolStrategy("fill-first")).toBe("fill-first");
    expect(normalizeAccountPoolStrategy("weighted")).toBe(DEFAULT_ACCOUNT_POOL_STRATEGY);
    expect(normalizeAccountPoolStrategy(undefined)).toBe("quota");
  });

  test("normalizes sticky limits to 1–100 integers", () => {
    expect(normalizeAccountPoolStickyLimit(3)).toBe(3);
    expect(normalizeAccountPoolStickyLimit(1)).toBe(1);
    expect(normalizeAccountPoolStickyLimit(100)).toBe(100);
    expect(normalizeAccountPoolStickyLimit(0)).toBe(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT);
    expect(normalizeAccountPoolStickyLimit(101)).toBe(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT);
    expect(normalizeAccountPoolStickyLimit(1.5)).toBe(DEFAULT_ACCOUNT_POOL_STICKY_LIMIT);
  });

  test("parses sticky-limit drafts strictly", () => {
    expect(parseAccountPoolStickyLimitDraft("1")).toBe(1);
    expect(parseAccountPoolStickyLimitDraft("42")).toBe(42);
    expect(parseAccountPoolStickyLimitDraft("100")).toBe(100);
    for (const invalid of ["", "0", "101", "1.5", "-1", "abc", " 2 "]) {
      // Leading/trailing spaces are trimmed; " 2 " is valid.
      if (invalid === " 2 ") {
        expect(parseAccountPoolStickyLimitDraft(invalid)).toBe(2);
        continue;
      }
      expect(parseAccountPoolStickyLimitDraft(invalid)).toBeNull();
    }
  });

  test("putCodexPoolStrategy sends strategy/stickyLimit body fields", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const result = await putCodexPoolStrategy(
      "http://proxy",
      { strategy: "round-robin", stickyLimit: 3 },
      async (url, init) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({
          ok: true,
          accountPoolStrategy: "round-robin",
          accountPoolStickyLimit: 3,
        }), { status: 200 });
      },
    );
    expect(result).toEqual({ ok: true, strategy: "round-robin", stickyLimit: 3 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://proxy/api/codex-auth/pool-strategy");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      strategy: "round-robin",
      stickyLimit: 3,
    });
  });
});

describe("AccountPoolStrategyControls", () => {
  test("renders strategy options and hides sticky unless round-robin", () => {
    const quota = renderToStaticMarkup(
      <LanguageProvider>
        <AccountPoolStrategyControls
          strategy="quota"
          stickyDraft="1"
          onStrategyChange={() => {}}
          onStickyDraftChange={() => {}}
          onStickyCommit={() => {}}
        />
      </LanguageProvider>,
    );
    expect(quota).toContain("Quota");
    expect(quota).toContain("Round-robin");
    expect(quota).toContain("Fill-first");
    expect(quota).toContain("Applies to new sessions only");
    expect(quota).not.toContain("Sticky successes before rotate");

    const rr = renderToStaticMarkup(
      <LanguageProvider>
        <AccountPoolStrategyControls
          strategy="round-robin"
          stickyDraft="2"
          onStrategyChange={() => {}}
          onStickyDraftChange={() => {}}
          onStickyCommit={() => {}}
        />
      </LanguageProvider>,
    );
    expect(rr).toContain("Sticky successes before rotate");
    expect(rr).toContain('value="2"');
  });
});
