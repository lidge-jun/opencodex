import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { promptForAdminToken } from "../src/admin-token-dialog";
import { setActiveLocale } from "../src/i18n/shared";

const globals = ["document", "window", "navigator", "localStorage", "HTMLElement"] as const;
let previousGlobals: Record<(typeof globals)[number], unknown>;
let testWindow: Window;

beforeEach(() => {
  setActiveLocale("en");
  previousGlobals = Object.fromEntries(globals.map((key) => [key, Reflect.get(globalThis, key)])) as typeof previousGlobals;
  testWindow = new Window({ url: "https://dashboard.example/" });
  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    navigator: { configurable: true, value: testWindow.navigator },
    localStorage: { configurable: true, value: testWindow.localStorage },
    HTMLElement: { configurable: true, value: testWindow.HTMLElement },
  });
});

afterEach(() => {
  setActiveLocale("en");
  testWindow.close();
  for (const key of globals) {
    Object.defineProperty(globalThis, key, { configurable: true, value: previousGlobals[key] });
  }
});

test("renders stable password-manager-compatible sign-in fields", async () => {
  const pending = promptForAdminToken(async () => "accepted");
  const dialog = document.querySelector<HTMLDialogElement>("#opencodex-admin-token-dialog");
  const form = dialog?.querySelector<HTMLFormElement>("form");
  const username = form?.elements.namedItem("username") as HTMLInputElement | null;
  const password = form?.elements.namedItem("password") as HTMLInputElement | null;

  expect(dialog).not.toBeNull();
  expect(dialog?.querySelector("h3")?.textContent).toBe("OpenCodex admin token (OPENCODEX_ADMIN_AUTH_TOKEN)");
  expect(form?.method).toBe("post");
  expect(form?.autocomplete).toBe("on");
  expect(username?.id).toBe("opencodex-admin-token-dialog-username");
  expect(form?.querySelector(`label[for="${username?.id}"]`)?.textContent).toBe("Account");
  expect(username?.autocomplete).toBe("username");
  expect(username?.readOnly).toBe(true);
  expect(username?.value).toBe("OpenCodex");
  expect(password?.id).toBe("opencodex-admin-token-dialog-password");
  expect(form?.querySelector(`label[for="${password?.id}"]`)?.textContent).toBe("Admin token");
  expect(password?.type).toBe("password");
  expect(password?.autocomplete).toBe("current-password");
  expect(password?.required).toBe(true);

  password!.value = "  ocx_admin_test  ";
  form!.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }));

  expect(await pending).toBe("ocx_admin_test");
  expect(document.querySelector("#opencodex-admin-token-dialog")).toBeNull();
  expect(localStorage.length).toBe(0);
});

test("cancel resolves null and restores the previous focus target", async () => {
  const focusTarget = document.createElement("button");
  document.body.append(focusTarget);
  focusTarget.focus();

  const pending = promptForAdminToken(async () => "accepted");
  const dialog = document.querySelector<HTMLDialogElement>("#opencodex-admin-token-dialog");
  dialog!.dispatchEvent(new testWindow.Event("cancel", { cancelable: true }));

  expect(await pending).toBeNull();
  expect(document.activeElement).toBe(focusTarget);
});

test("keeps the dialog open for whitespace and rejected tokens until one is accepted", async () => {
  const attempts: string[] = [];
  let settled = false;
  const pending = promptForAdminToken(async (token) => {
    attempts.push(token);
    return token === "valid-token" ? "accepted" : "rejected";
  });
  void pending.then(() => {
    settled = true;
  });

  const dialog = document.querySelector<HTMLDialogElement>("#opencodex-admin-token-dialog")!;
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  const password = form.elements.namedItem("password") as HTMLInputElement;

  password.value = "   ";
  form.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  expect(attempts).toEqual([]);
  expect(settled).toBe(false);
  expect(dialog.isConnected).toBe(true);

  password.value = "wrong-token";
  form.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }));
  await Promise.resolve();
  await Promise.resolve();
  expect(attempts).toEqual(["wrong-token"]);
  expect(settled).toBe(false);
  expect(dialog.isConnected).toBe(true);
  expect(dialog.querySelector('[role="alert"]')?.textContent).toContain("rejected");

  password.value = "valid-token";
  form.dispatchEvent(new testWindow.Event("submit", { bubbles: true, cancelable: true }));
  expect(await pending).toBe("valid-token");
  expect(attempts).toEqual(["wrong-token", "valid-token"]);
  expect(dialog.isConnected).toBe(false);
});

test("uses the active UI locale instead of re-detecting browser storage", async () => {
  localStorage.setItem("ocx-lang", "en");
  setActiveLocale("ko");

  const pending = promptForAdminToken(async () => "accepted");
  const dialog = document.querySelector<HTMLDialogElement>("#opencodex-admin-token-dialog")!;
  const form = dialog.querySelector<HTMLFormElement>("form")!;
  const username = form.elements.namedItem("username") as HTMLInputElement;
  const password = form.elements.namedItem("password") as HTMLInputElement;

  expect(dialog.querySelector("h3")?.textContent).toContain("관리자 토큰");
  expect(form.querySelector(`label[for="${username.id}"]`)?.textContent).toBe("계정");
  expect(form.querySelector(`label[for="${password.id}"]`)?.textContent).toBe("관리자 토큰");

  dialog.dispatchEvent(new testWindow.Event("cancel", { cancelable: true }));
  expect(await pending).toBeNull();
});
