import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import { GuardrailsRulesPanel } from "../src/pages/guardrails/rules-panel";
import type {
  GuardrailsCustomRule,
  GuardrailsImportPreview,
  GuardrailsRuleSummary,
  GuardrailsRules,
} from "../src/pages/guardrails/types";

const globals = [
  "document",
  "window",
  "navigator",
  "localStorage",
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
  testWindow = new Window({ url: "http://localhost/#guardrails/rules" });
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

function rule(index: number): GuardrailsRuleSummary {
  return {
    ruleId: `rule-${String(index).padStart(3, "0")}`,
    dataType: 1,
    group: "CREDENTIALS",
    displayName: `Rule ${index}`,
    description: `Rule ${index} description`,
    source: "manual",
    enabled: true,
    custom: false,
  };
}

const DATA: GuardrailsRules = {
  revision: "rev-1",
  rules: Array.from({ length: 55 }, (_, index) => rule(index + 1)),
  builtinRuleCount: 55,
  customRuleCount: 0,
  customRules: [],
};

async function mount(overrides: {
  onBulk?: (ruleIds: string[], enabled: boolean) => void;
  onImport?: (bundle: unknown, mode: "merge" | "replace") => void;
  onImportError?: (error: unknown) => void;
  onSave?: (rule: GuardrailsCustomRule, editingId: string | null) => void;
  importPreview?: GuardrailsImportPreview | null;
} = {}) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root = createRoot(host);
    root.render(
      <LanguageProvider>
        <GuardrailsRulesPanel
          data={DATA}
          pending={false}
          onToggle={() => {}}
          onBulk={overrides.onBulk ?? (() => {})}
          onSave={overrides.onSave ?? (() => {})}
          onDelete={() => {}}
          onExport={() => {}}
          onImport={overrides.onImport ?? (() => {})}
          importPreview={overrides.importPreview ?? null}
          onApplyImport={() => {}}
          onCancelImport={() => {}}
          onImportError={overrides.onImportError ?? (() => {})}
        />
      </LanguageProvider>,
    );
  });
}

function button(label: string): HTMLButtonElement {
  return [...host.querySelectorAll<HTMLButtonElement>("button")]
    .find(candidate => candidate.textContent?.trim() === label)!;
}

test("paginates fifty rules and keeps the remaining five reachable", async () => {
  await mount();
  expect(host.querySelectorAll(".guardrails-rule-row")).toHaveLength(50);
  expect(host.textContent).toContain("Page 1 of 2");

  await act(async () => { button("Next").click(); });
  expect(host.querySelectorAll(".guardrails-rule-row")).toHaveLength(5);
  expect(host.textContent).toContain("Page 2 of 2");
});

test("bulk action emits all filtered built-in IDs once", async () => {
  const calls: Array<{ ids: string[]; enabled: boolean }> = [];
  await mount({
    onBulk: (ids, enabled) => calls.push({ ids, enabled }),
  });

  await act(async () => { button("Disable 55").click(); });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.enabled).toBe(false);
  expect(calls[0]?.ids).toEqual(DATA.rules.map(item => item.ruleId));
});

test("custom rule form exposes only functional matching controls", async () => {
  await mount();
  await act(async () => { button("Add rule").click(); });

  const labels = [...host.querySelectorAll<HTMLElement>(".field-label")]
    .map(label => label.textContent?.trim());
  expect(labels).not.toContain("Group priority");
  expect(labels).not.toContain("Keywords");
  const minimumLength = [...host.querySelectorAll<HTMLLabelElement>("label")]
    .find(label => label.textContent?.includes("Minimum length"))
    ?.querySelector<HTMLInputElement>("input");
  expect(minimumLength?.max).toBe(String(128 * 1024));
});

test("invalid JSON import is reported without invoking import", async () => {
  const errors: unknown[] = [];
  let imports = 0;
  await mount({
    onImport: () => { imports += 1; },
    onImportError: error => errors.push(error),
  });

  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new testWindow.File(["{"], "broken.json", { type: "application/json" });
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 5));
  });

  expect(imports).toBe(0);
  expect(errors).toHaveLength(1);
  expect(errors[0]).toBeInstanceOf(SyntaxError);
});

test("oversized import is rejected before JSON parsing", async () => {
  const errors: unknown[] = [];
  let imports = 0;
  await mount({
    onImport: () => { imports += 1; },
    onImportError: error => errors.push(error),
  });

  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new testWindow.File(
    [new Uint8Array(4 * 1024 * 1024 + 1)],
    "oversized.json",
    { type: "application/json" },
  );
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  await act(async () => {
    input.dispatchEvent(new testWindow.Event("change", { bubbles: true }));
  });

  expect(imports).toBe(0);
  expect(errors).toHaveLength(1);
  expect((errors[0] as Error).message).toContain("4 MiB");
});

