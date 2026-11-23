/** @jsxImportSource react */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { CodexCreditItem } from "../src/components/codex-account-pool-helpers";
import { DICTS, interpolate, type TFn } from "../src/i18n/shared";

let testWindow: Window;
let restoreGlobals: () => void;
const t: TFn = (key, vars) => interpolate(DICTS.en[key], vars);

beforeEach(() => {
  testWindow = new Window({ url: "http://localhost/" });
  const keys = ["document", "window", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  restoreGlobals = () => {
    for (const key of keys) {
      const descriptor = previous[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  };
});

afterEach(() => { restoreGlobals(); testWindow.close(); });

async function renderCredit(expiresAt: string | null) {
  const { createRoot } = await import("react-dom/client");
  const container = testWindow.document.createElement("div");
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () => {
    root.render(<CodexCreditItem index={0} grantedAt="2026-01-01T00:00:00Z" expiresAt={expiresAt} isNext={false} locale="en" t={t} />);
  });
  return { container, root };
}

test("a non-expiring credit displays no expiry without urgency", async () => {
  const { container, root } = await renderCredit(null);
  try {
    expect(container.textContent).toContain("No expiry");
    expect(container.textContent).not.toContain("1970");
    expect(container.textContent).not.toContain("0d left");
    expect(container.querySelector(".credit-urgent")).toBeNull();
  } finally { await act(async () => { root.unmount(); }); }
});

test("a dated credit displays its expiration and days remaining", async () => {
  const expiresAt = new Date(Date.now() + 2.5 * 86_400_000).toISOString();
  const { container, root } = await renderCredit(expiresAt);
  try {
    expect(container.textContent).toMatch(/Expires .+ \(3d left\)/);
    expect(container.querySelector(".credit-urgent")).not.toBeNull();
  } finally { await act(async () => { root.unmount(); }); }
});
