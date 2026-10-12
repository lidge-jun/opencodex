import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import { AccountCreditsToggle, CodexCreditSpendSwitch } from "../src/components/CodexCreditSpend";
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
  switchingId: null, onUnpin: () => {}, onOpenReset: () => {}, onReauth: () => {}, onEditAlias: () => {}, onRemove: () => {},
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
    <CodexCreditSpendSwitch summary={summary} busy={false} onToggleAll={() => {}} />,
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
});

test.each(["main", "pool"] as const)("%s card badges an allowed account and keeps its switch in the more disclosure", kind => {
  const render = (entry: CodexAccountEntry, wired = true) => {
    const onToggleCreditsAfterLimit = wired ? () => {} : undefined;
    return renderToStaticMarkup(withI18n(kind === "main"
      ? <CodexAccountPoolMainCard {...cardProps} t={t} main={{ ...entry, id: "__main__", isMain: true }} isMainActive creditsVisible={false}
          onToggleCreditsAfterLimit={onToggleCreditsAfterLimit} />
      : <CodexAccountPoolCards {...cardProps} pool={[entry]} creditsVisible={false} onToggleCreditsAfterLimit={onToggleCreditsAfterLimit} />));
  };
  expect(render(account({ creditsAfterLimit: true }))).toContain(ON_BADGE);
  expect(render(account({ creditsAfterLimit: false }))).not.toContain(ON_BADGE);
  expect(render(account())).not.toContain(ON_BADGE);
  const html = render(account());
  const more = html.slice(html.indexOf('<details class="codex-account-more'), html.indexOf("</details>"));
  expect(more).toContain('aria-label="Use credits after the usage limit for');
  expect(more).toMatch(/aria-pressed="false"[^>]*aria-label="Use credits after the usage limit for/);
  expect(render(account(), false)).not.toContain("Use credits after the usage limit for");
});

test("the global switch and an account switch ask for the right state, and a pending write blocks them", async () => {
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
  const rows: boolean[] = [];
  let root: Root | null = null;
  const mount = (summary: CreditSpendSummary, enabled: boolean | undefined, saving: boolean) => withI18n(<>
    <CodexCreditSpendSwitch summary={summary} busy={saving} onToggleAll={next => all.push(next)} />
    <AccountCreditsToggle accountLabel="pool-a" enabled={enabled} saving={saving} disabled={saving} onChange={next => rows.push(next)} />
  </>);
  try {
    await act(async () => {
      root = createRoot(host as unknown as HTMLElement);
      root.render(mount({ enabled: 0, total: 2 }, undefined, false));
    });
    const globalToggle = () => host.querySelector(".codex-credit-spend .toggle") as unknown as HTMLButtonElement;
    const rowToggle = () => host.querySelector(".codex-account-credits .toggle") as unknown as HTMLButtonElement;

    await act(async () => { globalToggle().click(); });
    expect(all).toEqual([true]);
    await act(async () => { root!.render(mount({ enabled: 1, total: 2 }, true, false)); });
    await act(async () => { globalToggle().click(); });
    expect(all).toEqual([true, true]);
    await act(async () => { root!.render(mount({ enabled: 2, total: 2 }, true, false)); });
    await act(async () => { globalToggle().click(); });
    expect(all).toEqual([true, true, false]);

    // An absent field is off, so the first click turns the account on.
    await act(async () => { root!.render(mount({ enabled: 0, total: 2 }, undefined, false)); });
    await act(async () => { rowToggle().click(); });
    await act(async () => { root!.render(mount({ enabled: 1, total: 2 }, true, false)); });
    await act(async () => { rowToggle().click(); });
    expect(rows).toEqual([true, false]);

    await act(async () => { root!.render(mount({ enabled: 1, total: 2 }, true, true)); });
    expect(rowToggle().disabled).toBe(true);
    expect(globalToggle().disabled).toBe(true);
  } finally {
    await act(async () => { root?.unmount(); });
    host.remove();
  }
});
