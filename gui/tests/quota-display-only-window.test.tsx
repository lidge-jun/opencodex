/**
 * An Anthropic model limit that upstream reports as not binding (`is_active: false`) is still a
 * real allowance: Claude's own usage page shows it. The bar must say what share of the week it may
 * use and that it is not the limit in effect, so a reader does not mistake it for the binding one.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import QuotaBars from "../src/components/QuotaBars";
import { en } from "../src/i18n/en";
import { LanguageProvider } from "../src/i18n/provider";
import { interpolate, type TFn } from "../src/i18n/shared";
import { accountQuotaFromReport } from "../src/provider-workspace/report";

const domGlobals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let root: Root | undefined;
const t: TFn = (key, vars) => interpolate(en[key] ?? key, vars);

beforeEach(() => {
  previous = Object.fromEntries(domGlobals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  for (const key of domGlobals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  await testWindow.happyDOM?.close?.();
});

async function mount(quota: unknown, layout: "stacked" | "compact"): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
  await act(async () => {
    root!.render(<LanguageProvider>
      <QuotaBars quota={accountQuotaFromReport({ quota })} threshold={80} t={t} layout={layout} />
    </LanguageProvider>);
  });
  return host as unknown as HTMLElement;
}

const resetAt = Date.now() + 4 * 86_400_000;
const inactiveFable = { updatedAt: Date.now(), fiveHourPercent: 35, weeklyPercent: 91, weeklyResetAt: resetAt,
  displayWindows: [{ label: "Fable", scope: "model", percent: 4, resetAt, weeklyAllowancePercent: 50 }] };

test("the stacked account bar shows Fable's own percent, its weekly share and that it is not in effect", async () => {
  const host = await mount(inactiveFable, "stacked");
  const rows = [...host.querySelectorAll(".quota-stacked-row")];
  expect(rows.map(row => row.querySelector(".quota-stacked-limit")?.textContent)).toEqual([en["quota.fiveHourLimit"], en["quota.weeklyLimit"], "Fable"]);
  const fable = rows[2]!;
  expect(fable.querySelector(".quota-stacked-used")?.textContent).toBe("4% used");
  expect(fable.querySelector(".quota-window-share")?.textContent).toBe("Up to 50% of your weekly limit");
  const tag = fable.querySelector(".quota-window-inactive");
  expect(tag?.textContent).toBe(en["quota.notInEffect"]);
  expect(tag?.getAttribute("title")).toBe(en["quota.notInEffectHint"]);
  expect(fable.querySelector(".quota-stacked-reset")?.textContent).not.toBe("");
  // The binding weekly row carries neither marker.
  expect(rows[1]!.querySelector(".quota-window-inactive, .quota-window-share")).toBeNull();
});

test("the compact bar names the share and the inactive state in its label hint", async () => {
  const host = await mount(inactiveFable, "compact");
  const label = [...host.querySelectorAll(".quota-label")].find(node => node.textContent === "Fable");
  expect(label?.getAttribute("title")).toContain("Up to 50% of your weekly limit");
  expect(label?.getAttribute("title")).toContain(en["quota.notInEffect"]);
});

test("a routed Fable row shows its share without the inactive marker", async () => {
  const host = await mount({ updatedAt: Date.now(), weeklyPercent: 10,
    customWindows: [{ label: "Fable", scope: "model", percent: 60, resetAt, weeklyAllowancePercent: 50 }] }, "stacked");
  const fable = [...host.querySelectorAll(".quota-stacked-row")].find(row => row.querySelector(".quota-stacked-limit")?.textContent === "Fable");
  expect(fable?.querySelector(".quota-window-share")?.textContent).toBe("Up to 50% of your weekly limit");
  expect(fable?.querySelector(".quota-window-inactive")).toBeNull();
});
