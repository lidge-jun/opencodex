import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import QuotaBars, { buildQuotaRows } from "../src/components/QuotaBars";
import { QuotaSummaryChips } from "../src/components/quota-summary-bar/QuotaSummaryBar";
import { en } from "../src/i18n/en";
import { I18nContext, interpolate, type TFn } from "../src/i18n/shared";
import { freshQuotaReportsFromResponse } from "../src/provider-workspace/report";
import { buildQuotaSummary, type QuotaSummaryRow } from "../src/quota-summary";
import { quotaWindows } from "../src/pages/tray-data";

const t: TFn = (key, vars) => interpolate(en[key], vars);

const globals = ["document", "window", "navigator", "requestAnimationFrame", "cancelAnimationFrame", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  previousGlobals = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#dashboard" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    requestAnimationFrame: { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) },
    cancelAnimationFrame: { configurable: true, value: (id: number) => clearTimeout(id) },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  testWindow.close();
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
});

async function mountSummary(rows: QuotaSummaryRow[]) {
  const container = document.createElement("div");
  document.body.append(container);
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  await act(async () => { root.render(<QuotaSummaryChips rows={rows} t={t} locale="en" />); });
  return { container, unmount: () => act(async () => { root.unmount(); }) };
}
const render = (node: ReactNode) => renderToStaticMarkup(
  <I18nContext.Provider value={{ t, locale: "en", setLocale: () => {} }}>{node}</I18nContext.Provider>,
);

const now = Date.now();
const resetAt = now + 3_600_000;
// Exactly what the Mistral probe publishes: one measured budget and one whose entitlement was
// not reported. The measured row's display text is presentation only; the label stays identity.
const quota = {
  customWindows: [{ label: "API budget", displayLabel: "API budget (EUR 12.50 of EUR 50.00 used; TEAM)", percent: 25, resetAt }],
  unknownBudgetWindows: [{ label: "Vibe budget (TEAM)", resetAt }],
  updatedAt: now,
};

function summaryRows(): QuotaSummaryRow[] {
  return buildQuotaSummary(freshQuotaReportsFromResponse([
    { provider: "mistral", label: "Mistral", updatedAt: now, quota },
  ], now), provider => provider);
}

test("unknown budget is a neutral summary headline, never 0%, 100% or a warning", () => {
  const [row] = summaryRows();
  expect(row!.headline.id).toBe("API budget");
  expect(row!.headline.percent).toBe(25);
  expect(row!.severity).toBe("normal");
  const unknown = row!.windows.find(window => window.id === "Vibe budget (TEAM)")!;
  expect(unknown.unknownBudget).toBe(true);
  expect(unknown.percent).toBeUndefined();
  expect(unknown.severity).toBe("normal");
  expect(row!.windows.map(window => window.id)).toEqual(["API budget", "Vibe budget (TEAM)"]);
});

test("an unknown-only budget still produces a row, with unknown as the headline", () => {
  const rows = buildQuotaSummary(freshQuotaReportsFromResponse([
    { provider: "mistral", label: "Mistral", updatedAt: now, quota: { unknownBudgetWindows: [{ label: "API budget", resetAt }], updatedAt: now } },
  ], now), provider => provider);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.headline.unknownBudget).toBe(true);
  expect(rows[0]!.headline.percent).toBeUndefined();
  expect(rows[0]!.severity).toBe("normal");
});

test("summary chip shows the measured percent and no warning for the unknown budget", async () => {
  const view = await mountSummary(summaryRows());
  const item = view.container.querySelector(".quota-summary-item")!;
  expect(item.className).toBe("quota-summary-item quota-summary-item--normal");
  expect(item.querySelector(".quota-summary-pct")!.textContent).toBe("25%");
  expect(item.querySelector(".quota-summary-flag")).toBeNull();
  await view.unmount();
});

test("an unknown-only chip and detail row say Quota unknown, never a percentage", async () => {
  const rows = buildQuotaSummary(freshQuotaReportsFromResponse([
    { provider: "mistral", label: "Mistral", updatedAt: now, quota: { unknownBudgetWindows: [{ label: "API budget", resetAt }], updatedAt: now } },
  ], now), provider => provider);
  const view = await mountSummary(rows);
  const item = view.container.querySelector(".quota-summary-item")!;
  expect(item.className).toBe("quota-summary-item quota-summary-item--normal");
  expect(item.querySelector(".quota-summary-pct")!.textContent).toBe(en["cws.quota.unknown"]);
  expect(item.textContent).not.toContain("%");
  expect(item.textContent).not.toContain("-");
  await view.unmount();
});

