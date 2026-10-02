/**
 * The Claude account-pool card explains its conditions quietly and keeps failures loud.
 *
 * The notice used to be an always-rendered role="alert" box that told the operator to keep the
 * pool off without saying why, or that 429 failover keeps running either way. Its replacement is
 * static helper text plus a closed disclosure, so a screen reader is not interrupted on every
 * render. Save failures stay a live alert, and turning the pool off stays possible in every state
 * that has it on.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import AnthropicAccountPoolSettings from "../src/components/provider-workspace/AnthropicAccountPoolSettings";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS, LOCALES } from "../src/i18n/shared";

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let mountedRoots: Root[];

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

beforeEach(() => {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  mountedRoots = [];
});

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => { root.unmount(); });
  }
  for (const key of domGlobals) {
    const descriptor = previousDomGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  await testWindow.happyDOM?.close?.();
});

type Settings = { enabled: boolean; autoSwitchThreshold?: number; strategy?: string; quotaWindow?: string };

/** GET answers with settings (or fails); PUT answers per the supplied status. */
function stubPool(get: Settings | "fail", putStatus = 200): { puts: number } {
  const calls = { puts: 0 };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!String(input).includes("/api/pool/settings")) throw new Error("unexpected fetch");
    if (init?.method === "PUT") {
      calls.puts += 1;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      return putStatus === 200 ? Response.json(body) : new Response(null, { status: putStatus });
    }
    if (get === "fail") return new Response(null, { status: 500 });
    return Response.json({ strategy: "quota", stickyLimit: 1, quotaWindow: "five-hour", autoSwitchThreshold: 80, ...get });
  }) as typeof fetch;
  return calls;
}

async function mount(accountCount: number): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(
      <LanguageProvider>
        <AnthropicAccountPoolSettings apiBase="http://proxy" accountCount={accountCount} />
      </LanguageProvider>,
    );
  });
  await act(async () => { await flush(); });
  return host as unknown as HTMLElement;
}

const toggleOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>("button[aria-pressed]")!;

describe("Claude account pool conditions", () => {
  test("the conditions notice is static text with a closed details disclosure", async () => {
    stubPool({ enabled: false });
    const host = await mount(2);

    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(0);
    const notice = host.querySelector(".anthropic-pool-card__notice");
    expect(notice?.tagName).toBe("P");
    expect(notice?.textContent).toBe(DICTS.en["anthropicPool.experimentalWarning"]);

    const details = host.querySelector<HTMLDetailsElement>("details.anthropic-pool-card__details");
    expect(details).not.toBeNull();
    expect(details!.open).toBe(false);
    expect(details!.querySelector("summary")?.textContent).toBe("How account selection works");
    expect(details!.textContent).toContain(DICTS.en["anthropicPool.detailsFailover"]);
    expect(details!.textContent).toContain("sends no keep-warm requests");
    const link = details!.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://opencodex.me/guides/claude-code/#claude-oauth-account-pool-experimental");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  test("the off description says a 429 can still switch accounts", async () => {
    stubPool({ enabled: false });
    const host = await mount(2);
    expect(host.textContent).toContain("Proactive account selection is off.");
    expect(host.textContent).toContain("can still switch after a rate-limit response (429)");
    expect(toggleOf(host).disabled).toBe(false);
  });

  test("enabling needs two accounts, but turning the pool off never does", async () => {
    stubPool({ enabled: false });
    const offHost = await mount(1);
    expect(toggleOf(offHost).disabled).toBe(true);
    expect(offHost.textContent).toContain(DICTS.en["anthropicPool.needTwoAccounts"]);

    const calls = stubPool({ enabled: true });
    const onHost = await mount(1);
    const toggle = toggleOf(onHost);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.disabled).toBe(false);
    await act(async () => { toggle.click(); await flush(); });
    expect(calls.puts).toBe(1);
    expect(toggleOf(onHost).getAttribute("aria-pressed")).toBe("false");
  });

  test("the threshold help calls it a preference, not a cap", async () => {
    stubPool({ enabled: true });
    const host = await mount(2);
    expect(host.textContent).toContain("not a hard usage or billing cap");
  });

  test("a failed save is a live alert and the toggle shows the settings that are still in force", async () => {
    stubPool({ enabled: false }, 500);
    const host = await mount(2);
    await act(async () => { toggleOf(host).click(); await flush(); });

    const alerts = host.querySelectorAll('[role="alert"]');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.textContent).toBe(DICTS.en["anthropicPool.saveFailed"]);
    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("false");
  });

  test("a failed load says so and blocks the toggle without raising the notice to an alert", async () => {
    stubPool("fail");
    const host = await mount(2);
    expect(host.textContent).toContain(DICTS.en["anthropicPool.loadFailed"]);
    expect(toggleOf(host).disabled).toBe(true);
    expect(host.querySelector(".anthropic-pool-card__notice")?.getAttribute("role")).toBeNull();
  });
});

