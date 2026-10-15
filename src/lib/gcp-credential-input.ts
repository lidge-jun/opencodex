/** Structured JSON is never literal key material; malformed GCP text is also refused. */
export function isGcpCredentialMaterial(value: string): boolean {
  const credentialField = /\b(?:service_account|authorized_user|external_account|private_key|refresh_token|client_secret)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
  if (/[\[\{"']/.test(value) && credentialField.test(value)) return true;
  // Reject structured carriers outright rather than recursively guessing their credential shape.
  // This includes quoted/array/object wrappers with arbitrarily escaped or nested JSON inside.
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "string" || (parsed !== null && typeof parsed === "object");
  }
  catch { return false; }
}
