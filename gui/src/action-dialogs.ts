/**
 * In-page replacements for the three platform dialogs the desktop app cannot draw.
 *
 * wry implements exactly three `WKUIDelegate` methods — the file open panel, the media
 * capture permission request, and window creation for a navigation action — and WKWebView
 * draws no JavaScript dialog when its UI delegate does not implement the matching panel
 * method. Inside the app `confirm()` therefore returns false without drawing anything,
 * `alert()` draws nothing at all, and `prompt()` cannot collect input. Every consent gate
 * and every result report written against those three was silently declined or silently
 * swallowed while the same dashboard worked in a browser, which is why the failure read as
 * "the app is broken" rather than "the dashboard is broken".
 * See devlog/_plan/260921_app_runtime_ownership/050_webview_dialogs.md.
 *
 * These helpers keep the call-site shape the platform dialogs had — ask, await an answer,
 * act on it — so the surrounding control flow survives the replacement unchanged, above
 * all the part that matters: a refusal still issues no request. They are built
 * imperatively rather than as React components because the callers are hooks, inline event
 * handlers and a shared restart controller rather than one subtree. `admin-token-dialog.ts`
 * already answers the same problem the same way, and this reuses its dismissal, focus and
 * validation behaviour along with the modal classes in `styles.css`.
 */
import { DICTS, getActiveLocale, type Locale } from "./i18n/shared";

/** Keeps element ids unique when two dialogs are opened in one document. */
let dialogSequence = 0;

export interface ConfirmActionOptions {
  /** The question. Blank lines separate paragraphs, the way `confirm()` rendered them. */
  message: string;
  /** Label of the accepting button. Defaults to the shared OK label. */
  confirmLabel?: string;
  /** `danger` marks an action that destroys, interrupts or disconnects something. */
  tone?: "default" | "danger";
  /** Overrides the active locale; these dialogs open outside the React provider. */
  locale?: Locale;
}

export interface RequestTextValueOptions {
  /** Field label — the string the platform `prompt()` showed above its input. */
  message: string;
  /** Pre-filled value, matching `prompt()`'s second argument. */
  initialValue?: string;
  /** Label of the accepting button. Defaults to the shared Save label. */
  confirmLabel?: string;
  /** Longest accepted value, when the route states one. */
  maxLength?: number;
  /**
   * Mirrors a server contract for immediate feedback. Returns the message to show, or
   * null to accept. A rejected value keeps the dialog open and issues no request.
   */
  validate?: (value: string) => string | null;
  locale?: Locale;
}

/** Renders a multi-paragraph consent message as separate paragraphs. */
function paragraphsOf(message: string): string[] {
  const paragraphs = message.split(/\n{2,}/).map(part => part.trim()).filter(part => part.length > 0);
  return paragraphs.length > 0 ? paragraphs : [message];
}

interface ModalShell<T> {
  form: HTMLFormElement;
  bodyId: string;
  /** Resolves the dialog exactly once, restoring focus to whatever opened it. */
  finish: (value: T) => void;
}

/**
 * Opens a modal `<dialog>` that resolves exactly once.
 *
 * `cancelValue` answers every dismissal the user did not spell out — Escape, the backdrop,
 * the Cancel button — because a surface that cannot say how it was closed is precisely how
 * the undrawn `confirm()` became indistinguishable from a deliberate refusal.
 */
function openModal<T>(locale: Locale, cancelValue: T, resolve: (value: T) => void): ModalShell<T> {
  const messages = DICTS[locale];
  const id = `opencodex-action-dialog-${++dialogSequence}`;
  const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  let settled = false;

  const dialog = document.createElement("dialog");
  dialog.id = id;
  dialog.className = "modal-overlay";
  dialog.setAttribute("aria-labelledby", `${id}-body`);

  const backdrop = document.createElement("button");
  backdrop.type = "button";
  backdrop.className = "modal-backdrop-dismiss";
  backdrop.tabIndex = -1;
  backdrop.setAttribute("aria-label", messages["common.close"]);

  const form = document.createElement("form");
  form.className = "modal-card";

  const finish = (value: T): void => {
    if (settled) return;
    settled = true;
    if (dialog.open) dialog.close();
    dialog.remove();
    // Only when the trigger is still in the document: a dismissal that removed the row
    // the button lived on would otherwise throw on the way out.
    if (previouslyFocused?.isConnected) previouslyFocused.focus();
    resolve(value);
  };

  backdrop.addEventListener("click", () => finish(cancelValue));
  // A native <dialog> fires "cancel" on Escape and would close without an answer.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(cancelValue);
  });

  dialog.append(backdrop, form);
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");

  return { form, bodyId: `${id}-body`, finish };
}

