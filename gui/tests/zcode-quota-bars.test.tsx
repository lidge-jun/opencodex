import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import { ProviderCapacityQuota } from "../src/components/provider-workspace/ProviderCapacityQuota";
import ProviderCurrentQuota from "../src/components/provider-workspace/ProviderCurrentQuota";

const report = () => ({ source: "zcode-desktop", updatedAt: Date.now(), quota: {
  updatedAt: Date.now(), fiveHourPercent: 25, weeklyPercent: 90,
  fiveHourResetAt: Date.now() + 3600000, weeklyResetAt: Date.now() + 86400000,
} });

test("ZCode uses shared bars with remaining balances and reset labels", () => {
  const html = renderToStaticMarkup(<LanguageProvider><ProviderCapacityQuota report={report()} pending={false} /></LanguageProvider>);
  expect(html).toContain("75% remaining");
  expect(html).toContain("10% remaining");
  expect(html).toContain('aria-valuenow="75"');
  expect(html).toContain('--bar-scale:0.75');
  expect(html).toContain('quota-stacked-reset');
});

test("current account Usage retains the native source through the shared renderer", () => {
  const html = renderToStaticMarkup(<LanguageProvider><ProviderCurrentQuota report={report()} /></LanguageProvider>);
  expect(html).toContain("75% remaining");
  expect(html).toContain("10% remaining");
});

test("OpenAI keeps its existing consumption display and width", () => {
  const html = renderToStaticMarkup(<LanguageProvider><ProviderCapacityQuota report={{ ...report(), source: "openai" }} pending={false} /></LanguageProvider>);
  expect(html).toContain("25% used");
  expect(html).toContain("90% used");
  expect(html).not.toContain("remaining");
  expect(html).toContain('--bar-scale:0.25');
});

test("an exhausted native quota stays exhausted and missing quota has no progress bar", () => {
  const html = renderToStaticMarkup(<LanguageProvider><ProviderCapacityQuota report={{ ...report(), quota: { updatedAt: Date.now(), fiveHourPercent: 100 } }} pending={false} /></LanguageProvider>);
  expect(html).toContain("0% remaining");
  expect(html).toContain("Limit reached");
  const missing = renderToStaticMarkup(<LanguageProvider><ProviderCapacityQuota report={{ source: "zcode-desktop" }} pending={false} /></LanguageProvider>);
  expect(missing).not.toContain('role="progressbar"');
});
