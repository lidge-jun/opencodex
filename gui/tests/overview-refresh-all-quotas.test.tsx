/**
 * The Provider Overview's refresh-all-quotas control.
 *
 * The aggregate view stacks every provider's rate-limit bars and labels each with its
 * age ("checked 2 minutes ago"), so it tells the operator the numbers are stale and,
 * until this control existed, offered nothing to do about it. Per-provider refresh
 * lived one drill-down away in the Usage and Accounts tabs.
 *
 * What actually needs proving is the honesty of the result, not the presence of a
 * button: `fetchProviderQuotas(true)` is a synchronous state bump, so a control that
 * resolved on its own click would report success while the old numbers were still on
 * screen. The truthful answer arrives later, from the settled promise the shell owns.
 * That is a runtime property, so these are DOM tests rather than source assertions.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import ProviderOverviewDashboard from "../src/components/provider-workspace/ProviderOverviewDashboard";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceSections } from "../src/provider-workspace/catalog";

const domGlobals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousDomGlobals: Record<(typeof domGlobals)[number], unknown>;
let testWindow: Window;
let mountedRoots: Root[];

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => testWindow.setTimeout(resolve, 0));
  await Promise.resolve();
}

const SECTIONS: WorkspaceSections = {
  ready: [{ name: "anthropic", adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" }],
  needsSetup: [],
  disabled: [],
};

async function mountOverview(onRefreshAllQuotas?: () => Promise<boolean>): Promise<HTMLElement> {
  const host = testWindow.document.createElement("div");
  testWindow.document.body.appendChild(host as never);
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    const root = createRoot(host);
    mountedRoots.push(root);
    root.render(
      <LanguageProvider>
        <ProviderOverviewDashboard
          sections={SECTIONS}
          quotaReports={{}}
          usageTotals={{}}
          onSelectProvider={() => {}}
          {...(onRefreshAllQuotas ? { onRefreshAllQuotas } : {})}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await flush(); });
  return host as unknown as HTMLElement;
}

function headerButtons(host: ParentNode): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>(".pws-dashboard-header-actions button")];
}

function refreshButton(host: ParentNode): HTMLButtonElement {
  const found = headerButtons(host).find(b => (b.textContent ?? "").toLowerCase().includes("refresh"));
  if (!found) throw new Error("refresh control missing from the overview header");
  return found;
}

beforeEach(() => {
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
});

afterEach(async () => {
  for (const root of mountedRoots) {
    await act(async () => { root.unmount(); });
  }
  mountedRoots = [];
  for (const key of domGlobals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousDomGlobals[key] });
  }
  await testWindow.happyDOM?.close?.();
});

test("the control is absent when the page cannot drive a refresh", async () => {
  const host = await mountOverview();
  expect(headerButtons(host).some(b => (b.textContent ?? "").toLowerCase().includes("refresh"))).toBe(false);
});

test("the control stays disabled until the read settles, then reports success", async () => {
  let release!: (ok: boolean) => void;
  const settled = new Promise<boolean>(resolve => { release = resolve; });
  let calls = 0;
  const host = await mountOverview(() => { calls += 1; return settled; });

  const button = refreshButton(host);
  await act(async () => { button.click(); await flush(); });

  // Still in flight: a control that reported here would be lying about stale bars.
  expect(calls).toBe(1);
  expect(refreshButton(host).disabled).toBe(true);
  expect(host.querySelector('[role="status"]')).toBeNull();

  // A second click while disabled must not issue a second forced read: a re-run
  // cancels the first effect, and a cancelled read never settles its waiters.
  await act(async () => { refreshButton(host).click(); await flush(); });
  expect(calls).toBe(1);

  await act(async () => { release(true); await flush(); });

  expect(refreshButton(host).disabled).toBe(false);
  const status = host.querySelector('[role="status"]');
  expect(status?.className).toContain("pws-status-ok");
  // Deliberately "complete", not "refreshed": the server answers 200 even when one
  // upstream probe failed and its provider kept a last-good row, so claiming every
  // number is fresh would overstate what the read actually proved.
  expect(status?.textContent ?? "").toContain("complete");
  expect(status?.textContent ?? "").not.toContain("refreshed");
});

test("a failed read is reported as a failure, not silence", async () => {
  const host = await mountOverview(() => Promise.resolve(false));
  await act(async () => { refreshButton(host).click(); await flush(); });

  const status = host.querySelector('[role="status"]');
  expect(status?.className).toContain("pws-status-warn");
  expect(refreshButton(host).disabled).toBe(false);
});

test("a thrown refresh is reported as a failure too", async () => {
  const host = await mountOverview(() => Promise.reject(new Error("network down")));
  await act(async () => { refreshButton(host).click(); await flush(); });

  expect(host.querySelector('[role="status"]')?.className).toContain("pws-status-warn");
  expect(refreshButton(host).disabled).toBe(false);
});
