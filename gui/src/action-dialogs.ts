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
  /**
   * Withdraws the question. A consent names a subject, and a dialog that outlives its
   * subject — the surface unmounted, the backend target changed — is no longer asking about
   * the thing the user would be approving. Aborting resolves it as a refusal.
   */
  signal?: AbortSignal;
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
  /** Withdraws the question; see `ConfirmActionOptions.signal`. */
  signal?: AbortSignal;
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
function openModal<T>(
  locale: Locale,
  cancelValue: T,
  resolve: (value: T) => void,
  signal?: AbortSignal,
): ModalShell<T> {
  const messages = DICTS[locale];
  const id = `opencodex-action-dialog-${++dialogSequence}`;
  /*
   * Duck-typed rather than `instanceof HTMLElement`. These helpers are reached from a dozen
   * components, and a constructor identity check binds every one of their callers to a
   * realm that happens to expose the global — which is not true of a document handed in
   * from elsewhere, and is not true of most of this package's DOM tests.
   */
  const active = document.activeElement as { focus?: unknown; isConnected?: boolean } | null;
  const previouslyFocused = typeof active?.focus === "function" ? (active as HTMLElement) : null;
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
    window.removeEventListener("hashchange", dismissOnNavigation);
    window.removeEventListener("popstate", dismissOnNavigation);
    document.removeEventListener("keydown", dismissOnEscape);
    signal?.removeEventListener("abort", dismissOnNavigation);
    // The caller is answered whatever the teardown does. A dialog left connected is a
    // cosmetic fault; a promise that never settles hangs the handler that awaited it.
    try {
      if (dialog.open && typeof dialog.close === "function") dialog.close();
      dialog.remove();
      // Only when the trigger is still in the document: a dismissal that removed the row
      // the button lived on would otherwise throw on the way out.
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    } finally {
      resolve(value);
    }
  };

  /*
   * A dialog mounted on <body> outlives the React subtree that opened it. Navigating with
   * Back/Forward while one is open would leave it on screen, and accepting it afterwards
   * would resume a closed-over handler against a page the user has already left — removing
   * an account or revoking a device from a surface they cannot see. Navigation is therefore
   * a refusal, using the same two events the shell already treats as leaving a page.
   */
  function dismissOnNavigation(): void {
    finish(cancelValue);
  }

  /*
   * Escape at the document, not just at the dialog. With `showModal` the dialog reports its
   * own "cancel" event and this never fires; without it the element is merely open, so a
   * dialog-level listener would miss Escape as soon as focus sat anywhere else.
   */
  function dismissOnEscape(event: KeyboardEvent): void {
    if (event.key === "Escape") finish(cancelValue);
  }

  backdrop.addEventListener("click", () => finish(cancelValue));
  // A native <dialog> fires "cancel" on Escape and would close without an answer.
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    finish(cancelValue);
  });
  window.addEventListener("hashchange", dismissOnNavigation);
  window.addEventListener("popstate", dismissOnNavigation);
  signal?.addEventListener("abort", dismissOnNavigation);

  dialog.append(backdrop, form);
  document.body.append(dialog);
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
  } else {
    /*
     * This path exists for DOM implementations without `showModal` — this package's test
     * DOM is one. It is not a modality boundary: setting `open` neither makes the rest of
     * the document inert nor traps focus, and pretending otherwise would be worse than
     * saying so. Every browser surface the dashboard ships to implements `showModal`, and
     * takes the branch above. Escape is still answered, at the document.
     */
    dialog.setAttribute("open", "");
    document.addEventListener("keydown", dismissOnEscape);
  }

  return { form, bodyId: `${id}-body`, finish };
}

/** Appends the message paragraphs and returns the element that names the dialog. */
function appendMessage(form: HTMLFormElement, bodyId: string, message: string, tag = "div"): HTMLElement {
  const body = document.createElement(tag);
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
    // Already withdrawn: answer without ever drawing the question.
    if (options.signal?.aborted) { resolve(false); return; }
    const { form, bodyId, finish } = openModal<boolean>(locale, false, resolve, options.signal);
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
    if (options.signal?.aborted) { resolve(null); return; }
    const { form, bodyId, finish } = openModal<string | null>(locale, null, resolve, options.signal);
    const input = document.createElement("input");
    const inputId = `${bodyId}-input`;
    // A real <label for> rather than aria-describedby: the message IS the field's name, and
    // the platform prompt() showed it the same way.
    const label = appendMessage(form, bodyId, options.message, "label");
    label.className = "field-label";
    label.setAttribute("for", inputId);

    input.id = inputId;
    input.className = "input";
    input.type = "text";
    input.value = options.initialValue ?? "";
    input.spellcheck = false;
    input.autocapitalize = "none";
    if (options.maxLength !== undefined) input.maxLength = options.maxLength;

    // Mounted up front so role="alert" has a stable target, and kept empty while hidden so
    // the two halves of "there is no error" cannot drift apart — same rule as the
    // admin-token dialog's notice.
    const validationError = document.createElement("div");
    const errorId = `${bodyId}-error`;
    validationError.id = errorId;
    validationError.className = "notice notice-err";
    validationError.setAttribute("role", "alert");
    validationError.hidden = true;

    const setValidationError = (text: string | null): void => {
      validationError.textContent = text ?? "";
      validationError.hidden = text === null;
      if (text === null) {
        input.removeAttribute("aria-invalid");
        input.removeAttribute("aria-describedby");
      } else {
        input.setAttribute("aria-invalid", "true");
        input.setAttribute("aria-describedby", errorId);
      }
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
