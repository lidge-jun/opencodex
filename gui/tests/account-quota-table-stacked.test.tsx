/**
 * Per-account quota rows stack again (#fb-2100): in the card layout the pool name sits on its own
 * line, the 5-hour bar on the next and the weekly bar on the third, each with its "% left" and
 * reset countdown, as v2.100.5 showed them. #8740 had put the three side by side.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { AccountQuotaTable } from "../src/components/provider-workspace/AccountQuotaTable";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS } from "../src/i18n/shared";

const en = DICTS.en;
const HOUR = 3_600_000;
const domGlobals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof domGlobals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let root: Root | null = null;

beforeEach(() => {
  previous = Object.fromEntries(domGlobals.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)])) as typeof previous;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  for (const key of domGlobals) {
    const descriptor = previous[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
  await testWindow.happyDOM?.close?.();
});

async function renderTable(): Promise<HTMLElement> {
  const now = Date.now();
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <AccountQuotaTable accounts={[
          { id: "a", label: "alex@example.test", plan: "max", active: true, paused: false,
            quota: { fiveHourPercent: 0, fiveHourResetAt: now + 4 * HOUR, weeklyPercent: 100, weeklyResetAt: now + 60 * HOUR } },
          { id: "b", label: "sam@example.test", plan: "pro", active: false, paused: false,
            quota: { fiveHourPercent: 42, fiveHourResetAt: now + HOUR, weeklyPercent: 18, weeklyResetAt: now + 130 * HOUR } },
        ]} />
      </LanguageProvider>,
    );
  });
  return host as unknown as HTMLElement;
}

describe("account quota rows", () => {
  test("each pool cell reads as three lines: pool name, 5-hour bar, weekly bar", async () => {
    const host = await renderTable();
    const cells = Array.from(host.querySelectorAll("td.aqt-pool"));
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      const lines = Array.from(cell.children).map(child => child.textContent ?? "");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe(en["acctTable.pool.subscription"]);
      expect(lines[1]!.startsWith(en["acctTable.fiveHour"])).toBe(true);
      expect(lines[2]!.startsWith(en["acctTable.weekly"])).toBe(true);
      // The column header already names the pool for assistive technology.
      expect(cell.children[0]!.getAttribute("aria-hidden")).toBe("true");
    }
    const first = cells[0]!.children;
    expect(first[1]!.textContent).toContain("100% left");
    expect(first[1]!.textContent).toContain("resets in");
    expect(first[2]!.textContent).toContain("0% left");
  });

  test("no card-layout rule lays a pool's name and bars out side by side", async () => {
    const css = (await Bun.file(new URL("../src/components/provider-workspace/account-quota-table.css", import.meta.url)).text())
      .replace(/\/\*[\s\S]*?\*\//g, "");
    // Every pool cell rule, at every container width, keeps a single column.
    for (const match of css.matchAll(/([^{}]*\.aqt-pool[^{}]*)\{([^}]*)\}/g)) {
      const [, selector, body] = match;
      expect({ selector: selector!.trim(), columns: /grid-template-columns/.test(body!) }).toEqual({ selector: selector!.trim(), columns: false });
      expect({ selector: selector!.trim(), placed: /grid-(row|column|area)/.test(body!) }).toEqual({ selector: selector!.trim(), placed: false });
    }
    expect(css).not.toContain("attr(data-label)");
    // The pool name line exists only where the table header is hidden.
    expect(css).toMatch(/(^|\n)\.aqt-pool-label\s*\{[^}]*display:\s*none/);
    const narrow = css.slice(css.indexOf("@container (max-width: 1100px)"));
    expect(narrow).toMatch(/\.aqt-pool-label\s*\{[^}]*display:\s*block/);
  });
});
