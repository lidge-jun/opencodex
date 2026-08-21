/**
 * The export clients the API tab renders, and the envelope shape the route
 * returns for each (devlog 260802/010 §Client list ownership).
 *
 * This list is deliberately local. `EXPORT_CLIENT_IDS` lives in
 * `src/clients/config-export.ts`, which is backend code — importing it here
 * would pull `node:os` and `node:path` into the browser bundle. Keep in sync
 * with EXPORT_CLIENT_IDS by hand; adding a client server-side renders no row
 * until this tuple changes.
 */
export const CLIENTS = ["opencode", "pi", "omp", "hermes", "openclaw", "kimi", "gajae", "dsh", "mcode", "zcode", "prime"] as const;
export type ExportClientId = (typeof CLIENTS)[number];

export const CLIENT_LABEL_KEYS = {
  opencode: "api.clientConfig.clientOpencode",
  pi: "api.clientConfig.clientPi",
  omp: "api.clientConfig.clientOmp",
  hermes: "api.clientConfig.clientHermes",
  openclaw: "api.clientConfig.clientOpenclaw",
  kimi: "api.clientConfig.clientKimi",
  gajae: "api.clientConfig.clientGajae",
  dsh: "api.clientConfig.clientDsh",
  mcode: "api.clientConfig.clientMcode",
  zcode: "api.clientConfig.clientZcode",
  prime: "api.clientConfig.clientPrime",
} as const;

/**
 * Brand mark per client. Only a real asset belongs here; a client with none
 * falls back to a monogram tile rather than borrowing another product's logo.
 * Separate from `provider-icons.ts` on purpose: export-client ids and provider
 * ids are unrelated namespaces that happen to share the string "opencode".
 *
 * `pi.svg` is the Pi project's own favicon (`https://pi.dev/favicon.svg`);
 * provenance is recorded in `gui/public/provider-icons/README.md`. Both marks
 * carry their own dark background, so they read the same in either theme.
 */
export const CLIENT_MARKS: Partial<Record<ExportClientId, string>> = {
  opencode: "/provider-icons/opencode.svg",
  pi: "/provider-icons/pi.svg",
};

/** The `/api/client-config` 200 envelope, read off the route rather than a design doc. */
export interface ClientConfigEnvelope {
  client: ExportClientId;
  /** Download filename. Server-owned: the GUI must never name the file itself. */
  filename: string;
  destination: string;
  apiKeyEnv: string;
  exportHint: string;
  modelCount: number;
  modelsWithoutLimits: number;
  /**
   * The client's own format and the exact bytes for it. The panel used to
   * re-serialize `config` as JSON, which is wrong for the four clients that do
   * not use JSON — a TOML file rendered as JSON does not parse at all.
   */
  format: string;
  mediaType: string;
  text: string;
  config: unknown;
}
