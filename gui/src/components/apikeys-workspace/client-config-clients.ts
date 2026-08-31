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
 * Every entry is the product's OWN first-party asset, fetched and verified;
 * provenance per file is recorded in `gui/public/provider-icons/README.md`.
 *
 * `kimi` points at an asset already committed for the Moonshot provider, which
 * is the same brand as the Kimi Code client -- reusing it beats fetching a
 * second copy of one logo.
 *
 * `dsh` uses the DeepSeek Harness favicon rather than `deepseek-color.svg`: the
 * harness is first-party DeepSeek but it is a different product from the model
 * provider, and the provider logo would be a borrowed mark.
 *
 * Three clients are absent on purpose. `gajae` publishes only raster marks,
 * `hermes` upstream ships a text-glyph placeholder with no path data, and
 * `aside` has no first-party web asset at all. Each renders a monogram, which is
 * what this map's rule prescribes; the README records the reason for each.
 */
export const CLIENT_MARKS: Partial<Record<ExportClientId, string>> = {
  opencode: "/provider-icons/opencode.svg",
  pi: "/provider-icons/pi.svg",
  omp: "/provider-icons/oh-my-pi.svg",
  openclaw: "/provider-icons/openclaw.svg",
  kimi: "/provider-icons/kimi-color.svg",
  dsh: "/provider-icons/deepseek-harness.svg",
  zcode: "/provider-icons/zcode.svg",
  prime: "/provider-icons/prime-agent.svg",
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
