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

type Settings = { enabled: boolean; autoSwitchThreshold?: number; strategy?: string; quotaWindow?: string; nativeMessages?: boolean };

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
const nativeOf = (host: HTMLElement) => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;

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

  test("native Messages preservation defaults on and saves the server-confirmed value", async () => {
    const calls: Record<string, unknown>[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PUT") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        calls.push(body);
        return Response.json({ ...body, nativeMessages: false });
      }
      return Response.json({ enabled: true, kind: "anthropic" });
    }) as typeof fetch;
    const host = await mount(2);
    const toggle = host.querySelector<HTMLInputElement>('input[aria-describedby="anthropic-pool-native-messages-help"]')!;
    expect(toggle.checked).toBe(true);
    expect(host.textContent).toContain("cache hits are not guaranteed");
    await act(async () => { toggle.click(); await flush(); });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ provider: "anthropic", nativeMessages: false });
    expect(host.querySelector<HTMLInputElement>('input[aria-describedby="anthropic-pool-native-messages-help"]')!.checked).toBe(false);
  });

  test("native Messages toggle rolls back after a failed save and stays disabled after a failed load", async () => {
    stubPool({ enabled: true, nativeMessages: true }, 500);
    const host = await mount(2);
    const toggle = host.querySelector<HTMLInputElement>('input[aria-describedby="anthropic-pool-native-messages-help"]')!;
    expect(toggle.checked).toBe(true);
    await act(async () => { toggle.click(); await flush(); });
    expect(host.querySelector<HTMLInputElement>('input[aria-describedby="anthropic-pool-native-messages-help"]')!.checked).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(DICTS.en["anthropicPool.saveFailed"]);

    stubPool("fail");
    const failedHost = await mount(2);
    expect(failedHost.querySelector<HTMLInputElement>('input[aria-describedby="anthropic-pool-native-messages-help"]')!.disabled).toBe(true);
  });

  test("native opt-out survives unmount and reload, and the checkbox remains a preference while pooling is off", async () => {
    let saved: Record<string, unknown> = { enabled: false, nativeMessages: true };
    const writes: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "PUT") {
        saved = JSON.parse(String(init.body));
        writes.push(saved);
      }
      return Response.json(saved);
    }) as typeof fetch;
    const host = await mount(1);
    expect(toggleOf(host).disabled).toBe(true);
    expect(nativeOf(host).disabled).toBe(false);
    await act(async () => { nativeOf(host).click(); await flush(); });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ enabled: false, nativeMessages: false });
    expect(nativeOf(host).checked).toBe(false);
    const root = mountedRoots.pop();
    await act(async () => { root?.unmount(); });
    const reloaded = await mount(2);
    expect(nativeOf(reloaded).checked).toBe(false);
    expect(nativeOf(reloaded).getAttribute("aria-label")).toBe(DICTS.en["anthropicPool.nativeMessagesLabel"]);
    expect(reloaded.textContent).toContain("Explicit rollout opt-outs still apply.");
  });

  test("loading and saving disable edits and only the successful response changes the checkbox", async () => {
    let resolveRead!: (response: Response) => void;
    let resolveWrite!: (response: Response) => void;
    globalThis.fetch = (async (_input, init) => new Promise<Response>(resolve => {
      if (init?.method === "PUT") resolveWrite = resolve;
      else resolveRead = resolve;
    })) as typeof fetch;
    const host = await mount(2);
    expect(nativeOf(host).disabled).toBe(true);
    expect(toggleOf(host).disabled).toBe(true);
    await act(async () => { resolveRead(Response.json({ enabled: true, nativeMessages: true, strategy: "round-robin" })); await flush(); });
    await act(async () => { nativeOf(host).click(); await flush(); });
    expect(nativeOf(host).checked).toBe(true);
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
    for (const control of host.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")) expect(control.disabled).toBe(true);
    await act(async () => { resolveWrite(Response.json({ enabled: true, nativeMessages: false })); await flush(); });
    expect(nativeOf(host).checked).toBe(false);
    expect(nativeOf(host).disabled).toBe(false);
  });

  test("a confirmed published save adopts the response and announces its bookkeeping warning", async () => {
    globalThis.fetch = (async (_input, init) => Response.json(init?.method === "PUT"
      ? { enabled: true, nativeMessages: false, warning: "config_bookkeeping_failed" }
      : { enabled: true, nativeMessages: true })) as typeof fetch;
    const host = await mount(2);
    await act(async () => { nativeOf(host).click(); await flush(); });
    expect(nativeOf(host).checked).toBe(false);
    expect(host.querySelector('[role="status"]')?.textContent).toBe(DICTS.en["anthropicPool.saveWarning"]);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(nativeOf(host).disabled).toBe(false);
  });

  test("unknown save state removes saved claims and permits edits only after a successful reload", async () => {
    let reads = 0;
    let failReload = true;
    globalThis.fetch = (async (_input, init) => {
      if (init?.method === "PUT") return Response.json({ code: "config_save_state_unknown" }, { status: 409 });
      reads++;
      if (reads > 1 && failReload) return new Response(null, { status: 500 });
      return Response.json({ enabled: true, nativeMessages: reads === 1, autoSwitchThreshold: reads === 1 ? 80 : 61 });
    }) as typeof fetch;
    const host = await mount(2);
    await act(async () => { nativeOf(host).click(); await flush(); });
    expect(reads).toBe(1);
    expect(nativeOf(host).disabled).toBe(true);
    expect(host.querySelector('button[aria-pressed]')).toBeNull();
    expect(host.querySelector('input[type="number"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(DICTS.en["anthropicPool.saveStateUnknown"]);
    expect(host.textContent).not.toContain(DICTS.en["anthropicPool.disabledDesc"]);
    const reload = () => Array.from(host.querySelectorAll<HTMLButtonElement>("button")).find(button => button.textContent === DICTS.en["anthropicPool.reloadSettings"])!;
    await act(async () => { reload().click(); await flush(); });
    expect(reads).toBe(2);
    expect(nativeOf(host).disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(DICTS.en["anthropicPool.loadFailed"]);
    failReload = false;
    await act(async () => { reload().click(); await flush(); });
    expect(reads).toBe(3);
    expect(nativeOf(host).disabled).toBe(false);
    expect(nativeOf(host).checked).toBe(false);
    expect(toggleOf(host).getAttribute("aria-pressed")).toBe("true");
    expect(host.querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe("61");
    expect(host.querySelector('[role="alert"]')).toBeNull();
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
    "anthropicPool.nativeMessagesLabel",
    "anthropicPool.nativeMessagesHelp",
    "anthropicPool.saveWarning",
    "anthropicPool.saveStateUnknown",
    "anthropicPool.reloadSettings",
  ] as const;

  test("keys exist and the checkable tokens survive translation", () => {
    expect(LOCALES.some(locale => locale.code === "pt")).toBe(true);
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
