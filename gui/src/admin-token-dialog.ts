import { DICTS, getActiveLocale, type Locale } from "./i18n/shared";

const ADMIN_TOKEN_DIALOG_ID = "opencodex-admin-token-dialog";
const ADMIN_TOKEN_USERNAME = "OpenCodex";

export type AdminTokenValidation = "accepted" | "rejected" | "unavailable";
export type AdminTokenVerifier = (token: string) => Promise<AdminTokenValidation>;

/**
 * Ask for the management credential with a real sign-in form so browsers and
 * password managers can offer save/autofill. OpenCodex itself still keeps the
 * submitted token in memory only; persistence remains entirely browser-owned.
 */
export function promptForAdminToken(
  verifyToken: AdminTokenVerifier,
  locale: Locale = getActiveLocale(),
): Promise<string | null> {
  const messages = DICTS[locale];
  const titleText = messages["auth.adminTokenTitle"];

  return new Promise((resolve) => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    let settled = false;

    const dialog = document.createElement("dialog");
    dialog.id = ADMIN_TOKEN_DIALOG_ID;
    dialog.className = "modal-overlay";
    dialog.setAttribute("aria-labelledby", `${ADMIN_TOKEN_DIALOG_ID}-title`);

    const form = document.createElement("form");
    form.className = "modal-card";
    form.method = "post";
    form.action = window.location.href;
    form.autocomplete = "on";

    const heading = document.createElement("div");
    heading.className = "modal-head";
    const title = document.createElement("h3");
    title.id = `${ADMIN_TOKEN_DIALOG_ID}-title`;
    title.textContent = titleText;
    heading.append(title);

    const accountField = document.createElement("div");
    const accountLabel = document.createElement("label");
    accountLabel.className = "field-label";
    accountLabel.htmlFor = `${ADMIN_TOKEN_DIALOG_ID}-username`;
    accountLabel.textContent = messages["auth.adminAccountLabel"];
    const username = document.createElement("input");
    username.id = accountLabel.htmlFor;
    username.className = "input";
    username.type = "text";
    username.name = "username";
    username.autocomplete = "username";
    username.value = ADMIN_TOKEN_USERNAME;
    username.readOnly = true;
    accountField.append(accountLabel, username);

    const tokenField = document.createElement("div");
    tokenField.style.marginTop = "var(--space-4)";
    const tokenLabel = document.createElement("label");
    tokenLabel.className = "field-label";
    tokenLabel.htmlFor = `${ADMIN_TOKEN_DIALOG_ID}-password`;
    tokenLabel.textContent = messages["auth.adminTokenFieldLabel"];
    const password = document.createElement("input");
    password.id = tokenLabel.htmlFor;
    password.className = "input";
    password.type = "password";
    password.name = "password";
    password.autocomplete = "current-password";
    password.required = true;
    password.spellcheck = false;
    password.autocapitalize = "none";
    tokenField.append(tokenLabel, password);

    const validationError = document.createElement("div");
    validationError.className = "notice notice-err";
    validationError.setAttribute("role", "alert");
    validationError.hidden = true;

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "btn btn-ghost";
    cancel.textContent = messages["common.cancel"];
    const submit = document.createElement("button");
    submit.type = "submit";
    submit.className = "btn btn-primary";
    submit.textContent = messages["common.ok"];
    actions.append(cancel, submit);

    form.append(heading, accountField, tokenField, validationError, actions);
    dialog.append(form);

    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      if (dialog.open) dialog.close();
      dialog.remove();
      previouslyFocused?.focus();
      resolve(value);
    };

    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const token = password.value.trim();
      if (!token) {
        password.value = "";
        password.reportValidity();
        return;
      }
      password.disabled = true;
      submit.disabled = true;
      validationError.hidden = true;

      void verifyToken(token).then((result) => {
        if (settled) return;
        if (result === "accepted") {
          finish(token);
          return;
        }
        password.value = "";
        password.disabled = false;
        submit.disabled = false;
        validationError.textContent = result === "rejected"
          ? messages["auth.adminTokenRejected"]
          : messages["auth.adminTokenUnavailable"];
        validationError.hidden = false;
        password.focus();
      }).catch(() => {
        if (settled) return;
        password.value = "";
        password.disabled = false;
        submit.disabled = false;
        validationError.textContent = messages["auth.adminTokenUnavailable"];
        validationError.hidden = false;
        password.focus();
      });
    });
    cancel.addEventListener("click", () => finish(null));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(null);
    });

    document.body.append(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    queueMicrotask(() => password.focus());
  });
}
