import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Root } from "react-dom/client";
import AccountCreditsToggle from "../src/components/AccountCreditsToggle";
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

function poolAccount(overrides: Partial<CodexAccountEntry> = {}): CodexAccountEntry {
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

function toggleState(html: string): string | undefined {
  return html.match(/aria-pressed="(true|false)"[^>]*aria-label="Use credits after the usage limit/)?.[1];
}

afterEach(() => {
  for (const key of globals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function renderCard(kind: "main" | "pool", account: CodexAccountEntry, creditsVisible: boolean | undefined, wired = true): string {
  const onToggleCreditsAfterLimit = wired ? () => {} : undefined;
  return renderToStaticMarkup(withI18n(kind === "main"
    ? <CodexAccountPoolMainCard {...cardProps} t={t} main={{ ...account, id: "__main__", isMain: true }} isMainActive
        creditsVisible={creditsVisible} onToggleCreditsAfterLimit={onToggleCreditsAfterLimit} />
    : <CodexAccountPoolCards {...cardProps} pool={[account]} creditsVisible={creditsVisible}
        onToggleCreditsAfterLimit={onToggleCreditsAfterLimit} />));
}

const OFF_BADGE = `>${en["codexAuth.creditsOff"]}</span>`;

test.each(["main", "pool"] as const)("%s card shows the switch with the Codex credits display, on by default", kind => {
  // A row from an older server carries no field, and on is the default.
  expect(toggleState(renderCard(kind, poolAccount(), true))).toBe("true");
  expect(toggleState(renderCard(kind, poolAccount({ creditsAfterLimit: true }), true))).toBe("true");
  expect(toggleState(renderCard(kind, poolAccount({ creditsAfterLimit: false }), true))).toBe("false");
  expect(renderCard(kind, poolAccount({ creditsAfterLimit: false }), true)).not.toContain(OFF_BADGE);
});

test.each(["main", "pool"] as const)("%s card hides the switch with the display off but still badges a held account", kind => {
  for (const visible of [false, undefined]) {
    expect(toggleState(renderCard(kind, poolAccount({ creditsAfterLimit: false }), visible))).toBeUndefined();
    expect(renderCard(kind, poolAccount({ creditsAfterLimit: false }), visible)).toContain(OFF_BADGE);
    expect(renderCard(kind, poolAccount(), visible)).not.toContain(OFF_BADGE);
  }
});

test("a card leaves the switch out when the page does not wire it", () => {
  expect(toggleState(renderCard("pool", poolAccount(), true, false))).toBeUndefined();
  expect(toggleState(renderCard("main", poolAccount(), true, false))).toBeUndefined();
});

test("clicking the switch asks for the opposite state and a pending write blocks it", async () => {
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
  const requested: boolean[] = [];
  let root: Root | null = null;
  const mount = (enabled: boolean | undefined, saving: boolean) => withI18n(
    <AccountCreditsToggle accountLabel="pool-a" enabled={enabled} saving={saving} disabled={saving}
      onChange={next => requested.push(next)} />,
  );
  try {
    await act(async () => {
      root = createRoot(host as unknown as HTMLElement);
      root.render(mount(undefined, false));
    });
    const button = () => host.querySelector("button.toggle") as unknown as HTMLButtonElement;
    await act(async () => { button().click(); });
    expect(requested).toEqual([false]);

    await act(async () => { root!.render(mount(false, false)); });
    await act(async () => { button().click(); });
    expect(requested).toEqual([false, true]);

    await act(async () => { root!.render(mount(false, true)); });
    expect(button().disabled).toBe(true);
    await act(async () => { button().click(); });
    expect(requested).toEqual([false, true]);
  } finally {
    await act(async () => { root?.unmount(); });
    host.remove();
  }
});
