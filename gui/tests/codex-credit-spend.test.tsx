import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { CodexCreditSpendPanel, CodexCreditSpendSwitch } from "../src/components/CodexCreditSpend";
import { creditSpendSummary, type CreditSpendSummary } from "../src/codex-credit-spend";
import { CodexAccountPoolCards } from "../src/components/codex-account-pool-cards";
import { CodexAccountPoolMainCard } from "../src/components/codex-account-pool-main-card";
import type { CodexAccountEntry } from "../src/hooks/useCodexAccountPool";
import { en } from "../src/i18n/en";
import { I18nContext, interpolate, type TFn } from "../src/i18n/shared";

const t: TFn = (key, vars) => interpolate(en[key], vars);
const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
const previous = Object.fromEntries(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

function withI18n(node: ReactNode) {
  return <I18nContext.Provider value={{ t, locale: "en", setLocale: () => {} }}>{node}</I18nContext.Provider>;
}

function account(overrides: Partial<CodexAccountEntry> = {}): CodexAccountEntry {
  return {
    id: "pool-a", email: "pool-a@example.test", isMain: false, paused: false, priority: 0,
    autoSwitchThresholdOverride: null, hasCredential: true, quota: null,
    quotaAutoRefresh: { fiveHourAvailable: false, weeklyAvailable: false, fiveHourEnabled: false, weeklyEnabled: false },
    ...overrides,
  };
}

const cardProps = {
  activeId: null, accountModeState: null, threshold: 80, switchActionLabel: "switch", onSwitch: () => {},
  onTogglePause: () => {}, pauseUpdatingId: null, pauseBusy: false, onPriorityChange: () => {},
  priorityUpdatingId: null, onAutoSwitchThresholdChange: async () => true, autoSwitchDisabled: false,
  switchingId: null, onOpenReset: () => {}, onReauth: () => {}, onEditAlias: () => {}, onRemove: () => {},
};

const ON_BADGE = `>${en["codexAuth.creditsOn"]}</span>`;

afterEach(() => {
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function renderSwitch(summary: CreditSpendSummary): string {
  return renderToStaticMarkup(withI18n(
    <CodexCreditSpendSwitch summary={summary} busy={false} expanded={false} panelId="p"
      onToggleAll={() => {}} onToggleExpanded={() => {}} />,
  ));
}

function globalState(html: string): string | undefined {
  const button = html.match(/<button[^>]*aria-label="Use ChatGPT credits after the usage limit"[^>]*>/)?.[0];
  return button?.match(/aria-pressed="(true|false|mixed)"/)?.[1];
}

test("spending is off by default: a row without the field counts as off", () => {
  expect(creditSpendSummary([account(), account({ id: "b", creditsAfterLimit: false })])).toEqual({ enabled: 0, total: 2 });
  expect(creditSpendSummary([account({ creditsAfterLimit: true }), account({ id: "b" })])).toEqual({ enabled: 1, total: 2 });
});

test("the global switch reads off, mixed or on from the accounts", () => {
  expect(globalState(renderSwitch({ enabled: 0, total: 3 }))).toBe("false");
  expect(globalState(renderSwitch({ enabled: 1, total: 3 }))).toBe("mixed");
  expect(globalState(renderSwitch({ enabled: 3, total: 3 }))).toBe("true");
  expect(renderSwitch({ enabled: 1, total: 3 })).toContain(">1/3</span>");
});

test.each(["main", "pool"] as const)("%s card badges only an account allowed to use credits", kind => {
  const render = (entry: CodexAccountEntry) => renderToStaticMarkup(withI18n(kind === "main"
    ? <CodexAccountPoolMainCard {...cardProps} t={t} main={{ ...entry, id: "__main__", isMain: true }} isMainActive creditsVisible={false} />
    : <CodexAccountPoolCards {...cardProps} pool={[entry]} creditsVisible={false} />));
  expect(render(account({ creditsAfterLimit: true }))).toContain(ON_BADGE);
  expect(render(account({ creditsAfterLimit: false }))).not.toContain(ON_BADGE);
  expect(render(account())).not.toContain(ON_BADGE);
  // The card no longer carries its own switch; the header panel owns it.
  expect(render(account())).not.toContain("Use credits after the usage limit for");
});

test("the global switch and the panel ask for the right state, and a pending write blocks the panel", async () => {
  const testWindow = new Window({ url: "http://localhost/" });
  for (const key of ["document", "window", "navigator"] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true, writable: true, value: key === "window" ? testWindow : testWindow[key],
    });
  }
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  const all: boolean[] = [];
  const rows: Array<[string, boolean]> = [];
  let expanded = 0;
  let root: Root | null = null;
  const entries = [account({ id: "__main__", isMain: true, email: "main@example.test", creditsAfterLimit: true }), account()];
  const mount = (summary: CreditSpendSummary, updatingId: string | null) => withI18n(<>
    <CodexCreditSpendSwitch summary={summary} busy={updatingId !== null} expanded panelId="credit-panel"
      onToggleAll={next => all.push(next)} onToggleExpanded={() => { expanded += 1; }} />
    <CodexCreditSpendPanel id="credit-panel" rows={entries} updatingId={updatingId}
      onToggle={(entry, next) => rows.push([entry.id, next])} />
  </>);
  try {
    await act(async () => {
      root = createRoot(host as unknown as HTMLElement);
      root.render(mount({ enabled: 0, total: 2 }, null));
    });
    const globalToggle = () => host.querySelector(".codex-credit-spend .toggle") as unknown as HTMLButtonElement;
    const disclosure = () => host.querySelector(".codex-credit-spend__disclosure") as unknown as HTMLButtonElement;
    const rowToggles = () => [...host.querySelectorAll(".codex-credit-spend-panel__row .toggle")] as unknown as HTMLButtonElement[];

    await act(async () => { globalToggle().click(); });
    expect(all).toEqual([true]);
    await act(async () => { root!.render(mount({ enabled: 1, total: 2 }, null)); });
    await act(async () => { globalToggle().click(); });
    expect(all).toEqual([true, true]);
    await act(async () => { root!.render(mount({ enabled: 2, total: 2 }, null)); });
    await act(async () => { globalToggle().click(); });
    expect(all).toEqual([true, true, false]);

    expect(disclosure().getAttribute("aria-controls")).toBe("credit-panel");
    await act(async () => { disclosure().click(); });
    expect(expanded).toBe(1);

    await act(async () => { rowToggles()[0]!.click(); rowToggles()[1]!.click(); });
    expect(rows).toEqual([["__main__", false], ["pool-a", true]]);

    await act(async () => { root!.render(mount({ enabled: 1, total: 2 }, "pool-a")); });
    expect(rowToggles().every(button => button.disabled)).toBe(true);
    expect(globalToggle().disabled).toBe(true);
  } finally {
    await act(async () => { root?.unmount(); });
    host.remove();
  }
});
