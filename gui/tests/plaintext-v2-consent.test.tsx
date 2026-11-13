import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import PlaintextV2ConsentModal from "../src/components/PlaintextV2ConsentModal";
import { confirmsPlaintextV2Mode, subagentSurfaceModes } from "../src/subagent-surface";
import { normalizeV2Status, type V2Status } from "../src/pages/models-shared";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  // happy-dom has no native modal dialog; the component only needs the call to be safe.
  const dialogProto = (testWindow as unknown as { HTMLDialogElement?: { prototype: Record<string, unknown> } }).HTMLDialogElement?.prototype;
  if (dialogProto && typeof dialogProto.showModal !== "function") dialogProto.showModal = function showModal() { (this as { open?: boolean }).open = true; };
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  root = null;
});

afterEach(() => {
  try {
    if (root) act(() => root!.unmount());
  } finally {
    try {
      testWindow.close();
    } finally {
      for (const key of globals) {
        const descriptor = previousGlobals[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  }
});

function render(node: React.ReactElement): void {
  root = createRoot(container);
  act(() => root!.render(<LanguageProvider>{node}</LanguageProvider>));
}

function modalParts() {
  const dialog = container.querySelector("dialog[data-plaintext-v2-consent]");
  const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  const actions = Array.from(container.querySelectorAll(".modal-actions button")) as HTMLButtonElement[];
  const backdrop = container.querySelector(".modal-backdrop-dismiss") as HTMLButtonElement | null;
  return { dialog, checkbox, cancel: actions[0] ?? null, confirm: actions[1] ?? null, backdrop };
}

function pressEscape(): void {
  const { dialog } = modalParts();
  act(() => {
    dialog!.dispatchEvent(new testWindow.Event("cancel", { bubbles: true, cancelable: true }) as unknown as Event);
  });
}

test("the acknowledgement starts unchecked and only it enables confirm", () => {
  const calls: string[] = [];
  render(<PlaintextV2ConsentModal onConfirm={() => calls.push("confirm")} onDismiss={() => calls.push("dismiss")} />);

  const { dialog, checkbox, cancel, confirm, backdrop } = modalParts();
  expect(dialog).not.toBeNull();
  expect(checkbox?.checked).toBe(false);
  expect(confirm?.disabled).toBe(true);
  expect(cancel?.disabled).toBe(false);
  expect(backdrop?.disabled).toBe(false);
  // The dialog renders real copy, not a raw key id.
  expect(dialog!.querySelector("h3")?.textContent?.trim().length).toBeGreaterThan(0);

  act(() => confirm!.click());
  expect(calls).toEqual([]);

  act(() => checkbox!.click());
  expect(checkbox?.checked).toBe(true);
  expect(confirm?.disabled).toBe(false);
});

test("an acknowledged confirm calls onConfirm exactly once and nothing else", () => {
  const calls: string[] = [];
  render(<PlaintextV2ConsentModal onConfirm={() => calls.push("confirm")} onDismiss={() => calls.push("dismiss")} />);
  const { checkbox, confirm } = modalParts();

  act(() => checkbox!.click());
  act(() => confirm!.click());

  expect(calls).toEqual(["confirm"]);
});

test("the cancel button and Escape each dismiss without confirming", () => {
  const calls: string[] = [];
  render(<PlaintextV2ConsentModal onConfirm={() => calls.push("confirm")} onDismiss={() => calls.push("dismiss")} />);
  const { cancel } = modalParts();

  act(() => cancel!.click());
  expect(calls).toEqual(["dismiss"]);

  pressEscape();
  expect(calls).toEqual(["dismiss", "dismiss"]);
});

test("a busy dialog cannot be checked, confirmed, or dismissed out from under the write", () => {
  const calls: string[] = [];
  render(<PlaintextV2ConsentModal busy onConfirm={() => calls.push("confirm")} onDismiss={() => calls.push("dismiss")} />);
  const { checkbox, cancel, confirm, backdrop } = modalParts();

  expect(checkbox?.disabled).toBe(true);
  expect(cancel?.disabled).toBe(true);
  expect(confirm?.disabled).toBe(true);
  expect(backdrop?.disabled).toBe(true);

  act(() => checkbox!.click());
  act(() => confirm!.click());
  act(() => cancel!.click());
  act(() => backdrop!.click());
  pressEscape();

  expect(calls).toEqual([]);
  expect(checkbox?.checked).toBe(false);
});

const VALID_RECEIPT = {
  ok: true,
  enabled: false,
  multiAgentMode: "v2-plaintext",
  supportsPlaintextV2Mode: true,
  plaintextAgentMessagesEnabled: true,
} as const;

test("confirmsPlaintextV2Mode accepts a receipt that proves mode, capability, and flag", () => {
  expect(confirmsPlaintextV2Mode(VALID_RECEIPT)).toBe(true);
  // Extra response fields do not dilute the proof.
  expect(confirmsPlaintextV2Mode({ ...VALID_RECEIPT, agentsMaxThreadsConflict: false, maxConcurrentThreadsPerSession: 8 })).toBe(true);
});

test("confirmsPlaintextV2Mode rejects non-objects and every weakened field", () => {
  for (const bad of [undefined, null, "v2-plaintext", 200, true, []]) {
    expect(confirmsPlaintextV2Mode(bad)).toBe(false);
  }

  for (const field of Object.keys(VALID_RECEIPT)) {
    const missing = Object.fromEntries(Object.entries(VALID_RECEIPT).filter(([key]) => key !== field));
    expect(confirmsPlaintextV2Mode(missing)).toBe(false);
  }

  const weakened: ReadonlyArray<readonly [string, unknown]> = [
    ["ok", false],
    ["ok", "true"],
    ["enabled", true],
    ["enabled", "false"],
    ["multiAgentMode", "v2"],
    ["multiAgentMode", "default"],
    ["multiAgentMode", true],
    ["supportsPlaintextV2Mode", false],
    ["supportsPlaintextV2Mode", "true"],
    ["plaintextAgentMessagesEnabled", false],
    ["plaintextAgentMessagesEnabled", 1],
  ];
  for (const [field, value] of weakened) {
    expect(confirmsPlaintextV2Mode({ ...VALID_RECEIPT, [field]: value })).toBe(false);
  }
});

test("normalizeV2Status preserves the plaintext mode and its capability fields", () => {
  const normalized = normalizeV2Status({
    enabled: false,
    agentsMaxThreadsConflict: false,
    multiAgentMode: "v2-plaintext",
    supportsPlaintextV2Mode: true,
    plaintextAgentMessagesEnabled: true,
  });

  expect(normalized.multiAgentMode).toBe("v2-plaintext");
  expect(normalized.supportsPlaintextV2Mode).toBe(true);
  expect(normalized.plaintextAgentMessagesEnabled).toBe(true);
});

test("normalizeV2Status cannot mint the capability from an older or malformed response", () => {
  const legacy = normalizeV2Status({ enabled: false, agentsMaxThreadsConflict: false, multiAgentMode: "v2" });
  expect(legacy.supportsPlaintextV2Mode).toBe(false);
  expect(legacy.plaintextAgentMessagesEnabled).toBe(false);

  const malformed = normalizeV2Status({
    enabled: false,
    agentsMaxThreadsConflict: false,
    multiAgentMode: "v2-plaintext-x",
    supportsPlaintextV2Mode: "yes",
    plaintextAgentMessagesEnabled: 1,
  } as unknown as V2Status);
  expect(malformed.multiAgentMode).toBe("default");
  expect(malformed.supportsPlaintextV2Mode).toBe(false);
  expect(malformed.plaintextAgentMessagesEnabled).toBe(false);
});

test("the fourth mode option exists only where the server advertises it", () => {
  expect(subagentSurfaceModes(false)).toEqual(["v1", "default", "v2"]);
  expect(subagentSurfaceModes(true)).toEqual(["v1", "default", "v2", "v2-plaintext"]);
});
