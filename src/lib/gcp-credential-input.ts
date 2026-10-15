/** Credential-shaped text stays out of literal API-key/config paths even when parsing fails. */
export function isGcpCredentialMaterial(value: string): boolean {
  return /[\[\{"']/.test(value)
    && /\b(?:service_account|authorized_user|external_account|private_key|refresh_token|client_secret)\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value);
}
