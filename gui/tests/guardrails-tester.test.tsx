import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { GuardrailsTesterPanel } from "../src/pages/guardrails/tester-panel";
import type { GuardrailsTrafficProtection } from "../src/pages/guardrails/types";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;
let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Reflect.get(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/#guardrails/tester" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
});

afterEach(async () => {
  if (root) {
    const mounted = root;
    await act(async () => { mounted.unmount(); });
    root = null;
  }
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: previousGlobals[key],
    });
  }
});

async function renderTester(
  trafficProtection?: GuardrailsTrafficProtection,
) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(
      <LanguageProvider>
        <GuardrailsTesterPanel
          apiBase="http://guardrails.test"
          trafficProtection={trafficProtection}
        />
      </LanguageProvider>,
    );
  });
}

async function mount() {
  await renderTester();
}

async function enterText(value: string) {
  const textarea = host.querySelector("textarea")!;
  const setter = Object.getOwnPropertyDescriptor(
    testWindow.HTMLTextAreaElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(textarea, value);
    textarea.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => candidate.textContent?.trim() === label)!;
}

test("tester is explicitly a local simulation for synthetic values", async () => {
  await mount();

  expect(host.textContent).toContain("Local simulation");
  expect(host.textContent).toContain("synthetic test values");
  expect(host.textContent).toContain("protection status is still unknown");
});

test("UTF-8 byte limit disables scanning above 128 KiB", async () => {
  await mount();
  await enterText("€".repeat(43_691));

  const scan = button("Scan");
  expect(scan.disabled).toBe(true);
  expect(host.querySelector(".guardrails-byte-over")).not.toBeNull();
  expect(host.textContent).toContain("131073 / 131072 bytes");
});

test("UTF-8 byte limit accepts exactly 128 KiB", async () => {
  await mount();
  await enterText(`${"€".repeat(43_690)}aa`);

  expect(button("Scan").disabled).toBe(false);
  expect(host.querySelector(".guardrails-byte-over")).toBeNull();
  expect(host.textContent).toContain("131072 / 131072 bytes");
});

test("Clear aborts an in-flight scan and resets the tester", async () => {
  let aborted = false;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: (_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("Aborted", "AbortError"));
      });
    }),
  });
  await mount();
  await enterText("token=secret");

  await act(async () => { button("Scan").click(); });
  expect(button("Scanning…").disabled).toBe(true);

  await act(async () => {
    button("Clear").click();
    await Promise.resolve();
  });
  expect(aborted).toBe(true);
  expect(host.querySelector("textarea")?.value).toBe("");
  expect(button("Scan").disabled).toBe(true);
  expect(host.querySelector(".notice-err")).toBeNull();
});

test("draft settings are sent without saving and label the result", async () => {
  let requestBody: unknown;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (_url: string, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as unknown;
      return Response.json({
        mode: "draft",
        simulation: true,
        trafficProtection: "disabled",
        maskedPreview: "safe",
        findingCount: 0,
        findings: [],
      });
    },
  });
  await mount();

  await act(async () => {
    host.querySelector<HTMLButtonElement>('button[aria-label="Use draft settings"]')!.click();
  });
  await enterText("sample");
  await act(async () => {
    button("Scan").click();
    await new Promise(resolve => setTimeout(resolve, 5));
  });

  expect(requestBody).toEqual({
    text: "sample",
    settings: {
      enabled: true,
      enabledDataTypes: [1, 2, 3, 4, 5, 6],
      keywordPrefilterEnabled: false,
    },
  });
  expect(host.textContent).toContain("Draft settings");
  expect(host.textContent).toContain("Real traffic protection is disabled");
});

test("detect-only traffic and no-findings result do not imply protection", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => Response.json({
      mode: "effective",
      simulation: true,
      trafficProtection: "detect",
      maskedPreview: "synthetic sample",
      findingCount: 0,
      findings: [],
    }),
  });
  await mount();
  await enterText("synthetic sample");
  await act(async () => {
    button("Scan").click();
    await new Promise(resolve => setTimeout(resolve, 5));
  });

  expect(host.textContent).toContain("Real traffic is detect-only and is not masked");
  expect(host.textContent).toContain("Enabled rules found no matches");
  expect(host.textContent).toContain("does not guarantee");
  expect(host.textContent).not.toContain("No sensitive values detected");
});

test("live traffic mode overrides a stale tester result", async () => {
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => Response.json({
      mode: "effective",
      simulation: true,
      trafficProtection: "enforce",
      maskedPreview: "synthetic sample",
      findingCount: 0,
      findings: [],
    }),
  });
  await renderTester("enforce");
  await enterText("synthetic sample");
  await act(async () => {
    button("Scan").click();
    await new Promise(resolve => setTimeout(resolve, 5));
  });
  expect(host.textContent).not.toContain("Real traffic is detect-only");

  await renderTester("detect");

  expect(host.textContent).toContain("Real traffic is detect-only and is not masked");
});

test("tester distinguishes unavailable, no-rules, no-provider, and reduced live protection", async () => {
  await renderTester("unavailable");
  expect(host.textContent).toContain("protection is unavailable");

  await renderTester("no-rules");
  expect(host.textContent).toContain("no active Guardrails rules");

  await renderTester("no-provider-coverage");
  expect(host.textContent).toContain("no active provider is currently selected");

  await renderTester("reduced");
  expect(host.textContent).toContain("uses reduced protection");
});
