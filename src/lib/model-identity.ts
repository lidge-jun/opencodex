import { redactSecretString } from "./redact";

/** Longest model identity a row or relayed header may carry. */
export const MAX_MODEL_IDENTITY_LENGTH = 128;

/**
 * A model identity (served, resolved, or a relayed model header) is an identifier, never free-form
 * text to truncate into one: `[A-Za-z0-9._:/@-]`, at most 128 characters. A value the secret redactor
 * would change is dropped, because credential-shaped text can fit the identifier alphabet.
 */
export function boundedModelIdentity(value: unknown): string | undefined {
  return typeof value === "string"
    && value.length <= MAX_MODEL_IDENTITY_LENGTH
    && /^[A-Za-z0-9._:/@-]+$/.test(value)
    && redactSecretString(value) === value
    ? value
    : undefined;
}
