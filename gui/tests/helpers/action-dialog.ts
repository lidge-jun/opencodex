/**
 * Drives the in-page consent dialog that replaced `confirm()` and `prompt()`.
 *
 * Component tests used to answer consent by stubbing `confirm()` to true, which is exactly
 * why CI never saw that the app's webview draws no platform dialog at all. Answering the
 * real dialog instead means a component that stopped opening one fails here.
 */
function currentDialog(doc: Document): HTMLDialogElement {
  const dialog = doc.querySelector("dialog.modal-overlay");
  if (!dialog) throw new Error("no in-page dialog is open");
  return dialog as HTMLDialogElement;
}

/** True when a consent or text-entry dialog is on screen. */
export function actionDialogOpen(doc: Document): boolean {
  return doc.querySelector("dialog.modal-overlay") !== null;
}

/** The dialog's message, as the user reads it. */
export function actionDialogText(doc: Document): string {
  return currentDialog(doc).textContent ?? "";
}

/** Answers yes. The accepting control is the form's submit button. */
export function acceptActionDialog(doc: Document): void {
  const accept = currentDialog(doc).querySelector("button[type=submit]");
  if (!accept) throw new Error("the dialog has no accepting button");
  (accept as HTMLButtonElement).click();
}

/** Answers no, which must leave the caller's early return intact. */
export function dismissActionDialog(doc: Document): void {
  const cancel = currentDialog(doc).querySelector(".modal-actions button[type=button]");
  if (!cancel) throw new Error("the dialog has no cancelling button");
  (cancel as HTMLButtonElement).click();
}

/** Types into the text-entry dialog before accepting it. */
export function fillActionDialog(doc: Document, value: string): void {
  const input = currentDialog(doc).querySelector("input");
  if (!input) throw new Error("the dialog has no text field");
  (input as HTMLInputElement).value = value;
}
