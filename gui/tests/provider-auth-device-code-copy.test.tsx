import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { LanguageProvider } from "../src/i18n/provider";
import ProviderAuthPanel from "../src/components/provider-workspace/ProviderAuthPanel";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";
import type { LoginHint, ProviderAuthHandlers } from "../src/components/provider-workspace/types";

/**
 * The device-code copy button called navigator.clipboard.writeText directly and
 * swallowed failures with .catch(() => {}). That catch handled nothing: with no
 * Clipboard API the property read throws synchronously, so a LAN-bound GUI
 * (plain HTTP, not a secure context) got a dead button and a console trace.
 */

const DEVICE_CODE = "WDJB-MJHT";

const globals = ["document", "window", "navigator", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let host: HTMLElement;
let root: Root | null = null;
let clipboardWrites: string[] = [];

const ITEM: WorkspaceItem = {
  name: "claude",
  adapter: "anthropic",
  baseUrl: "https://api.anthropic.com",
  authMode: "oauth",
};

const HANDLERS: ProviderAuthHandlers = {
  onLogin: () => {},
  onLogout: () => {},
  onReauth: () => {},
  onSwitchAccount: () => {},
  onRemoveAccount: () => {},
  onAddApiKey: async () => true,
  onSwitchApiKey: () => {},
  onRemoveApiKey: () => {},
  onEditAlias: () => {},
};

function useClipboard(available: boolean) {
  clipboardWrites = [];
  Object.defineProperty(win.navigator, "clipboard", {
    configurable: true,
    value: available
      ? { writeText: async (text: string) => { clipboardWrites.push(text); } }
      : undefined,
  });
}

/** happy-dom ships no execCommand, so the legacy path must be stubbed explicitly. */
function useExecCommand(value: unknown) {
  Object.defineProperty(win.document, "execCommand", { configurable: true, value });
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map((k) => [k, Reflect.get(globalThis, k)])) as typeof previous;
  win = new Window({ url: "http://192.168.0.10:10100/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useClipboard(true);
  useExecCommand(undefined);
  host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as never);
});

afterEach(async () => {
  if (root) {
    const current = root;
    await act(async () => { current.unmount(); });
    root = null;
  }
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  }
  await win.happyDOM?.close?.();
});

async function mountPanel(hint: LoginHint) {
  const { createRoot } = await import("react-dom/client");
  await act(async () => {
    root ??= createRoot(host);
    root.render(
      <LanguageProvider>
        <ProviderAuthPanel
          item={ITEM}
          apiBase=""
          busy
          loginHint={hint}
          authHandlers={HANDLERS}
        />
      </LanguageProvider>,
    );
  });
}

/** The label changes with state, so locate the button structurally. */
function copyCodeButton(): HTMLButtonElement {
  const button = host.querySelector(".pwi-device-code-wrap button");
  expect(button).toBeTruthy();
  return button as HTMLButtonElement;
}

async function clickCopy() {
  await act(async () => {
    copyCodeButton().dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

test("shows the device code and copies it", async () => {
  await mountPanel({ provider: "claude", deviceCode: DEVICE_CODE });

  expect(host.textContent).toContain(DEVICE_CODE);

  await clickCopy();

  expect(clipboardWrites).toEqual([DEVICE_CODE]);
  expect(host.textContent).toContain("Code copied");
});

test("copies through the legacy path in a non-secure context", async () => {
  useClipboard(false);
  const execCommand = mock(() => true);
  useExecCommand(execCommand);
  await mountPanel({ provider: "claude", deviceCode: DEVICE_CODE });

  await clickCopy();

  expect(execCommand).toHaveBeenCalledWith("copy");
  expect(host.textContent).toContain("Code copied");
});

test("reports an unusable clipboard instead of dying silently", async () => {
  useClipboard(false);
  useExecCommand(undefined);
  await mountPanel({ provider: "claude", deviceCode: DEVICE_CODE });

  await clickCopy();

  // Previously this click threw a TypeError and the label never moved.
  expect(host.textContent).toContain("Clipboard unavailable");
  // The code itself stays selectable, so a recovery path remains on screen.
  expect(host.textContent).toContain(DEVICE_CODE);
});

test("a new device code does not inherit the previous code's feedback", async () => {
  await mountPanel({ provider: "claude", deviceCode: DEVICE_CODE });
  await clickCopy();
  expect(host.textContent).toContain("Code copied");

  // Cancel + restart replaces loginInfo while the panel stays mounted, so the
  // next code would otherwise show a copy it never received.
  await mountPanel({ provider: "claude", deviceCode: "QRST-UVWX" });

  expect(host.textContent).toContain("QRST-UVWX");
  expect(host.textContent).not.toContain(DEVICE_CODE);
  expect(host.textContent).not.toContain("Code copied");
  expect(host.textContent).toContain("Copy code");
});

test("keeps the latest feedback for its full window across repeated copies", async () => {
  await mountPanel({ provider: "claude", deviceCode: DEVICE_CODE });

  await clickCopy();
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  await clickCopy();

  expect(clipboardWrites).toEqual([DEVICE_CODE, DEVICE_CODE]);

  // Past the first click's expiry but before the second's.
  await act(async () => { await new Promise((r) => setTimeout(r, 2400)); });
  expect(host.textContent).toContain("Code copied");
});
