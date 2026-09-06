/**
 * The shell is the only thing that knows whether a forced quota read succeeded, so it is
 * the only honest source for the refresh button's outcome. These tests pin that signal to
 * the actual fetch result, including the non-OK case, which `readJsonIfOk` resolves as
 * `undefined` rather than rejecting — a path that would otherwise leave a button spinning.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ProviderWorkspaceShell from "../src/components/provider-workspace/ProviderWorkspaceShell";
import { LanguageProvider } from "../src/i18n/provider";
import type { WorkspaceProvider } from "../src/provider-workspace/catalog";

const globals = ["document", "window", "navigator", "localStorage", "sessionStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let originalFetch: typeof globalThis.fetch;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let quotaMode: "ok" | "not-ok" | "reject" = "ok";

const providers: Record<string, WorkspaceProvider> = {
  "meta-muse": { adapter: "openai-responses", authMode: "oauth", baseUrl: "https://api.meta.ai/v1" } as WorkspaceProvider,
};

const OBSERVED_AT = Date.now() - 5.39 * 60 * 60_000;

function payload() {
  return {
    reports: [{
      provider: "meta-muse",
      label: "Meta Muse Code (CLI credential)",
      source: "meta-muse:subscription-observation",
      updatedAt: OBSERVED_AT,
      observed: true,
      quota: { fiveHourPercent: 1, weeklyPercent: 1, updatedAt: OBSERVED_AT },
    }],
  };
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  originalFetch = globalThis.fetch;
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
    sessionStorage: { configurable: true, value: win.sessionStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  quotaMode = "ok";
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: string) => {
      const url = String(input);
      if (url.endsWith("/api/models")) return Response.json([]);
      if (url.endsWith("/api/selected-models")) return Response.json({ selected: {}, available: {}, liveModelCounts: {} });
      if (!url.includes("/api/provider-quotas")) {
        return { ok: true, status: 200, json: async () => ({}), text: async () => "{}" } as unknown as Response;
      }
      if (quotaMode === "reject") throw new Error("quota unavailable");
      if (quotaMode === "not-ok") {
        return { ok: false, status: 503, json: async () => ({}), text: async () => "" } as unknown as Response;
      }
      const body = payload();
      return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    },
  });
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

async function mount(epoch: number, force: boolean, settled: Array<boolean>) {
  await act(async () => {
    root ??= createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderWorkspaceShell
          providers={providers}
          apiBase=""
          defaultProvider="meta-muse"
          selectedName={null}
          onSelect={() => {}}
          onAddProvider={() => {}}
          quotaRefreshEpoch={epoch}
          quotaForceRefresh={force}
          onQuotaRefreshSettled={ok => settled.push(ok)}
        />
      </LanguageProvider>,
    );
  });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
}

test("an ordinary revalidation does not report an outcome", async () => {
  const settled: boolean[] = [];
  await mount(0, false, settled);
  // Nobody is waiting on a background read; reporting one would resolve a stale promise.
  expect(settled).toEqual([]);
});

test("a forced read reports success", async () => {
  const settled: boolean[] = [];
  await mount(1, true, settled);
  expect(settled).toEqual([true]);
});

test("a non-OK response reports failure instead of silently hanging", async () => {
  quotaMode = "not-ok";
  const settled: boolean[] = [];
  await mount(1, true, settled);
  expect(settled).toEqual([false]);
});

test("a rejected fetch reports failure", async () => {
  quotaMode = "reject";
  const settled: boolean[] = [];
  await mount(1, true, settled);
  expect(settled).toEqual([false]);
});

test("the shell preserves boolean first argument and reports its captured epoch second", async () => {
  const calls: Array<[boolean, number]> = [];
  let done!: () => void;
  const settled = new Promise<void>(resolve => { done = resolve; });
  await act(async () => {
    root = createRoot(host);
    root.render(<LanguageProvider><ProviderWorkspaceShell providers={providers} apiBase="" defaultProvider="meta-muse"
      selectedName={null} onSelect={() => {}} onAddProvider={() => {}}
      quotaRefreshEpoch={17} quotaForceRefresh onQuotaRefreshSettled={(ok, epoch) => { calls.push([ok, epoch]); done(); }}
    /></LanguageProvider>);
  });
  await act(async () => { await settled; });
  expect(calls).toEqual([[true, 17]]);
});