test("QuotaBars renders the unknown budget as Quota unknown with its reset, not as a percentage", () => {
  const html = render(<QuotaBars quota={quota} plan={null} threshold={80} t={t} />);
  expect(html).toContain(en["cws.quota.unknown"]);
  expect(html).toContain("Vibe budget (TEAM)");
  // The measured row shows its display text, and the raw label remains the row identity.
  expect(html).toContain("API budget (EUR 12.50 of EUR 50.00 used; TEAM)");
  expect(html).toContain("25%");
  const rows = buildQuotaRows(quota, null, t);
  expect(rows.map(row => row.customLabel)).toEqual(["API budget"]);
  expect(rows[0]!.displayLabel).toBe("API budget (EUR 12.50 of EUR 50.00 used; TEAM)");
  expect(rows[0]!.percent).toBe(25);
});

test("tray windows carry display text and an unknown row without inventing a percent", () => {
  const windows = quotaWindows(quota);
  expect(windows.map(window => window.id)).toEqual(["API budget", "Vibe budget (TEAM)"]);
  expect(windows[0]).toMatchObject({ label: "API budget", displayLabel: "API budget (EUR 12.50 of EUR 50.00 used; TEAM)", percent: 25 });
  expect(windows[1]).toMatchObject({ label: "Vibe budget (TEAM)", percent: undefined, unknownBudget: true });
  expect("displayLabel" in windows[1]!).toBe(false);
});

// Independent review #8295: the header summary derived its own window list and copied only
// `label`, so the measured Mistral budget lost the amount and plan text that QuotaBars and
// the tray already show. These cases pin the summary and its popover to the same display
// text while leaving every other provider's row exactly as it was.
const mistralReport = (quota: Record<string, unknown>) => freshQuotaReportsFromResponse([
  { provider: "mistral", label: "Mistral", updatedAt: now, quota },
], now);

function rowsOf(reports: ReturnType<typeof freshQuotaReportsFromResponse>): QuotaSummaryRow[] {
  return buildQuotaSummary(reports, provider => provider);
}

test("summary window keeps the measured display text while identity stays the raw label", () => {
  const [row] = rowsOf(mistralReport({
    customWindows: [{ label: "API budget", displayLabel: "API budget (EUR 12.50 of EUR 50.00 used; TEAM)", percent: 25, resetAt }],
    updatedAt: now,
  }));
  const measured = row!.windows.find(window => window.id === "API budget")!;
  expect(measured.label).toBe("API budget");
  expect(measured.displayLabel).toBe("API budget (EUR 12.50 of EUR 50.00 used; TEAM)");
  expect(measured.percent).toBe(25);
  expect(row!.headline.displayLabel).toBe("API budget (EUR 12.50 of EUR 50.00 used; TEAM)");
  // The plan text is presentation, not a severity or identity input.
  expect(row!.severity).toBe("normal");
});

test("popover shows the measured amount and plan, and the unknown budget beside it", async () => {
  const view = await mountSummary(rowsOf(mistralReport({
    customWindows: [{ label: "API budget", displayLabel: "API budget (EUR 12.50 of EUR 50.00 used; TEAM)", percent: 25, resetAt }],
    unknownBudgetWindows: [{ label: "Vibe budget (TEAM)", resetAt }],
    updatedAt: now,
  })));
  const chip = view.container.querySelector(".quota-summary-chip")!;
  await act(async () => {
    chip.dispatchEvent(new (window as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent("pointerover", {
      bubbles: true, pointerType: "mouse", relatedTarget: document.body,
    }) as unknown as Event);
  });
  const popover = view.container.querySelector(".quota-summary-popover")!;
  const headers = [...popover.querySelectorAll("th")].map(cell => cell.textContent);
  expect(headers).toEqual(["API budget (EUR 12.50 of EUR 50.00 used; TEAM)", "Vibe budget (TEAM)"]);
  const cells = [...popover.querySelectorAll("tr")].map(row => [...row.querySelectorAll("td")].map(cell => cell.textContent));
  expect(cells[0]![0]).toBe("25%");
  expect(cells[1]![0]).toBe(en["cws.quota.unknown"]);
  await view.unmount();
});

test("unknown-only Mistral keeps its plan text and never shows a percentage", () => {
  const [row] = rowsOf(mistralReport({ unknownBudgetWindows: [{ label: "Vibe budget (TEAM)", resetAt }], updatedAt: now }));
  expect(row!.headline.unknownBudget).toBe(true);
  expect(row!.headline.label).toBe("Vibe budget (TEAM)");
  expect(row!.headline.displayLabel).toBeUndefined();
  expect(row!.headline.percent).toBeUndefined();
});

test("a non-Mistral provider keeps the raw label with no display text", () => {
  const [row] = rowsOf(freshQuotaReportsFromResponse([
    { provider: "gemini", label: "Google", updatedAt: now, quota: { customWindows: [{ label: "Daily", percent: 8, resetAt }], updatedAt: now } },
  ], now));
  expect(row!.headline.label).toBe("Daily");
  expect(row!.headline.displayLabel).toBeUndefined();
  expect(row!.headline.percent).toBe(8);
});
