/** Closed, account-free diagnostics: never project a provider's raw error text. */
const messages = {
  "cancelled": "Muse Code login cancelled.",
  "pointer-unreadable": "Could not read the Muse Code credential file. Check its permissions or run `muse login` again.",
  "pointer-invalid": "The Muse Code credential file is not valid JSON or has an invalid shape. Run `muse login` to rewrite it.",
  "storage-unsupported": "Muse Code stored its credential with an unsupported backend; only the macOS Keychain import is verified. Retry import or paste an existing Muse Code key when prompted.",
  "keychain-timeout": "The Muse Code Keychain approval timed out after 120s. Unlock the login keychain, approve the prompt and retry, or paste an existing Muse Code key when prompted.",
  "keychain-denied": "Access to the Muse Code Keychain entry was denied or cancelled. Approve the Keychain prompt and retry, or paste an existing Muse Code key when prompted.",
  "keychain-locked": "The Muse Code Keychain entry requires user interaction. Unlock the login keychain and retry from an interactive macOS session, or paste an existing Muse Code key when prompted.",
  "keychain-missing": "The Muse Code Keychain entry was not found. Run `muse login` again, or paste an existing Muse Code key when prompted.",
  "keychain-unreadable": "Could not read the Muse Code credential from the macOS Keychain. Run `muse login` again, or paste an existing Muse Code key when prompted.",
  "keychain-invalid": "The Muse Code Keychain entry is not valid JSON or has an invalid shape. Run `muse login` to rewrite it.",
  "key-missing": "The Muse Code Keychain entry carries no usable API key. Run `muse login` again, or paste an existing Muse Code key when prompted.",
  "key-format": "The Muse Code credential is not in the expected Meta API key format. Run `muse login` again, or paste an existing Muse Code key when prompted.",
  "manual-key-missing": "The pasted Muse Code credential carries no usable API key. Copy it again from https://dev.meta.ai.",
  "manual-key-format": "The pasted Muse Code credential is not in the expected Meta API key format. Copy it again from https://dev.meta.ai.",
  "validation-network": "Could not reach the Meta Model API to validate the Muse Code credential. Check the proxy host's network and retry.",
  "validation-timeout": "The Meta Model API credential validation timed out after 10s. Check the proxy host's network and retry.",
  "validation-http": "The Muse Code credential was rejected by the Meta Model API. Renew it with `muse login` or copy it again from https://dev.meta.ai, then retry.",
} as const;

export type MuseLoginErrorKind = keyof typeof messages;

export class MuseLoginError extends Error {
  constructor(readonly kind: MuseLoginErrorKind, readonly status?: number) {
    super(museLoginErrorMessage(kind, status));
    this.name = "MuseLoginError";
  }
}

export function museLoginErrorMessage(kind: MuseLoginErrorKind, status?: number): string {
  const message = Object.hasOwn(messages, kind) ? messages[kind] : messages["keychain-unreadable"];
  return kind === "validation-http" && Number.isInteger(status) && status! >= 100 && status! <= 599
    ? `${message} (HTTP ${status})`
    : message;
}

export function publicMuseLoginErrorMessage(error: unknown): string | undefined {
  // Reconstruct from the closed kind; even a mutated Error.message cannot leak a key.
  return error instanceof MuseLoginError ? museLoginErrorMessage(error.kind, error.status) : undefined;
}
