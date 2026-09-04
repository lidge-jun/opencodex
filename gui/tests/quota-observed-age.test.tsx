/**
 * The observation-age affordance for a passively reported quota.
 *
 * Two things are asserted, and the second matters as much as the first: the age appears
 * when it is passed, and it stays ABSENT for every other caller of this shared component.
 * QuotaBars is used by the Codex pool, the provider overview and the combo workspace,
 * where an age line would be noise on numbers that refresh on their own TTL.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import QuotaBars, { formatObservedAge } from "../src/components/QuotaBars";
import { LanguageProvider } from "../src/i18n/provider";
import type { AccountQuota } from "../src/codex-quota-utils";

const domGlobals = ["document", "window", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoots: Root[];

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
  mountedRoots = [];
}

async function teardownDom(): Promise<void> {
  for (const root of mountedRoots) {
    await act(async () => { root.unmount(); });
  }
  mountedRoots = [];
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function quota(): AccountQuota {
  return { fiveHourPercent: 12, weeklyPercent: 34, updatedAt: Date.now() };
}

/**
 * Stub translator: returns the key, except for the age string, where the real English
 * copy is used so the {age} substitution has something to replace. Asserting on the
 * substituted output is the point -- a stub that returned the bare key would pass while
 * the placeholder went unreplaced in production.
 */
const EN: Record<string, string> = {
  "quota.observedAgo": "Observed {age} ago",
  "quota.ageMinutes": "{n}m",
  "quota.ageHours": "{n}h",
  "quota.ageDays": "{n}d",
};
const t = ((key: string) => EN[key] ?? key) as never;

async function mount(props: Partial<Parameters<typeof QuotaBars>[0]>): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host);
  const root = createRoot(host as unknown as HTMLElement);
  mountedRoots.push(root);
  await act(async () => {
    root.render(
      <LanguageProvider>
        <QuotaBars quota={quota()} plan={null} threshold={80} t={t} {...props as never} />
      </LanguageProvider>,
    );
  });
  return host as unknown as HTMLElement;
}

beforeEach(setupDom);
afterEach(teardownDom);

describe("formatObservedAge", () => {
  const now = Date.now();

  test("stays silent under a minute rather than claiming precision it lacks", () => {
    expect(formatObservedAge(now, t, now)).toBeNull();
    expect(formatObservedAge(now - 59_000, t, now)).toBeNull();
  });

  test.each([
    [MINUTE, "1m"],
    [59 * MINUTE, "59m"],
    [HOUR, "1h"],
    [23 * HOUR, "23h"],
    [DAY, "1d"],
    [9 * DAY, "9d"],
  ])("buckets %i ms as %s", (elapsed, expected) => {
    expect(formatObservedAge(now - (elapsed as number), t, now)).toBe(expected);
  });

  /* Proxy and browser clocks can disagree; a negative age must not render as "-3m". */
  test("clock skew reads as no age, never a negative one", () => {
    expect(formatObservedAge(now + 5 * MINUTE, t, now)).toBeNull();
  });
});

describe("QuotaBars observation age", () => {
  test("renders the age and its explanatory hint when observedAt is passed", async () => {
    const host = await mount({ observedAt: Date.now() - 12 * MINUTE, layout: "stacked" });
    const observed = host.querySelector(".quota-observed");
    expect(observed).not.toBeNull();
    expect(observed!.textContent).toContain("12m");
    // The hint is what tells a user WHY this one provider lags; without it the age is
    // just an unexplained number.
    expect(observed!.getAttribute("title")).toBe("quota.observedHint");
  });

  test("renders it in the compact layout too", async () => {
    const host = await mount({ observedAt: Date.now() - 3 * HOUR, layout: "compact" });
    expect(host.querySelector(".quota-observed")?.textContent).toContain("3h");
  });

  /* The regression that protects every other caller of this shared component. */
  test("renders no age line when observedAt is omitted", async () => {
    const host = await mount({ layout: "stacked" });
    expect(host.querySelector(".quota-observed")).toBeNull();
  });

  test("renders no age line for an observation younger than a minute", async () => {
    const host = await mount({ observedAt: Date.now() - 5_000, layout: "stacked" });
    expect(host.querySelector(".quota-observed")).toBeNull();
  });

  /* An account with no observation must render nothing at all, not a zero bar. */
  test("renders nothing when there is no quota and nothing is pending", async () => {
    const host = await mount({ quota: null, observedAt: Date.now() - HOUR, layout: "stacked" });
    expect(host.querySelector(".quota-observed")).toBeNull();
    expect(host.querySelector(".quota-stacked")).toBeNull();
    expect(host.textContent).toBe("");
  });
});
