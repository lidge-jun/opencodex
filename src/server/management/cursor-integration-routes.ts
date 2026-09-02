/**
 * Read-only status for the Cursor integration card.
 *
 * Cursor Private Inference is configured inside Cursor (Settings > Models > Gateway), not by
 * this proxy: its settings live in a SQLite database the running app rewrites and its API key
 * in the OS keychain, both out of bounds for opencodex. So this route only answers the three
 * questions the dashboard needs — which Cursor builds are installed, what to paste into the
 * gateway form, and whether a Cursor client has actually called `/v1/models` since the proxy
 * started — plus which active models will show Cursor's Reasoning and Context controls.
 */
import { readRuntimePort } from "../../config/process-state";
import { filterCatalogVisibleModels, nativeContextLimits, nativeOpenAiContextTier, nativeReasoningEfforts, uniqueCatalogModelsForRawPublicList, visibleNativeSlugs } from "../../codex/catalog";
import { cursorLastSeen, type CursorSeen } from "../../integrations/cursor-seen";
import { detectCursorInstalls, type CursorInstall } from "../../integrations/cursor-detect";
import { loadCursorEffortTable } from "../../integrations/cursor-effort-table";
import { configuredApiAuthToken, isApiAuthRequired, jsonResponse } from "../auth-cors";
import { fetchAllModels } from "../management-api";
import { predictCursorEffort } from "../models-capabilities";
import { expandCursorEffortRow, knownEffortRowIds } from "../effort-row";
import type { ManagementContext } from "./context";

export const CURSOR_GATEWAY_PLACEHOLDER_KEY = "opencodex-loopback";
export const CURSOR_GUIDE_URL = "https://lidge-jun.github.io/opencodex/guides/cursor-private-inference/";

export interface CursorIntegrationStatus {
  privateInference: { installed: boolean; path: string | null; version: string | null };
  regularCursor: { installed: boolean; path: string | null };
  gateway: { baseUrl: string; apiKeyMode: "credential" | "placeholder"; placeholder: string };
  lastSeen: CursorSeen | null;
  effortTable: { source: "bundle" | "static"; version: string | null; families: number | null };
  models: Array<{
    id: string;
    reasoning: string[] | null;
    family: string | null;
    tableLess: boolean;
    effortRows: string[];
    context: { defaultWindow: number; longWindow: number } | null;
  }>;
  guideUrl: string;
}

function pick(installs: CursorInstall[], build: CursorInstall["build"]): CursorInstall | undefined {
  return installs.find(install => install.build === build);
}

export async function buildCursorIntegrationStatus(
  ctx: Pick<ManagementContext, "config" | "deps"> & { url?: URL },
  installs: CursorInstall[] = detectCursorInstalls(),
): Promise<CursorIntegrationStatus> {
  const { config, deps } = ctx;
  const privateInference = pick(installs, "private-inference");
  const regular = pick(installs, "regular");
  const runtime = (deps.readRuntimePort ?? readRuntimePort)(process.pid);
  // The port the browser reached is the one Cursor on the same machine will reach too; the
  // runtime record and config.port are fallbacks for a request that carries no port.
  const port = runtime?.port ?? (Number(ctx.url?.port) || config.port);
  // Describes the public bind. A second unauthenticated loopback listener may exist, but the
  // value a user pastes into Cursor must work against the bind they will actually reach.
  const credentialConfigured = !!configuredApiAuthToken(config)
    || (config.apiKeys ?? []).some(entry => !!entry.key.trim());
  const apiKeyMode = isApiAuthRequired(config) || credentialConfigured ? "credential" : "placeholder";

  const limits = nativeContextLimits(config);
  // Same visibility rules as the raw /v1/models list Cursor will read: disabled models and
  // provider allowlists drop out here too, or the prediction shows rows Cursor never gets.
  const goModels = filterCatalogVisibleModels(await fetchAllModels(config), config);
  // supportsReasoning mirrors what the /v1/models row advertises (a non-empty ladder); the
  // gemini family withholds its control when it is false.
  const ids: Array<{ id: string; supportsReasoning: boolean; reasoningEfforts: readonly string[] }> = [
    ...visibleNativeSlugs(config).map(id => {
      const reasoningEfforts = nativeReasoningEfforts(id);
      return { id, supportsReasoning: reasoningEfforts.length > 0, reasoningEfforts };
    }),
    ...uniqueCatalogModelsForRawPublicList(goModels).map(model => ({
      id: model.alias ?? `${model.provider}/${model.id}`,
      supportsReasoning: (model.reasoningEfforts ?? []).length > 0,
      reasoningEfforts: model.reasoningEfforts ?? [],
    })),
  ];
  const table = (deps.loadCursorEffortTable ?? loadCursorEffortTable)(privateInference);
  const effortRowKnownIds = config.cursorEffortRows === true ? knownEffortRowIds(config) : undefined;
  const models = ids.map(({ id, supportsReasoning, reasoningEfforts }) => {
    const tier = nativeOpenAiContextTier(id, limits);
    const predicted = predictCursorEffort(id, table, supportsReasoning);
    return {
      id,
      reasoning: predicted.ladder,
      family: predicted.family,
      tableLess: predicted.ladder === null,
      effortRows: expandCursorEffortRow({ id }, reasoningEfforts, config, {
        knownIds: effortRowKnownIds,
        table,
        supportsReasoning,
      }).slice(1).map(row => row.id),
      context: tier ? { defaultWindow: tier.defaultWindow, longWindow: tier.longWindow } : null,
    };
  });
  const effortTable = table
    ? { source: "bundle" as const, version: table.version, families: table.families.length }
    : { source: "static" as const, version: null, families: null };

  return {
    privateInference: {
      installed: privateInference !== undefined,
      path: privateInference?.path ?? null,
      version: privateInference?.version ?? null,
    },
    regularCursor: { installed: regular !== undefined, path: regular?.path ?? null },
    gateway: {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKeyMode,
      placeholder: CURSOR_GATEWAY_PLACEHOLDER_KEY,
    },
    lastSeen: cursorLastSeen(),
    effortTable,
    models,
    guideUrl: CURSOR_GUIDE_URL,
  };
}

export async function handleCursorIntegrationRoutes(ctx: ManagementContext): Promise<Response | null> {
  const { req, url } = ctx;
  if (url.pathname === "/api/native-integrations/cursor" && req.method === "GET") {
    return jsonResponse(await buildCursorIntegrationStatus(ctx));
  }
  return null;
}
