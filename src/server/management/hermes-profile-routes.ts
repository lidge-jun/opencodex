/**
 * Hermes profile selection for the client-integration routes (#7674).
 *
 * A Hermes profile is the same integration in a different home, so this module
 * adds no mutation of its own. It turns a `profile` selector into a request
 * scope (that profile's ownership store and the HERMES_HOME Hermes runs it with)
 * and hands the request back to the generic routes, which then read, plan, write,
 * journal and restore exactly as they do for the default profile.
 *
 * Accepted spellings, all with `profile=<name>`:
 * - `/api/client-integrations/hermes` (GET, PUT)
 * - `/api/client-integrations/{journal,preview,restore,restore/preview}` with `client=hermes`
 *
 * The `profile` selector is removed before the request continues (the Aside
 * handlers treat any `profile` as an Aside account id, and a Hermes name such as
 * `123` is also a valid one), and the generic routes skip every Aside delegation
 * for a scoped request, `profile=default` included. A Hermes-scoped request can
 * therefore never reach an Aside operation, and it sees only Hermes rows.
 */
import {
  HERMES_DEFAULT_PROFILE,
  HermesProfileError,
  guardedHermesProfileStore,
  hermesProfileBoundary,
  hermesProfileEnv,
  hermesProfilePaths,
  hermesProfileStore,
  listHermesProfiles,
  resolveHermesProfile,
  type HermesProfile,
} from "../../integrations/hermes-profiles";
import type { ResolvedIntegrationPaths } from "../../integrations/registry";
import type { IntegrationStateStore } from "../../integrations/store";
import type { ExportModel } from "../../clients/config-export";
import { jsonResponse } from "../auth-cors";
import type { ManagementContext } from "./context";

export interface HermesRequestScope {
  profile: HermesProfile;
  store: IntegrationStateStore;
  env: NodeJS.ProcessEnv;
  /** Named profiles only; the default profile resolves its paths as it always has. */
  resolvedPaths?: ResolvedIntegrationPaths;
  /** Throws a HermesProfileError when the pinned profile no longer holds. */
  assertBoundary: () => void;
}

export interface HermesScopeBase {
  store: IntegrationStateStore;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export const HERMES_PROFILES_PATH = "/api/client-integrations/hermes/profiles";
const HERMES_CLIENT_PATH = "/api/client-integrations/hermes";
const HISTORY_PATHS = [
  "/api/client-integrations/journal",
  "/api/client-integrations/preview",
  "/api/client-integrations/restore",
  "/api/client-integrations/restore/preview",
];

/*
 * Keyed by the Request object, which every copy of the management context shares.
 * Entries die with the request.
 */
const scopes = new WeakMap<Request, HermesRequestScope>();

export function hermesRequestScope(req: Request): HermesRequestScope | undefined {
  return scopes.get(req);
}

function scopeFor(profile: HermesProfile, base: HermesScopeBase): HermesRequestScope {
  const env = base.env ?? process.env;
  if (profile.name === HERMES_DEFAULT_PROFILE) {
    return { profile, store: base.store, env, assertBoundary: () => {} };
  }
  const store = hermesProfileStore(base.store, profile.name);
  const assertBoundary = hermesProfileBoundary(profile, store);
  return {
    profile, store: guardedHermesProfileStore(store, assertBoundary), env: hermesProfileEnv(profile, env),
    resolvedPaths: hermesProfilePaths(profile), assertBoundary,
  };
}

function refusal(ctx: ManagementContext, error: HermesProfileError): Response {
  return jsonResponse({ error: error.message, code: error.code, clientId: "hermes" }, error.status, ctx.req, ctx.config);
}

/**
 * The context to continue with, a refusal, or null when the request names no
 * Hermes profile. `profile=default` keeps the root store and the default paths.
 */
export function scopeHermesProfileRequest(ctx: ManagementContext, base: HermesScopeBase): ManagementContext | Response | null {
  const { url, req } = ctx;
  if (!url.searchParams.has("profile")) return null;
  const onClientPath = url.pathname === HERMES_CLIENT_PATH;
  const onHistoryPath = HISTORY_PATHS.includes(url.pathname) && url.searchParams.get("client") === "hermes";
  if (!onClientPath && !onHistoryPath) return null;
  const selectors = url.searchParams.getAll("profile");
  if (selectors.length !== 1) {
    return refusal(ctx, new HermesProfileError("invalid_hermes_profile", 400, "Name exactly one Hermes profile"));
  }
  let scope: HermesRequestScope;
  try { scope = scopeFor(resolveHermesProfile(selectors[0]!, base.env ?? process.env, base.home), base); }
  catch (error) {
    if (error instanceof HermesProfileError) return refusal(ctx, error);
    throw error;
  }
  const next = new URL(url);
  next.searchParams.delete("profile");
  scopes.set(req, scope);
  return { ...ctx, url: next };
}

/**
 * GET /api/client-integrations/hermes/profiles: every profile with its own state.
 *
 * The roster loads first. Each profile's boundary is then checked and its state read with no await
 * in between, and a profile whose boundary does not hold is described from its path alone: reading
 * state also retries snapshot maintenance, which must never run through a store that was refused.
 */
export async function hermesProfileListResponse(
  ctx: ManagementContext,
  base: HermesScopeBase,
  loadModels: () => Promise<readonly ExportModel[]>,
  read: (scope: HermesRequestScope | null, models: readonly ExportModel[]) => object,
): Promise<Response | null> {
  if (ctx.url.pathname !== HERMES_PROFILES_PATH || ctx.req.method !== "GET") return null;
  if ([...ctx.url.searchParams.keys()].length > 0) {
    return refusal(ctx, new HermesProfileError("invalid_hermes_profile", 400, "The profile list takes no selectors"));
  }
  try {
    const models = await loadModels();
    const profiles = listHermesProfiles(base.env ?? process.env, base.home);
    const rows = profiles.map(profile => {
      let scope: HermesRequestScope;
      try { scope = scopeFor(profile, base); }
      catch (error) {
        if (!(error instanceof HermesProfileError)) throw error;
        return {
          clientId: "hermes", configPath: profile.configPath, state: "unsafe", installed: true,
          snapshotCount: -1, retentionDegraded: true, hermesProfile: profile.name, error: error.message,
        };
      }
      return { ...read(scope.resolvedPaths ? scope : null, models), hermesProfile: profile.name };
    });
    return jsonResponse({ profiles: rows }, 200, ctx.req, ctx.config);
  } catch (error) {
    if (error instanceof HermesProfileError) return refusal(ctx, error);
    return jsonResponse({
      error: error instanceof Error ? error.message : String(error),
      code: "integration_internal_error",
    }, 500, ctx.req, ctx.config);
  }
}
