import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { confirmAction, requestTextValue } from "../src/action-dialogs";

/**
 * Runtime behaviour of the in-page replacements for confirm/alert/prompt.
 *
 * These tests assert the ABSENCE of the platform dialogs rather than stubbing them in. The
 * original defect survived CI precisely because the GUI tests encoded browser dialogs as
 * available — one stubbed `confirm()` to true, another forced confirmation, a third
 * asserted that `alert()` existed — so a dashboard that could not draw any of them still
 * looked correct. Every test here installs a throwing stub for all three: reaching one is a
 * failure, not a mock.
 */
/*
 * `HTMLElement` is deliberately absent. These helpers are reached from a dozen components,
 * and an `instanceof HTMLElement` focus check bound every one of their callers to a realm
 * that happens to expose the constructor — which most of this package's DOM tests do not.
 * Leaving the global out is what keeps that from coming back.
 */
const globals = ["document", "window", "navigator", "localStorage", "confirm", "alert", "prompt"] as const;
let previous: Record<(typeof globals)[number], unknown>;
let win: Window;
let touched: string[];

function forbidPlatformDialogs(): void {
  for (const name of ["confirm", "alert", "prompt"] as const) {
    const trap = () => { touched.push(name); throw new Error(`${name}() must not be reached`); };
    Object.defineProperty(globalThis, name, { configurable: true, value: trap });
    Object.defineProperty(win, name, { configurable: true, value: trap });
  }
}

beforeEach(() => {
  previous = Object.fromEntries(globals.map(key => [key, Reflect.get(globalThis, key)])) as typeof previous;
  touched = [];
  win = new Window({ url: "http://localhost/" });
  Object.defineProperty(win.navigator, "language", { configurable: true, value: "en-US" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: win.document },
    window: { configurable: true, value: win },
    navigator: { configurable: true, value: win.navigator },
    localStorage: { configurable: true, value: win.localStorage },
  });
  forbidPlatformDialogs();
});

afterEach(() => {
  for (const key of globals) Object.defineProperty(globalThis, key, { configurable: true, value: previous[key] });
  expect(touched).toEqual([]);
});

/** The one dialog currently mounted, which is what every assertion below reads. */
function openDialog(): HTMLDialogElement {
  const dialog = win.document.querySelector("dialog");
  if (!dialog) throw new Error("no dialog was opened");
  return dialog as unknown as HTMLDialogElement;
}

function buttonLabelled(text: string): HTMLButtonElement {
  const match = [...openDialog().querySelectorAll("button")]
    .find(button => button.textContent?.trim() === text);
  if (!match) throw new Error(`no button labelled ${text}`);
  return match as unknown as HTMLButtonElement;
}

/** Lets the dialog's queued focus call run before the assertion reads activeElement. */
const settled = () => new Promise<void>(resolve => { queueMicrotask(resolve); });

test("a refusal resolves false and leaves nothing mounted", async () => {
  const answer = confirmAction({ message: "Stop the proxy?" });
  await settled();
  buttonLabelled("Cancel").click();
  expect(await answer).toBe(false);
  expect(win.document.querySelector("dialog")).toBeNull();
});

test("accepting resolves true", async () => {
  const answer = confirmAction({ message: "Stop the proxy?", confirmLabel: "Stop" });
  await settled();
  buttonLabelled("Stop").click();
  expect(await answer).toBe(true);
});

test("Escape is a refusal, not an unanswered close", async () => {
  // A native <dialog> closes on Escape without saying so. Reported as a refusal, the
  // caller's early return still runs and no request is issued.
  const answer = confirmAction({ message: "Remove the account?" });
  await settled();
  openDialog().dispatchEvent(new win.Event("cancel", { cancelable: true }) as unknown as Event);
  expect(await answer).toBe(false);
});

test("the backdrop dismisses as a refusal", async () => {
  const answer = confirmAction({ message: "Remove the key?" });
  await settled();
  (openDialog().querySelector(".modal-backdrop-dismiss") as unknown as HTMLButtonElement).click();
  expect(await answer).toBe(false);
});

test("focus returns to the control that opened the dialog", async () => {
  const trigger = win.document.createElement("button");
  win.document.body.appendChild(trigger);
  trigger.focus();

  const answer = confirmAction({ message: "Revoke the device?" });
  await settled();
  expect(win.document.activeElement).not.toBe(trigger);
  buttonLabelled("Cancel").click();
  await answer;
  expect(win.document.activeElement).toBe(trigger);
});

test("a destructive action does not put the accepting button under Enter", async () => {
  const danger = confirmAction({ message: "Delete it?", confirmLabel: "Delete", tone: "danger" });
  await settled();
  expect(win.document.activeElement?.textContent).toBe("Cancel");
  buttonLabelled("Cancel").click();
  await danger;

  const ordinary = confirmAction({ message: "Switch account mode?" });
  await settled();
  expect(win.document.activeElement?.textContent).toBe("OK");
  buttonLabelled("Cancel").click();
  await ordinary;
});

test("the message names the dialog and keeps its paragraphs", async () => {
  const answer = confirmAction({ message: "Draining takes 20s.\n\nNo supervisor is running." });
  await settled();
  const dialog = openDialog();
  const named = dialog.getAttribute("aria-labelledby");
  const body = dialog.querySelector(`#${named}`);
  expect(body).not.toBeNull();
  expect([...body!.querySelectorAll("p")].map(p => p.textContent)).toEqual([
    "Draining takes 20s.",
    "No supervisor is running.",
  ]);
  buttonLabelled("Cancel").click();
  await answer;
});