describe("the enabled status line follows the selected strategy", () => {
  // Mirrors src/oauth/anthropic-routing.ts: round-robin rotates through the ring and reads no
  // usage (pickUnboundStrategyAccount / pickAlternateAnthropicAccount), fill-first drains the
  // active account to its threshold, and quota ranks by the window.
  const status = (host: HTMLElement) => host.querySelector(".card-row .card-sub")?.textContent ?? "";

  for (const threshold of [80, 0]) {
    test("round-robin names no usage window or threshold (threshold " + threshold + ")", async () => {
      stubPool({ enabled: true, strategy: "round-robin", autoSwitchThreshold: threshold, quotaWindow: "weekly" });
      const host = await mount(2);
      expect(status(host)).toBe(DICTS.en["anthropicPool.enabledRoundRobinDesc"]);
      expect(status(host)).not.toContain("Weekly bar");
      expect(status(host)).not.toContain(threshold + "%");
      expect(status(host)).not.toContain("Usage thresholds do not move");
    });
  }

  test("fill-first names the drain threshold and window, or neither at threshold 0", async () => {
    stubPool({ enabled: true, strategy: "fill-first", autoSwitchThreshold: 70, quotaWindow: "weekly" });
    const drained = await mount(2);
    expect(status(drained)).toContain("until it reaches 70% (Weekly bar)");
    expect(status(drained)).toContain("next account in order");

    stubPool({ enabled: true, strategy: "fill-first", autoSwitchThreshold: 0, quotaWindow: "weekly" });
    const sticky = await mount(2);
    expect(status(sticky)).toBe(DICTS.en["anthropicPool.enabledFillFirstNoThresholdDesc"]);
    expect(status(sticky)).not.toContain("Weekly bar");
  });

  test("quota keeps naming the threshold and window it ranks by", async () => {
    stubPool({ enabled: true, strategy: "quota", autoSwitchThreshold: 80, quotaWindow: "five-hour" });
    const host = await mount(2);
    expect(status(host)).toContain("under 80% (5-hour bar)");

    stubPool({ enabled: true, strategy: "quota", autoSwitchThreshold: 0, quotaWindow: "five-hour" });
    const zero = await mount(2);
    expect(status(zero)).toContain("the account with the lowest usage (5-hour bar) is chosen");
  });
});

describe("every locale carries the same pool claims", () => {
  test("each strategy's status line keeps the placeholders its claim depends on", () => {
    for (const { code } of LOCALES) {
      const dict = DICTS[code];
      // Round-robin reads no usage, threshold or window, so its line may name none of them.
      expect(dict["anthropicPool.enabledRoundRobinDesc"], code).not.toContain("{window}");
      expect(dict["anthropicPool.enabledRoundRobinDesc"], code).not.toContain("{threshold}");
      expect(dict["anthropicPool.enabledFillFirstDesc"], code).toContain("{threshold}");
      expect(dict["anthropicPool.enabledFillFirstDesc"], code).toContain("{window}");
      expect(dict["anthropicPool.enabledFillFirstNoThresholdDesc"], code).not.toContain("{threshold}");
      expect(dict["anthropicPool.enabledFillFirstNoThresholdDesc"], code).not.toContain("{window}");
      expect(dict["anthropicPool.enabledNoProactiveDesc"], code).toContain("{window}");
      expect(dict["anthropicPool.enabledNoProactiveDesc"], code).not.toContain("{threshold}");
    }
  });

  const KEYS = [
    "anthropicPool.experimentalWarning",
    "anthropicPool.disabledDesc",
    "anthropicPool.enabledNoProactiveDesc",
    "anthropicPool.thresholdHelp",
    "anthropicPool.detailsSummary",
    "anthropicPool.detailsEnabling",
    "anthropicPool.detailsFailover",
    "anthropicPool.detailsActivity",
    "anthropicPool.detailsGuide",
  ] as const;

  test("keys exist and the checkable tokens survive translation", () => {
    expect(LOCALES.length).toBe(10);
    for (const { code } of LOCALES) {
      const dict = DICTS[code];
      for (const key of KEYS) {
        expect(typeof dict[key], code + " " + key).toBe("string");
        expect(dict[key].trim().length, code + " " + key).toBeGreaterThan(0);
        expect(dict[key], code + " " + key).not.toBe(key);
      }
      // Tokens every language writes the same way: the client, the vendor, the status code,
      // the default threshold, the keep-warm term, and the CLI name.
      expect(dict["anthropicPool.experimentalWarning"], code).toContain("Claude Code");
      expect(dict["anthropicPool.experimentalWarning"], code).toContain("Anthropic");
      expect(dict["anthropicPool.disabledDesc"], code).toContain("429");
      expect(dict["anthropicPool.detailsFailover"], code).toContain("429");
      expect(dict["anthropicPool.thresholdHelp"], code).toContain("80");
      expect(dict["anthropicPool.detailsActivity"], code).toMatch(/keep-warm/i);
      expect(dict["anthropicPool.detailsActivity"], code).toContain("ocx");
      expect(dict["anthropicPool.experimentalWarning"], code).not.toMatch(/battle/i);
    }
  });

  test("Korean reads as Korean product copy", () => {
    expect(DICTS.ko["anthropicPool.detailsSummary"]).toBe("계정 선택 방식 알아보기");
    expect(DICTS.ko["anthropicPool.experimentalWarning"]).toContain("공식 Claude Code 클라이언트");
    expect(DICTS.ko["anthropicPool.detailsFailover"]).toContain("일시 중지");
  });
});
