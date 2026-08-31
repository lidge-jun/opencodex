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
export const CLIENTS = ["opencode", "pi", "omp", "hermes", "openclaw", "kimi", "gajae", "dsh", "mcode", "zcode", "prime", "aside"] as const;
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
  aside: "api.clientConfig.clientAside",
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
 * `aside` is the one mark not taken from the web: Aside publishes no favicon.svg,
 * so its symbol comes out of the shipping application, where the vendor names the
 * module `official-brand-symbol`. Still first-party, just not fetched.
 *
 * Three are traced rather than fetched, because their vendors publish no usable
 * vector: `hermes` from the Hermes desktop application icon, `gajae` from the
 * Gajae mascot PNG. A trace follows the source pixels -- it is not a redraw --
 * and the conversion parameters are in the README beside the source URL, so the
 * result can be reproduced. What is still refused: squeezing a horizontal
 * wordmark into this square slot, and a full-frame silhouette plate that renders
 * as a filled box at 20px. Both candidates existed and both were rejected;
 * `devlog/_plan/260831_aside_client_and_integrations_ux/005_remaining_marks_provenance.md`
 * names them.
 */
export const CLIENT_MARKS: Partial<Record<ExportClientId, string>> = {
  opencode: "/provider-icons/opencode.svg",
  pi: "/provider-icons/pi.svg",
  omp: "/provider-icons/oh-my-pi.svg",
  hermes: "/provider-icons/hermes-agent.svg",
  openclaw: "/provider-icons/openclaw.svg",
  kimi: "/provider-icons/kimi-color.svg",
  gajae: "/provider-icons/gajae-code.svg",
  dsh: "/provider-icons/deepseek-harness.svg",
  mcode: "/provider-icons/minimax.svg",
  zcode: "/provider-icons/zcode.svg",
  prime: "/provider-icons/prime-agent.svg",
  aside: "/provider-icons/aside.svg",
};

/**
 * Marks whose artwork is a single-ink silhouette, so the ink has to come from the
 * theme rather than from the file. Drawn through a CSS mask tinted with the row's
 * text color, the way `.provider-icon-mask` already handles provider logos.
 *
 * Without this each of them disappears against one of the two themes: `prime`
 * ships white-on-transparent and vanishes in light mode, while `opencode`
 * (#211E1E) and `kimi` (#1A1A1A) vanish in dark. That is not hypothetical -- a
 * rendered check of every mark showed `prime` blank on white and `opencode` and
 * `kimi` blank on #0d1117. `hermes` joined them the same way: its traced
 * artwork is one ink, and a 20px render on #0d1117 showed nothing at all.
 *
 * A multi-color mark must never be listed here: masking discards its colors and
 * would flatten a brand palette into one ink. That is why `gajae` (seven traced
 * layers) and `mcode` (a three-stop gradient) stay images despite arriving in
 * the same pass as `hermes`.
 */
export const MONOCHROME_CLIENT_MARKS: ReadonlySet<ExportClientId> = new Set<ExportClientId>([
  "opencode",
  "kimi",
  "prime",
  "aside",
  "hermes",
]);

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
