/**
 * `ocx export --client <opencode|pi>` — print a client config for the live proxy.
 *
 * Two consumers, one payload (devlog 260731_client_config_export/020):
 *
 * - **Agent** (`--json`): stdout is exactly the client config JSON and nothing else, so
 *   `ocx export --client pi --json > models.json` is safe to pipe. Every diagnostic —
 *   including the `--out` write note — goes to stderr.
 * - **Human** (no flag): the JSON leads, then the destination path, the merge warning,
 *   the env export line, and the model/degraded counts.
 *
 * The command never writes the user's real config path. `--out` is an explicit target and
 * refuses to clobber an existing file without `--force`, because the common mistake
 * (`--out ~/.config/opencode/opencode.json`) would silently destroy other providers.
 *
 * Serialization itself belongs to src/clients/config-export.ts; this module only resolves
 * the base URL, filters the catalog, and renders. No secret is ever serialized: the config
 * carries the client's documented env reference and the real key stays in the environment.
 */
import { writeFileSync } from "node:fs";
import { loadConfig } from "../config";
import {
  EXPORT_CLIENTS,
  EXPORT_CLIENT_IDS,
  buildClientConfig,
  isExportClientId,
  opencodeProxyBaseUrl,
  type ExportClientId,
  type ExportModel,
} from "../clients/config-export";
import { opencodeCatalogFromProxyRows, type OpencodeProxyModelRow } from "./opencode";
import type { OcxConfig } from "../types";
import {
  CliUsageError,
  RuntimeApiError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeBaseUrl,
  runtimeRequest,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx export --client <${EXPORT_CLIENT_IDS.join("|")}> [--json] [--out <path>] [--force]`;

export interface ExportCommandDeps extends RuntimeApiDeps {
  /** Live config seam; tests inject a fixture instead of reading the user's config. */
  configImpl?: () => OcxConfig;
}

/**
 * `/api/models` row plus the modality list Pi consumes. The launcher's row type predates
 * the Pi exporter and stops at the fields OpenCode needs.
 */
type ExportProxyModelRow = OpencodeProxyModelRow & { inputModalities?: string[] };

/** Same authoritativeness rule the serializers apply, for the degraded-count line. */
function hasContextLimit(model: ExportModel): boolean {
  return typeof model.contextWindow === "number"
    && Number.isFinite(model.contextWindow)
    && model.contextWindow > 0;
}

/**
 * Export rows from proxy `/api/models` rows.
 *
 * `opencodeCatalogFromProxyRows` owns the visibility rules (drop `disabled`, drop dupes,
 * drop native under Codex Direct) — the export core does none of that, so a row filtered
 * here is the only thing keeping a disabled model out of a client's picker. Modalities are
 * re-joined by `namespaced` because the launcher's catalog type does not carry them.
 */
export function exportModelsFromProxyRows(
  rows: readonly ExportProxyModelRow[],
  config: OcxConfig,
): ExportModel[] {
  const modalities = new Map<string, string[]>();
  for (const row of rows) {
    const namespaced = row.namespaced?.trim();
    if (namespaced && Array.isArray(row.inputModalities) && row.inputModalities.length > 0) {
      if (!modalities.has(namespaced)) modalities.set(namespaced, [...row.inputModalities]);
    }
  }
  return opencodeCatalogFromProxyRows(rows, config).map(entry => {
    const model: ExportModel = {
      namespaced: entry.namespaced,
      provider: entry.provider ?? (entry.native ? "openai" : "routed"),
      id: entry.id ?? entry.namespaced,
    };
    if (entry.native) model.native = true;
    if (entry.displayName) model.displayName = entry.displayName;
    if (entry.contextWindow !== undefined) model.contextWindow = entry.contextWindow;
    const input = modalities.get(entry.namespaced);
    if (input) model.inputModalities = input;
    return model;
  });
}

/**
 * `http://host:port/v1` for the proxy that is actually listening.
 *
 * `runtimeBaseUrl` is the identity-checked `findLiveProxy` probe the launcher uses, and it
 * already throws the "Start it with: ocx start" error when nothing answers — so a config
 * with an empty models block can never be emitted.
 *
 * Resolved ONCE and handed back to `runtimeRequest` as `baseUrl`, so the catalog and the
 * exported endpoint can never come from two different probes.
 */
function proxyV1BaseUrl(root: string): string {
  const url = new URL(root);
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  return opencodeProxyBaseUrl(port, url.hostname);
}

function parseClient(args: string[]): ExportClientId {
  const raw = takeOption(args, "--client");
  if (raw === undefined) {
    throw new CliUsageError(`--client is required (${EXPORT_CLIENT_IDS.join(", ")})`, USAGE);
  }
  const client = raw.trim().toLowerCase();
  if (!isExportClientId(client)) {
    throw new CliUsageError(`--client must be one of: ${EXPORT_CLIENT_IDS.join(", ")}`, USAGE);
  }
  return client;
}

/**
 * Write the config, refusing to replace an existing file without `--force`.
 *
 * The `wx` flag does the refusal in the kernel rather than after an `existsSync` check, so
 * a file created between the two can never be truncated. Nothing is printed before this
 * runs: a refusal leaves both the target bytes and stdout untouched.
 */
function writeExport(path: string, text: string, force: boolean): void {
  try {
    writeFileSync(path, text, force ? { encoding: "utf8" } : { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new CliUsageError(
        `${path} already exists. Re-run with --force to replace it, or print the config and merge it yourself.`,
        USAGE,
      );
    }
    throw error;
  }
}

export async function handleExportCommand(argv: string[], deps: ExportCommandDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const client = parseClient(args);
    const wantsJson = takeFlag(args, "--json");
    const force = takeFlag(args, "--force");
    const out = takeOption(args, "--out");
    rejectArgs(args, USAGE);

    const spec = EXPORT_CLIENTS[client];
    const config = (deps.configImpl ?? loadConfig)();
    const root = await runtimeBaseUrl(deps);
    const rows = await runtimeRequest<ExportProxyModelRow[]>("/api/models", {}, { ...deps, baseUrl: root });
    if (!Array.isArray(rows)) {
      throw new RuntimeApiError("Management API returned an unexpected /api/models payload.", 502, rows);
    }
    const models = exportModelsFromProxyRows(rows, config);
    const clientConfig = buildClientConfig(client, { baseUrl: proxyV1BaseUrl(root), models, config });
    const text = JSON.stringify(clientConfig, null, 2);

    if (out !== undefined) writeExport(out, `${text}\n`, force);
    // stderr, so `--json` stdout stays byte-exact for a redirect.
    if (out !== undefined && wantsJson) console.error(`Wrote ${out}`);

    const degraded = models.filter(model => !hasContextLimit(model)).length;
    printData(clientConfig, wantsJson, [
      text,
      "",
      ...(out !== undefined ? [`Wrote ${out}`] : []),
      `Destination: ${spec.destination(process.env)}`,
      "Merge this provider block into that file; do not replace it.",
      `Before launching: ${spec.exportHint}`,
      `${models.length} model${models.length === 1 ? "" : "s"}; ${degraded} omit context limits (the client applies its own defaults).`,
    ]);
  });
}

export const EXPORT_USAGE = USAGE;
