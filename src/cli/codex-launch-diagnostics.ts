/** Fixed reasons only: never interpolate configuration, exceptions or credential paths. */
export const CODEX_TOKEN_REFUSALS = {
  args: "arguments are outside the audited allowlist",
  environment: "environment contains a proxy or unaudited credential control",
  home: "Codex home cannot be resolved unambiguously",
  ownership: "Codex home/config ownership or mutation protection could not be verified",
  systemConfig: "machine Codex configuration adds an unaudited system layer",
  systemNamespace: "machine Codex namespace protection could not be verified",
  systemNamespaceWritable: "machine Codex namespace allows other principals to create or replace configuration",
  additionalLayer: "home or system configuration adds an unaudited authentication/managed/requirements layer",
  layerInspection: "additional configuration layers could not be inspected",
  installationConfig: "OpenCodex configuration could not be verified",
  connection: "client connection is unavailable or uses an authless link relay",
  admission: "configured route does not require an admission credential",
  loopback: "configured destination is not an HTTP loopback listener",
  configRead: "Codex configuration could not be read within the inspection limit",
  consumers: "configuration has additional credential consumers",
  configShape: "configuration contains unaudited keys or values",
  systemProxy: "configuration enables an unaudited system proxy transport",
  provider: "configuration selects a profile or a different provider",
  rootUrl: "configuration overrides the managed loopback URL",
  project: "project configuration adds an unaudited layer",
  providerTransport: "provider transport does not match the managed loopback provider",
  inspection: "credential destination inspection failed",
  destination: "credential destination could not be verified",
  credential: "installation service credential is unavailable or invalid",
  collision: "service credential matches a management credential",
} as const;
export type CodexTokenRefusal = keyof typeof CODEX_TOKEN_REFUSALS;
export type CodexTokenRefusalReporter = (reason: CodexTokenRefusal) => void;

export function codexTokenWithheldDiagnostic(reason: CodexTokenRefusal): string {
  const remedy = process.platform === "win32" && reason === "systemNamespaceWritable"
    ? ". Default ProgramData creation rights are insufficient. The system Codex configuration folder under ProgramData must exist and be writable only by Administrators/SYSTEM, with its ancestors protected against replacement by other users. Ask an administrator to review the directory policy. opencodex never changes ACLs itself. Alternatively, supply your own key by exporting OPENCODEX_API_AUTH_TOKEN, which ocx codex leaves untouched. Launching without a fresh token."
    : ". Launching without a fresh token.";
  return `OpenCodex: automatic service token withheld; ${CODEX_TOKEN_REFUSALS[reason]}${remedy}`;
}
