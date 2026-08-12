import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ACCOUNT_PRIORITY_PRESETS,
  accountPriorityLabel,
  accountPriorityPresetKey,
  DEFAULT_ACCOUNT_PRIORITY,
  formatAccountPriority,
  isAccountPriorityPreset,
  normalizeAccountPriority,
} from "../src/account-priority";
import AccountPriorityControl, { AccountPriorityBadge } from "../src/components/AccountPriorityControl";
import { LanguageProvider } from "../src/i18n/provider";

let previousLanguage: unknown;

const domGlobals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoot: Root | null;

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

function setupDom(): void {
  previousDomGlobals = Object.fromEntries(
    domGlobals.map((key) => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousDomGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mountedRoot = null;
}

async function teardownDom(): Promise<void> {
  if (mountedRoot) {
    await act(async () => {
      mountedRoot?.unmount();
    });
    mountedRoot = null;
  }
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
}

describe("account priority helpers", () => {
  test("normalizes integers inside the API range and defaults everything else", () => {
    expect(normalizeAccountPriority(2)).toBe(2);
    expect(normalizeAccountPriority(-2)).toBe(-2);
    expect(normalizeAccountPriority(100)).toBe(100);
    expect(normalizeAccountPriority(-100)).toBe(-100);
    for (const invalid of [101, -101, 1.5, NaN, "1", null, undefined, {}]) {
      expect(normalizeAccountPriority(invalid)).toBe(DEFAULT_ACCOUNT_PRIORITY);
    }
  });

  test("formats with a sign and an ASCII hyphen", () => {
    expect(formatAccountPriority(2)).toBe("+2");
    expect(formatAccountPriority(1)).toBe("+1");
    expect(formatAccountPriority(0)).toBe("0");
    expect(formatAccountPriority(-1)).toBe("-1");
    expect(formatAccountPriority(-2)).toBe("-2");
    // A Unicode minus would not round-trip through the API or the CLI column.
    expect(formatAccountPriority(-7).charCodeAt(0)).toBe(0x2d);
  });

  test("presets run first to last and map to label keys", () => {
    expect(ACCOUNT_PRIORITY_PRESETS).toEqual([2, 1, 0, -1, -2]);
    expect(ACCOUNT_PRIORITY_PRESETS.map(accountPriorityPresetKey)).toEqual([
      "accountPool.priorityFirst",
      "accountPool.priorityEarlier",
      "accountPool.priorityNormal",
      "accountPool.priorityLater",
      "accountPool.priorityLast",
    ]);
    expect(accountPriorityPresetKey(7)).toBeNull();
    expect(isAccountPriorityPreset(0)).toBe(true);
    expect(isAccountPriorityPreset(7)).toBe(false);
  });

  test("labels carry the signed number, and non-presets read as Custom", () => {
    const t = ((key: string, vars?: Record<string, string | number>) => {
      const dict: Record<string, string> = {
        "accountPool.priorityFirst": "First",
        "accountPool.priorityLast": "Last",
        "accountPool.priorityCustom": "Custom",
        "accountPool.priorityOption": "{name} ({value})",
      };
      const template = dict[key] ?? key;
      return Object.entries(vars ?? {}).reduce(
        (text, [name, value]) => text.split(`{${name}}`).join(String(value)),
        template,
      );
    }) as Parameters<typeof accountPriorityLabel>[0];

    expect(accountPriorityLabel(t, 2)).toBe("First (+2)");
    expect(accountPriorityLabel(t, -2)).toBe("Last (-2)");
    expect(accountPriorityLabel(t, 7)).toBe("Custom (+7)");
  });
});

describe("AccountPriorityControl", () => {
  // The trigger is all that renders while the menu is closed, so the options themselves are
  // asserted in the interaction block below rather than against static markup.
  test("names the control from locale keys and shows only the current order when closed", () => {
    const markup = renderToStaticMarkup(
      <LanguageProvider>
        <AccountPriorityControl value={0} selectId="order-1" onChange={() => {}} />
      </LanguageProvider>,
    );
    expect(markup).toContain("Selection order");
    expect(markup).toContain('for="order-1"');
    expect(markup).toContain('id="order-1-hint"');
    expect(markup).toContain('aria-describedby="order-1-hint"');
    expect(markup).toContain("Higher numbers are used first.");
    expect(markup).toContain("Normal (0)");
    expect(markup).not.toContain("First (+2)");
  });

  test("the badge names a non-default order and stays out of the way at zero", () => {
    expect(renderToStaticMarkup(
      <LanguageProvider><AccountPriorityBadge value={0} /></LanguageProvider>,
    )).toBe("");
    const markup = renderToStaticMarkup(
      <LanguageProvider><AccountPriorityBadge value={-1} /></LanguageProvider>,
    );
    expect(markup).toContain("Later (-1)");
    expect(markup).toContain("badge-muted");
  });

  describe("interaction", () => {
    beforeEach(() => setupDom());
    afterEach(async () => {
      await teardownDom();
    });

    async function mount(props: {
      value: number;
      selectId: string;
      disabled?: boolean;
      onChange?: (priority: number) => void;
    }): Promise<void> {
      const host = testWindow.document.createElement("div");
      testWindow.document.body.appendChild(host as never);
      const { createRoot } = await import("react-dom/client");
      await act(async () => {
        mountedRoot = createRoot(host);
        mountedRoot.render(
          <LanguageProvider>
            <AccountPriorityControl
              value={props.value}
              selectId={props.selectId}
              disabled={props.disabled}
              onChange={props.onChange ?? (() => {})}
            />
          </LanguageProvider>,
        );
      });
    }

    const trigger = (selectId: string) => {
      const element = testWindow.document.querySelector<HTMLButtonElement>(`#${selectId}`);
      if (!element) throw new Error(`selection order trigger ${selectId} missing`);
      return element;
    };
    // The menu is portaled to document.body, so the options are not under the mount node.
    const optionLabels = () =>
      [...testWindow.document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    const open = async (selectId: string) => { await act(async () => trigger(selectId).click()); };

    test("offers the five presets in first-to-last order with signed numbers", async () => {
      await mount({ value: 0, selectId: "order-live" });
      await open("order-live");

      expect(optionLabels()).toEqual(["First (+2)", "Earlier (+1)", "Normal (0)", "Later (-1)", "Last (-2)"]);
    });

    test("prepends a stored value the presets do not cover as a selectable peer", async () => {
      await mount({ value: 7, selectId: "order-custom" });
      expect(trigger("order-custom").textContent).toContain("Custom (+7)");

      await open("order-custom");
      // Custom sits ahead of the presets so the current value is the first option.
      expect(optionLabels()).toEqual([
        "Custom (+7)", "First (+2)", "Earlier (+1)", "Normal (0)", "Later (-1)", "Last (-2)",
      ]);
    });

    test("a value outside the API range falls back to the default order", async () => {
      await mount({ value: 9001, selectId: "order-bogus" });
      expect(trigger("order-bogus").textContent).toContain("Normal (0)");

      await open("order-bogus");
      expect(optionLabels()).not.toContain("Custom (+9001)");
      expect(optionLabels()).toHaveLength(ACCOUNT_PRIORITY_PRESETS.length);
    });

    test("parses the chosen option back into a number", async () => {
      const seen: number[] = [];
      await mount({ value: 0, selectId: "order-live", onChange: (priority) => { seen.push(priority); } });

      for (const label of ["Last (-2)", "First (+2)"]) {
        await open("order-live");
        const option = [...testWindow.document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
          .find((candidate) => candidate.textContent === label);
        if (!option) throw new Error(`option ${label} missing`);
        await act(async () => option.click());
      }

      expect(seen).toEqual([-2, 2]);
    });

    test("disabled blocks the control while a save is in flight", async () => {
      await mount({ value: 1, selectId: "order-busy", disabled: true });

      expect(trigger("order-busy").disabled).toBe(true);
      await open("order-busy");
      expect(optionLabels()).toEqual([]);
    });
  });
});