test("text entry resolves the value and cancels to null", async () => {
  const entry = requestTextValue({ message: "Display name", initialValue: "old" });
  await settled();
  const input = openDialog().querySelector("input") as unknown as HTMLInputElement;
  expect(input.value).toBe("old");
  input.value = "new name";
  (openDialog().querySelector("form") as unknown as HTMLFormElement)
    .dispatchEvent(new win.Event("submit", { cancelable: true, bubbles: true }) as unknown as Event);
  expect(await entry).toBe("new name");

  const cancelled = requestTextValue({ message: "Display name", initialValue: "old" });
  await settled();
  buttonLabelled("Cancel").click();
  // Null, not "": a dismissal must not be read as a request to clear the alias.
  expect(await cancelled).toBeNull();
});

test("a rejected value keeps the dialog open and reports beside the field", async () => {
  const entry = requestTextValue({
    message: "Display name",
    maxLength: 80,
    validate: value => (value.trim().length > 80 ? "too long" : null),
  });
  await settled();
  const dialog = openDialog();
  const input = dialog.querySelector("input") as unknown as HTMLInputElement;
  const form = dialog.querySelector("form") as unknown as HTMLFormElement;
  expect(input.getAttribute("maxlength")).toBe("80");

  input.value = "x".repeat(81);
  form.dispatchEvent(new win.Event("submit", { cancelable: true, bubbles: true }) as unknown as Event);
  // Still mounted, still unresolved: a rejected value is not an answer.
  expect(win.document.querySelector("dialog")).not.toBeNull();
  const error = dialog.querySelector("[role=alert]");
  expect(error?.textContent).toBe("too long");
  expect((error as unknown as HTMLElement).hidden).toBe(false);
  expect(input.getAttribute("aria-invalid")).toBe("true");

  // Editing clears the report and re-arms the button, so its state always describes the
  // value currently in the field.
  input.value = "short";
  input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  expect((dialog.querySelector("[role=alert]") as unknown as HTMLElement).hidden).toBe(true);
  expect(input.getAttribute("aria-invalid")).toBeNull();

  form.dispatchEvent(new win.Event("submit", { cancelable: true, bubbles: true }) as unknown as Event);
  expect(await entry).toBe("short");
});

test("two dialogs opened in one document do not share element ids", async () => {
  const first = confirmAction({ message: "First" });
  await settled();
  const firstId = openDialog().getAttribute("aria-labelledby");
  buttonLabelled("Cancel").click();
  await first;

  const second = confirmAction({ message: "Second" });
  await settled();
  expect(openDialog().getAttribute("aria-labelledby")).not.toBe(firstId);
  buttonLabelled("Cancel").click();
  await second;
});

test("navigating away is a refusal, and leaves no dialog behind", async () => {
  /*
   * The dialog is mounted on <body>, so it outlives the React subtree that opened it.
   * Without this, Back/Forward while a consent dialog is open would leave it on screen and
   * accepting it afterwards would resume a closed-over handler against a page the user had
   * already left — removing an account from a surface they cannot see.
   */
  const answer = confirmAction({ message: "Remove the account?", tone: "danger" });
  await settled();
  expect(win.document.querySelector("dialog")).not.toBeNull();

  win.dispatchEvent(new win.Event("popstate") as unknown as Event);
  expect(await answer).toBe(false);
  expect(win.document.querySelector("dialog")).toBeNull();
});

test("a hash change is the same refusal", async () => {
  const answer = confirmAction({ message: "Revoke the device?", tone: "danger" });
  await settled();
  win.dispatchEvent(new win.Event("hashchange") as unknown as Event);
  expect(await answer).toBe(false);
});

test("Escape is answered at the document when the dialog is not modal", async () => {
  /*
   * Forces the branch that merely sets `open`, because this DOM does implement
   * `showModal` and would otherwise never reach it. That branch is not modal: a listener on
   * the dialog element would miss Escape as soon as focus sat anywhere else, so the
   * listener lives on the document for exactly this case.
   */
  const dialogPrototype = win.HTMLDialogElement.prototype as unknown as { showModal?: unknown };
  const nativeShowModal = dialogPrototype.showModal;
  delete dialogPrototype.showModal;
  try {
    const answer = requestTextValue({ message: "Display name" });
    await settled();
    win.document.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event,
    );
    expect(await answer).toBeNull();
    expect(win.document.querySelector("dialog")).toBeNull();
  } finally {
    if (nativeShowModal !== undefined) dialogPrototype.showModal = nativeShowModal;
  }
});

test("a settled dialog stops listening for navigation", async () => {
  // The window listeners must come off in finish(), or every dialog ever opened would keep
  // a closure alive and a later navigation would re-enter it.
  const answer = confirmAction({ message: "Stop the proxy?" });
  await settled();
  buttonLabelled("Cancel").click();
  expect(await answer).toBe(false);
  // A navigation after settlement must be inert: no dialog, no second resolution, no throw.
  win.dispatchEvent(new win.Event("popstate") as unknown as Event);
  win.document.dispatchEvent(
    new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as Event,
  );
  expect(win.document.querySelector("dialog")).toBeNull();
});
