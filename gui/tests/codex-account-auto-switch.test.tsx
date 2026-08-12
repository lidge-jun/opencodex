import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  DEFAULT_AUTO_SWITCH_THRESHOLD,
  autoSwitchThresholdReadDisposition,
  nextAutoSwitchThreshold,
  normalizeAutoSwitchThreshold,
  parseEnabledAutoSwitchThreshold,
  planAutoSwitchToggleWrite,
  putAutoSwitchThreshold,
  type AutoSwitchFetch,
} from "../src/codex-auto-switch";
import { CodexAutoSwitchSetting as AutoSwitchSetting } from "../src/components/CodexAutoSwitchSetting";
import AccountPoolStrategyControls from "../src/components/AccountPoolStrategyControls";
import type { AccountPoolStrategy } from "../src/account-pool-strategy";
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

function renderSetting(
  threshold: number,
  draft = String(threshold > 0 ? threshold : 80),
  saving = false,
  loadError = false,
  feedback: { tone: "ok" | "err"; message: string } | null = null,
  strategy: AccountPoolStrategy = "quota",
): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <AutoSwitchSetting
        threshold={threshold}
        draft={draft}
        strategy={strategy}
        saving={saving}
        loadError={loadError}
        feedback={feedback}
        onDraftChange={() => {}}
        onEditingChange={() => {}}
        onCommit={async () => true}
        onCancel={() => {}}
        onToggle={async () => true}
        onRetry={() => {}}
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

  test("toggle keeps a changed valid draft as the page restore value", () => {
    expect(planAutoSwitchToggleWrite(90, "95", 90)).toEqual({ threshold: 0, lastEnabled: 95 });
    expect(planAutoSwitchToggleWrite(90, "90", 90)).toEqual({ threshold: 0, lastEnabled: 90 });
    expect(planAutoSwitchToggleWrite(0, "90", 95)).toEqual({ threshold: 95, lastEnabled: 95 });
  });

  test("toggle disables despite an invalid draft and preserves a safe restore value", () => {
    expect(planAutoSwitchToggleWrite(90, "", 90)).toEqual({ threshold: 0, lastEnabled: 90 });
    expect(planAutoSwitchToggleWrite(90, "50.5", 90)).toEqual({ threshold: 0, lastEnabled: 90 });
    expect(planAutoSwitchToggleWrite(90, "abc", 0)).toEqual({
      threshold: 0,
      lastEnabled: DEFAULT_AUTO_SWITCH_THRESHOLD,
    });
    expect(planAutoSwitchToggleWrite(90, "101", 101)).toEqual({
      threshold: 0,
      lastEnabled: DEFAULT_AUTO_SWITCH_THRESHOLD,
    });
  });

  test("applies, defers, or ignores threshold reads by edit and revision state", () => {
    expect(autoSwitchThresholdReadDisposition(false, false, 2, 2)).toBe("apply");
    expect(autoSwitchThresholdReadDisposition(true, false, 2, 2)).toBe("defer");
    expect(autoSwitchThresholdReadDisposition(false, true, 2, 2)).toBe("defer");
    expect(autoSwitchThresholdReadDisposition(false, false, 1, 2)).toBe("ignore");
  });

  test("renders the persisted custom threshold and inclusive condition", () => {
    const html = renderSetting(95);
    expect(html).toContain('value="95"');
    expect(html).toContain('min="1"');
    expect(html).toContain('max="100"');
    expect(html).toContain('aria-label="Usage threshold, percent"');
    expect(html).toContain("95% usage or above");
    expect(html).toContain("including an already-bound task");
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
    expect(html).toContain("Usage-based proactive switching is off");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain('type="number"');
  });

  test("explains threshold semantics by strategy and separates recovery from cache continuity", () => {
    const quota = renderSetting(80, "80", false, false, null, "quota");
    const roundRobin = renderSetting(80, "80", false, false, null, "round-robin");
    const fillFirst = renderSetting(80, "80", false, false, null, "fill-first");

    expect(quota).toContain("including an already-bound task");
    expect(roundRobin).toContain("does not use this threshold");
    expect(fillFirst).toContain("drain point for new/unbound tasks");
    for (const html of [quota, roundRobin, fillFirst]) {
      expect(html).toContain("Failure recovery is separate");
      expect(html).toContain("Prompt cache resets on account switch");
    }
  });

  test("defines unbound assignment and describes each rotation strategy accurately", () => {
    const renderStrategy = (strategy: AccountPoolStrategy) => renderToStaticMarkup(
      <LanguageProvider>
        <AccountPoolStrategyControls
          strategy={strategy}
          stickyDraft="2"
          onStrategyChange={() => {}}
          onStickyDraftChange={() => {}}
          onStickyCommit={() => {}}
        />
      </LanguageProvider>,
    );

    expect(renderStrategy("quota")).toContain("can also rebind an existing task");
    expect(renderStrategy("round-robin")).toContain("usage threshold does not change normal rotation");
    const fillFirst = renderStrategy("fill-first");
    expect(fillFirst).toContain("healthy bound tasks keep affinity");
    expect(fillFirst).toContain("existing visible task can become unbound");

    const roundRobin = renderStrategy("round-robin");
    expect(roundRobin).toContain("New/unbound assignments before rotate");
    expect(roundRobin).toContain("not after upstream success");
  });

  test("paints controls immediately with the default threshold (no loading placeholder)", () => {
    const html = renderSetting(DEFAULT_AUTO_SWITCH_THRESHOLD);
    expect(html).toContain('type="number"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).not.toContain("Loading…");
    expect(html).not.toContain('aria-busy="true"');
  });

  test("blocks interaction until hydrated without hiding chrome", () => {
    const html = renderToStaticMarkup(
      <LanguageProvider>
        <AutoSwitchSetting
          threshold={DEFAULT_AUTO_SWITCH_THRESHOLD}
          draft={String(DEFAULT_AUTO_SWITCH_THRESHOLD)}
          hydrated={false}
          saving={false}
          loadError={false}
          feedback={null}
          onDraftChange={() => {}}
          onEditingChange={() => {}}
          onCommit={async () => true}
          onCancel={() => {}}
          onToggle={async () => true}
          onRetry={() => {}}
        />
      </LanguageProvider>,
    );
    expect(html).toContain('type="number"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('readOnly=""');
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Loading…");
  });

  test("surfaces load failure without hiding the toggle", () => {
    const failed = renderSetting(DEFAULT_AUTO_SWITCH_THRESHOLD, String(DEFAULT_AUTO_SWITCH_THRESHOLD), false, true);
    expect(failed).toContain("Usage-based switching setting could not be loaded.");
    expect(failed).toContain("Retry");
    expect(failed).toContain('aria-pressed="true"');
  });

  test("keeps the focused input present but read-only while a write is pending", () => {
    const html = renderSetting(80, "80", true);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('readOnly=""');
    expect(html).toContain("Saving…");
    expect(html).toContain('disabled=""');
  });

  test("renders contextual success and error feedback", () => {
    const success = renderSetting(80, "80", false, false, { tone: "ok", message: "Saved here" });
    expect(success).toContain('role="status"');
    expect(success).toContain("Saved here");
    expect(success).toContain("codex-auto-switch-feedback");

    const failure = renderSetting(80, "80", false, false, { tone: "err", message: "Fix this value" });
    expect(failure).toContain('role="alert"');
    expect(failure).toContain("Fix this value");
    expect(failure).toContain("is-error");
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

  test("aborts a write that exceeds the browser-side saving timeout", async () => {
    let calls = 0;
    let receivedSignal: AbortSignal | null = null;
    const fetchImpl: AutoSwitchFetch = async (_input, init) => {
      calls += 1;
      const signal = init.signal;
      if (!signal) throw new Error("expected an abort signal");
      receivedSignal = signal;
      return await new Promise<Response>((_resolve, reject) => {
        const guard = setTimeout(() => reject(new Error("abort signal did not fire")), 100);
        const rejectOnAbort = () => {
          clearTimeout(guard);
          reject(signal.reason ?? new Error("aborted"));
        };
        if (signal.aborted) {
          rejectOnAbort();
          return;
        }
        signal.addEventListener("abort", rejectOnAbort, { once: true });
      });
    };

    expect(await putAutoSwitchThreshold("", 95, fetchImpl, 5)).toBe(false);
    expect(calls).toBe(1);
    expect(receivedSignal).not.toBeNull();
    expect(receivedSignal?.aborted).toBe(true);
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
