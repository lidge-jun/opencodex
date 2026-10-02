/**
 * The OAuth terms dialog, rendered.
 *
 * The root seam test reads source text; this mounts the dialog and drives it, so the claims
 * the copy makes are bound to the behaviour around it: it opens as a native modal (which owns
 * focus trapping), the acknowledgement starts unchecked on every mount, every way out leaves
 * without starting OAuth, and Continue submits exactly once.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import OAuthTosWarningModal from "../src/components/OAuthTosWarningModal";
import { LanguageProvider } from "../src/i18n/provider";
import { DICTS, LOCALES } from "../src/i18n/shared";

const globals = ["document", "window", "navigator", "IS_REACT_ACT_ENVIRONMENT"] as const;
let previousGlobals: Record<(typeof globals)[number], PropertyDescriptor | undefined>;
let testWindow: Window;
let container: HTMLElement;
let root: Root | null = null;
let showModalCalls = 0;

beforeEach(() => {
  previousGlobals = Object.fromEntries(
    globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as typeof previousGlobals;
  testWindow = new Window({ url: "http://localhost/" });
  Object.defineProperty(testWindow.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  showModalCalls = 0;
  const dialogProto = (testWindow as unknown as { HTMLDialogElement: { prototype: Record<string, unknown> } }).HTMLDialogElement.prototype;
  // Count the call: showModal (not show) is what gives the dialog its native focus trap.
  dialogProto.showModal = function showModal() { showModalCalls += 1; (this as { open?: boolean }).open = true; };
  container = testWindow.document.createElement("div") as unknown as HTMLElement;
  testWindow.document.body.appendChild(container as never);
  root = null;
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  for (const key of globals) {
    const descriptor = previousGlobals[key];
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as Record<string, unknown>)[key];
  }
});

function render(providerId: string, calls: string[]): void {
  root ??= createRoot(container);
  act(() => root!.render(
    <LanguageProvider>
      <OAuthTosWarningModal
        key={calls.length}
        providerId={providerId}
        providerLabel={providerId === "anthropic" ? "Claude" : "Antigravity"}
        onCancel={() => calls.push("cancel")}
        onContinue={() => calls.push("continue")}
      />
    </LanguageProvider>,
  ));
}

const q = <T extends Element>(selector: string) => container.querySelector(selector) as T | null;
const primary = () => q<HTMLButtonElement>(".modal-actions .btn-primary")!;
const checkbox = () => q<HTMLInputElement>('input[type="checkbox"]')!;

describe("Anthropic subscription dialog", () => {
  test("opens modally with the Claude-specific copy and an unchecked acknowledgement", () => {
    render("anthropic", []);
    expect(showModalCalls).toBe(1);
    const dialog = q<HTMLDialogElement>("dialog")!;
    expect(dialog.open).toBe(true);

    expect(q("h3")?.textContent).toBe("Claude subscription connection");
    const text = dialog.textContent ?? "";
    expect(text).toContain(DICTS.en["oauthTos.anthropicBody"]);
    expect(text).toContain(DICTS.en["oauthTos.anthropicConditions"]);
    expect(text).toContain("configure an Anthropic API key instead");
    expect(text).not.toContain("OAuth anyway");

    // Both paragraphs describe the dialog, not only the first.
    const described = (dialog.getAttribute("aria-describedby") ?? "").split(" ");
    expect(described).toHaveLength(2);
    for (const id of described) expect(testWindow.document.getElementById(id)).not.toBeNull();

    expect(checkbox().checked).toBe(false);
    expect(primary().disabled).toBe(true);
    expect(primary().textContent).toBe("Continue with Claude subscription");
  });

  test("Cancel, Escape and the backdrop all leave without starting OAuth", () => {
    const calls: string[] = [];
    render("anthropic", calls);
    const cancel = Array.from(container.querySelectorAll<HTMLButtonElement>(".modal-actions button"))
      .find(button => !button.className.includes("btn-primary"))!;
    act(() => cancel.click());
    act(() => { q("dialog")!.dispatchEvent(new testWindow.Event("cancel", { cancelable: true }) as unknown as Event); });
    act(() => q<HTMLButtonElement>(".modal-backdrop-dismiss")!.click());
    expect(calls).toEqual(["cancel", "cancel", "cancel"]);
  });

  test("Continue needs the acknowledgement and submits once", () => {
    const calls: string[] = [];
    render("anthropic", calls);
    act(() => primary().click());
    expect(calls).toEqual([]);

    act(() => checkbox().click());
    expect(primary().disabled).toBe(false);
    act(() => { primary().click(); primary().click(); });
    expect(calls).toEqual(["continue"]);
    expect(primary().disabled).toBe(true);
  });

  test("a fresh mount starts unchecked again", () => {
    const calls: string[] = [];
    render("anthropic", calls);
    act(() => checkbox().click());
    act(() => primary().click());
    render("anthropic", calls);
    expect(checkbox().checked).toBe(false);
    expect(primary().disabled).toBe(true);
  });
});

test("other high-risk providers keep the shared title and acknowledgement", () => {
  render("google-antigravity", []);
  expect(q("h3")?.textContent).toBe("Antigravity: subscription OAuth risk");
  expect(container.textContent).toContain(DICTS.en["oauthTos.acknowledge"]);
  expect(container.textContent).toContain(DICTS.en["oauthTos.saferPath"]);
  expect(container.textContent).not.toContain(DICTS.en["oauthTos.anthropicConditions"]);
});

test("every locale carries the Anthropic dialog copy with the same anchors", () => {
  const keys = [
    "oauthTos.anthropicTitle",
    "oauthTos.anthropicBody",
    "oauthTos.anthropicConditions",
    "oauthTos.anthropicSaferPath",
    "oauthTos.anthropicAcknowledge",
    "oauthTos.anthropicContinue",
  ] as const;
  expect(LOCALES.length).toBe(10);
  for (const { code } of LOCALES) {
    const dict = DICTS[code];
    for (const key of keys) {
      expect(typeof dict[key], code + " " + key).toBe("string");
      expect(dict[key], code + " " + key).not.toBe(key);
    }
    expect(dict["oauthTos.anthropicTitle"], code).toContain("Claude");
    expect(dict["oauthTos.anthropicBody"], code).toContain("OpenCodex");
    expect(dict["oauthTos.anthropicBody"], code).toContain("Anthropic");
    expect(dict["oauthTos.anthropicConditions"], code).toContain("Claude Code");
    expect(dict["oauthTos.anthropicConditions"], code).toContain("Agent SDK");
    expect(dict["oauthTos.anthropicSaferPath"], code).toContain("API");
    expect(dict["oauthTos.anthropicContinue"], code).toContain("Claude");
  }
  expect(DICTS.ko["oauthTos.anthropicTitle"]).toBe("Claude 구독 연결");
  expect(DICTS.ko["oauthTos.anthropicContinue"]).toBe("Claude 구독으로 계속");
});