/** Appends the message paragraphs and returns the container that names the dialog. */
function appendMessage(form: HTMLFormElement, bodyId: string, message: string): HTMLDivElement {
  const body = document.createElement("div");
  body.id = bodyId;
  for (const paragraph of paragraphsOf(message)) {
    const element = document.createElement("p");
    element.className = "modal-desc";
    element.textContent = paragraph;
    body.append(element);
  }
  form.append(body);
  return body;
}

/**
 * Asks for consent and resolves true only when the user accepted.
 *
 * Every other outcome — Cancel, Escape, the backdrop — resolves false, so a caller written
 * as `if (!await confirmAction(...)) return;` keeps the refusal path it already had.
 */
export function confirmAction(options: ConfirmActionOptions): Promise<boolean> {
  const locale = options.locale ?? getActiveLocale();
  const messages = DICTS[locale];
  const danger = options.tone === "danger";

  return new Promise<boolean>((resolve) => {
    const { form, bodyId, finish } = openModal<boolean>(locale, false, resolve);
    appendMessage(form, bodyId, options.message);

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost";
    cancel.textContent = messages["common.cancel"];
    cancel.addEventListener("click", () => finish(false));

    const accept = document.createElement("button");
    accept.type = "submit";
    accept.className = danger ? "btn btn-danger" : "btn btn-primary";
    accept.textContent = options.confirmLabel ?? messages["common.ok"];

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      finish(true);
    });

    actions.append(cancel, accept);
    form.append(actions);
    // A destructive action does not get to be the thing Enter reaches first.
    queueMicrotask(() => (danger ? cancel : accept).focus());
  });
}

/**
 * Collects one line of text and resolves it, or null when the user declined.
 *
 * Null is the same answer `prompt()` returned on cancel, so callers keep their
 * `if (entered === null) return;` guard and still issue no request on a refusal.
 */
export function requestTextValue(options: RequestTextValueOptions): Promise<string | null> {
  const locale = options.locale ?? getActiveLocale();
  const messages = DICTS[locale];

  return new Promise<string | null>((resolve) => {
    const { form, bodyId, finish } = openModal<string | null>(locale, null, resolve);
    const body = appendMessage(form, bodyId, options.message);
    body.className = "field-label";

    const input = document.createElement("input");
    input.className = "input";
    input.type = "text";
    input.value = options.initialValue ?? "";
    input.spellcheck = false;
    input.autocapitalize = "none";
    input.setAttribute("aria-describedby", bodyId);
    if (options.maxLength !== undefined) input.maxLength = options.maxLength;

    // Mounted up front so role="alert" has a stable target, and kept empty while hidden so
    // the two halves of "there is no error" cannot drift apart — same rule as the
    // admin-token dialog's notice.
    const validationError = document.createElement("div");
    validationError.className = "notice notice-err";
    validationError.setAttribute("role", "alert");
    validationError.hidden = true;

    const setValidationError = (text: string | null): void => {
      validationError.textContent = text ?? "";
      validationError.hidden = text === null;
      if (text === null) input.removeAttribute("aria-invalid");
      else input.setAttribute("aria-invalid", "true");
    };

    const actions = document.createElement("div");
    actions.className = "modal-actions";

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost";
    cancel.textContent = messages["common.cancel"];
    cancel.addEventListener("click", () => finish(null));

    const accept = document.createElement("button");
    accept.type = "submit";
    accept.className = "btn btn-primary";
    accept.textContent = options.confirmLabel ?? messages["common.save"];

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const entered = input.value;
      const rejection = options.validate?.(entered) ?? null;
      setValidationError(rejection);
      if (rejection !== null) {
        // The dialog stays open and nothing is sent: a rejected value is not an answer.
        accept.disabled = true;
        input.focus();
        return;
      }
      finish(entered);
    });

    // Re-enable on the next edit rather than on a timer, so the button state always
    // describes the value currently in the field.
    input.addEventListener("input", () => {
      if (accept.disabled) accept.disabled = false;
      if (!validationError.hidden) setValidationError(null);
    });

    actions.append(cancel, accept);
    form.append(input, validationError, actions);
    queueMicrotask(() => input.focus());
  });
}
