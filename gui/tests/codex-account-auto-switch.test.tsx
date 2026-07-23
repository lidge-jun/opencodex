import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_AUTO_SWITCH_THRESHOLD,
  nextAutoSwitchThreshold,
  normalizeAutoSwitchThreshold,
  parseEnabledAutoSwitchThreshold,
  planAutoSwitchToggleWrites,
  putAutoSwitchThreshold,
  type AutoSwitchFetch,
} from "../src/codex-auto-switch";
import { AutoSwitchSetting } from "../src/components/CodexAccountPool";
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

function renderSetting(threshold: number, draft = String(threshold), saving = false): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <AutoSwitchSetting
        threshold={threshold}
        draft={draft}
        saving={saving}
        onDraftChange={() => {}}
        onEditingChange={() => {}}
        onCommit={async () => true}
        onToggle={async () => true}
      />
    </LanguageProvider>,
  );
}

describe("Codex account auto-switch threshold", () => {
  test("accepts enabled integer boundaries and a custom value", () => {
    expect(parseEnabledAutoSwitchThreshold("1")).toBe(1);
    expect(parseEnabledAutoSwitchThreshold("95")).toBe(95);
    expect(parseEnabledAutoSwitchThreshold("100")).toBe(100);
  });

  test("rejects empty, disabled, fractional, negative, and out-of-range drafts", () => {
    for (const invalid of ["", "0", "50.5", "-1", "101", "abc"]) {
      expect(parseEnabledAutoSwitchThreshold(invalid)).toBeNull();
    }
  });

  test("normalizes malformed server values to the existing default", () => {
    expect(normalizeAutoSwitchThreshold(0)).toBe(0);
    expect(normalizeAutoSwitchThreshold(95)).toBe(95);
    expect(normalizeAutoSwitchThreshold(undefined)).toBe(DEFAULT_AUTO_SWITCH_THRESHOLD);
    expect(normalizeAutoSwitchThreshold(101)).toBe(DEFAULT_AUTO_SWITCH_THRESHOLD);
  });

  test("toggle disables with zero and restores the last enabled value", () => {
    expect(nextAutoSwitchThreshold(95, 95)).toBe(0);
    expect(nextAutoSwitchThreshold(0, 95)).toBe(95);
    expect(nextAutoSwitchThreshold(0, 0)).toBe(DEFAULT_AUTO_SWITCH_THRESHOLD);
  });

  test("toggle persists a changed valid draft before disabling", () => {
    expect(planAutoSwitchToggleWrites(90, "95", 90)).toEqual([95, 0]);
    expect(planAutoSwitchToggleWrites(90, "90", 90)).toEqual([0]);
    expect(planAutoSwitchToggleWrites(0, "90", 95)).toEqual([95]);
  });

  test("toggle rejects an invalid enabled draft without writing", () => {
    expect(planAutoSwitchToggleWrites(90, "50.5", 90)).toBeNull();
    expect(planAutoSwitchToggleWrites(90, "", 90)).toBeNull();
  });

  test("renders the persisted custom threshold and inclusive condition", () => {
    const html = renderSetting(95);
    expect(html).toContain('value="95"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="100"');
    expect(html).toContain("95% usage or above");
    expect(html).toContain('aria-pressed="true"');
  });

  test("renders both enabled boundary values", () => {
    for (const threshold of [1, 100]) {
      const html = renderSetting(threshold);
      expect(html).toContain(`value="${threshold}"`);
      expect(html).toContain(`${threshold}% usage or above`);
    }
  });

  test("renders an explicit off state without an editable threshold", () => {
    const html = renderSetting(0, "80");
    expect(html).toContain("Automatic account switching is off");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('type="number"');
  });

  test("disables controls while a threshold write is pending", () => {
    const html = renderSetting(80, "80", true);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('disabled=""');
  });

  test("writes the requested threshold through the existing management endpoint", async () => {
    let request: { input: string; init: RequestInit } | null = null;
    const fetchImpl: AutoSwitchFetch = async (input, init) => {
      request = { input, init };
      return new Response(null, { status: 204 });
    };

    expect(await putAutoSwitchThreshold("http://localhost:10100", 95, fetchImpl)).toBe(true);
    expect(request?.input).toBe("http://localhost:10100/api/codex-auth/auto-switch");
    expect(request?.init.method).toBe("PUT");
    expect(request?.init.body).toBe(JSON.stringify({ threshold: 95 }));
  });

  test("reports HTTP and network failures without accepting the write", async () => {
    const httpFailure: AutoSwitchFetch = async () => new Response(null, { status: 500 });
    const networkFailure: AutoSwitchFetch = async () => { throw new Error("offline"); };
    expect(await putAutoSwitchThreshold("", 95, httpFailure)).toBe(false);
    expect(await putAutoSwitchThreshold("", 95, networkFailure)).toBe(false);
  });

  test("does not send an invalid threshold", async () => {
    let calls = 0;
    const fetchImpl: AutoSwitchFetch = async () => {
      calls += 1;
      return new Response(null, { status: 204 });
    };
    expect(await putAutoSwitchThreshold("", 101, fetchImpl)).toBe(false);
    expect(calls).toBe(0);
  });
});
