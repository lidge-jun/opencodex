/** Credential-shaped text stays out of literal API-key/config paths even when parsing fails. */
export function isGcpCredentialMaterial(value: string): boolean {
  const credentialField = /\b(?:service_account|authorized_user|external_account|private_key|refresh_token|client_secret)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;
  if (/[\[\{"']/.test(value) && credentialField.test(value)) return true;
  // Decode JSON escapes before classification; encoded field/type names have the same meaning.
  try { return credentialField.test(JSON.stringify(JSON.parse(value))); }
  catch { return false; }
}
