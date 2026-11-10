export function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.indexOf("@");
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (!domain) return value;
  if (local.length === 1) return `*@${domain}`;
  if (local.length === 2) return `${local[0]}*@${domain}`;
  return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

/** A display label that never falls back to an unmasked or malformed identity. */
export function maskedAccountLabel(value: string | null | undefined): string | undefined {
  if (!value || value.length > 254 || !/^[A-Za-z0-9_%+\-]+(?:\.[A-Za-z0-9_%+\-]+)*@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(value)) return undefined;
  return maskEmail(value) ?? undefined;
}

/**
 * Dashboard account label that follows `privacy.maskEmails` (#8286).
 *
 * Masked mode is exactly {@link maskedAccountLabel}. Unmasked mode is the operator's explicit
 * disclosure choice, so it returns the stored address as-is (trimmed) — the same value the
 * unmasked `email` field already carries — and omits only empty, oversized, or control- or
 * format-character values (bidi overrides, zero-width marks) that could not render as one honest label.
 */
export function accountDisplayLabel(value: string | null | undefined, mask: boolean): string | undefined {
  if (mask) return maskedAccountLabel(value);
  const label = value?.trim();
  if (!label || label.length > 254 || /[\p{Cc}\p{Cf}]/u.test(label)) return undefined;
  return label;
}

/**
 * Whether stored account emails are masked in management and CLI projections (#3859).
 *
 * Fail closed on every ambiguity: a missing config, a missing `privacy` block, and a missing or
 * malformed `maskEmails` all mask. Only the literal boolean `false` unmasks, so a hand-edited
 * `"false"` string or a typo cannot silently disclose an address. Callers read this once at the
 * request boundary and pass the answer down — the projection helpers take a boolean rather than
 * a config so that `getLoginStatus` stays free of config I/O.
 */
export function emailMaskingEnabled(config: { privacy?: { maskEmails?: boolean } } | null | undefined): boolean {
  return config?.privacy?.maskEmails !== false;
}

/**
 * Project a stored account email for a surface outside the proxy (#3859).
 *
 * One redaction decision for every call site, rather than each one forking on the flag: an
 * unmasked projection still normalises an empty or absent address to `null`, so a consumer's
 * "is there an email" test cannot start answering differently just because masking is off.
 */
export function projectEmail(value: string | null | undefined, mask: boolean): string | null {
  if (!mask) return value ? value : null;
  return maskEmail(value);
}

export function maskAccountId(value: string | null | undefined): string | null {
  if (!value) return null;
  const id = value.trim();
  if (!id) return null;
  // Short IDs would disclose the entire identifier via the suffix; use a non-identifying placeholder.
  if (id.length <= 4) return "account-…";
  return `account-…${id.slice(-4)}`;
}
