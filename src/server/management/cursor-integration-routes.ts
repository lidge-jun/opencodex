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
import { filterCatalogVisibleModels, nativeContextLimits, nativeOpenAiContextTier, uniqueCatalogModelsForRawPublicList, visibleNativeSlugs } from "../../codex/catalog";
import { cursorLastSeen, type CursorSeen } from "../../integrations/cursor-seen";
import { detectCursorInstalls, type CursorInstall } from "../../integrations/cursor-detect";
import { configuredApiAuthToken, isApiAuthRequired, jsonResponse } from "../auth-cors";
import { fetchAllModels } from "../management-api";
import { cursorEffortFamily } from "../models-capabilities";
import type { ManagementContext } from "./context";

export const CURSOR_GATEWAY_PLACEHOLDER_KEY = "opencodex-loopback";
export const CURSOR_GUIDE_URL = "https://lidge-jun.github.io/opencodex/guides/cursor-private-inference/";

export interface CursorIntegrationStatus {
  privateInference: { installed: boolean; path: string | null; version: string | null };
  regularCursor: { installed: boolean; path: string | null };
  gateway: { baseUrl: string; apiKeyMode: "credential" | "placeholder"; placeholder: string };
  lastSeen: CursorSeen | null;
  models: Array<{
    id: string;
    reasoning: string[] | null;
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
  const ids = [
    ...visibleNativeSlugs(config),
    ...uniqueCatalogModelsForRawPublicList(goModels).map(model => model.alias ?? `${model.provider}/${model.id}`),
  ];
  const models = ids.map(id => {
    const tier = nativeOpenAiContextTier(id, limits);
    return {
      id,
      reasoning: cursorEffortFamily(id),
      context: tier ? { defaultWindow: tier.defaultWindow, longWindow: tier.longWindow } : null,
    };
  });

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