test("Replace preview highlights every security-setting weakening", async () => {
  await mount({
    importPreview: {
      ok: true,
      dryRun: true,
      mode: "replace",
      createCount: 0,
      unchangedCount: 0,
      replaceCount: 0,
      conflicts: [],
      securityDiff: {
        weakensProtection: true,
        requiresReview: true,
        enabled: { before: true, after: false, changed: true, weakening: true },
        mode: { before: "enforce", after: "detect", changed: true, weakening: true },
        failurePolicy: {
          before: "block",
          after: "passthrough",
          changed: true,
          weakening: true,
        },
        providerScope: {
          before: { mode: "all" },
          after: { mode: "selected", providerIds: ["openai"] },
          addedProviderIds: ["openai"],
          removedProviderIds: [],
          changed: true,
          weakening: true,
        },
        enabledDataTypes: {
          before: [1, 2, 3, 4, 5, 6],
          after: [1, 2],
          added: [],
          removed: [3, 4, 5, 6],
          changed: true,
          weakening: true,
        },
        disabledBuiltinRules: {
          beforeCount: 0,
          afterCount: 1,
          newlyDisabledCount: 1,
          reenabledCount: 0,
          changed: true,
          weakening: true,
        },
        customRules: {
          beforeCount: 2,
          afterCount: 1,
          addedCount: 0,
          removedCount: 1,
          changedDefinitionCount: 1,
          changed: true,
          weakening: true,
          requiresReview: true,
        },
        keywordPrefilterEnabled: {
          before: false,
          after: true,
          changed: true,
          weakening: false,
        },
      },
    },
  });

  expect(host.textContent).toContain("Selected (1): openai");

  expect(host.querySelector(".notice-warn")?.textContent).toContain("reduces protection");
  expect(host.textContent).toContain("Traffic protection: On → Off");
  expect(host.textContent).toContain("Mode: Enforce masking → Detect only");
  expect(host.textContent).toContain("Failure handling: Block request → Pass through request");
  expect(host.textContent).toContain("Provider coverage: All providers → Selected (1)");
  expect(host.textContent).toContain("Enabled data types: 6 → 2");
  expect(host.textContent).toContain("No longer covered: Access tokens, IP addresses, Personal data, Custom");
  expect(host.textContent).toContain(
    "Disabled built-in rules: 0 → 1 (newly disabled: 1, re-enabled: 0)",
  );
  expect(host.textContent).toContain("Custom rules: 2 → 1 (removed: 1, changed: 1)");
  expect(host.textContent).toContain("Keyword prefilter: Off → On");
  expect(host.querySelectorAll(".badge-amber")).toHaveLength(7);
  const keywordPrefilterRow = [...host.querySelectorAll("li")]
    .find(row => row.textContent?.includes("Keyword prefilter: Off → On"));
  expect(keywordPrefilterRow?.querySelector(".badge-amber")).toBeNull();
});

test("capture group commas remain editable and parse only on submit", async () => {
  const saved: GuardrailsCustomRule[] = [];
  await mount({ onSave: rule => saved.push(rule) });
  const captureInput = [...host.querySelectorAll<HTMLLabelElement>("label")]
    .find(label => label.textContent?.includes("Capture groups"))
    ?.querySelector("input");
  expect(captureInput).toBeDefined();
  const setInputValue = (value: string) => {
    Object.getOwnPropertyDescriptor(testWindow.HTMLInputElement.prototype, "value")!
      .set!.call(captureInput, value);
    captureInput!.dispatchEvent(new testWindow.Event("input", { bubbles: true }));
  };

  await act(async () => {
    setInputValue("1,");
  });
  expect(captureInput!.value).toBe("1,");
  await act(async () => {
    setInputValue("1, 2");
  });
  await act(async () => {
    captureInput!.closest("form")!.dispatchEvent(
      new testWindow.Event("submit", { bubbles: true, cancelable: true }),
    );
  });

  expect(saved).toHaveLength(1);
  expect(saved[0]?.masking.captureGroups).toEqual([1, 2]);

  await act(async () => {
    setInputValue("1, bad, 2");
    captureInput!.closest("form")!.dispatchEvent(
      new testWindow.Event("submit", { bubbles: true, cancelable: true }),
    );
  });
  expect(saved).toHaveLength(1);
  expect(captureInput!.getAttribute("aria-invalid")).toBe("true");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("positive integer");
});
