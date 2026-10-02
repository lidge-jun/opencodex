import type { Server } from "bun";
import type { OcxConfig } from "../../types";
import type { PickerRouteInput } from "../../claude/intercept/picker-models";
import { observeClaudeDesktopMode, type ClaudeDesktopModeObservation } from "../../claude/desktop-first-party";
import { firstPartyDesired, type ClaudeFirstPartyDesired } from "../../claude/first-party-settings";
import {
  claudeInterceptEnabled,
  startClaudeIntercept,
  type ClaudeInterceptHandle,
  type StartClaudeInterceptOptions,
  type ClaudeInterceptOutcome,
  ClaudeInterceptProxyBindError,
} from "../../claude/intercept/runtime";

/**
 * Owns the Claude intercept pair (CONNECT proxy + TLS listener) on behalf of `startServer`.
 * The pair is an optional integration: a bind failure degrades to a warning, never to a
 * startup failure, because every other client keeps working without it. `startServer` stays
 * synchronous, so the start is fire-and-forget and `stop()` awaits whatever it produced.
 */
export interface ClaudeInterceptLifecycle<T> {
  /** True once the TLS listener has bound and `requestServer` is it. */
  ownsListener(requestServer: Server<T>): boolean;
  start(options: StartClaudeInterceptOptions<T>): void;
  ensure(): Promise<ClaudeInterceptOutcome>;
  lastOutcome(): ClaudeInterceptOutcome | null;
  stop(): Promise<void>;
}

export function buildInterceptDesiredClients(config: OcxConfig, observed: ClaudeDesktopModeObservation): () => ClaudeFirstPartyDesired {
  return () => claudeInterceptEnabled(config)
    ? firstPartyDesired(config, observed)
    : { desktop: false, cli: false };
}

/**
 * Routes for Desktop's Code-tab picker: the same inputs `/api/sync` gives the gateway profile
 * (src/server/management/config-routes.ts), read from the persisted config at call time. Dynamic
 * imports keep the catalog and discovery off the synchronous startup path.
 */
export async function loadPickerRoutesFromCatalog(): Promise<PickerRouteInput> {
  const [{ loadConfig }, { fetchAllModels }, catalog] = await Promise.all([
    import("../../config"),
    import("../management-api"),
    import("../../codex/catalog"),
  ]);
  const config = loadConfig();
  const models = await fetchAllModels(config);
  return {
    nativeSlugs: [...catalog.desktopVisibleNativeSlugs(config)],
    routedModels: catalog.filterCatalogVisibleModels(models, config)
      .map(model => ({ provider: model.provider, id: model.id, contextWindow: model.contextWindow })),
    ...(config.claudeCode?.desktopProfile ? { profile: config.claudeCode.desktopProfile } : {}),
    nativeContextCap: catalog.nativeContextLimits(config),
  };
}

export function createClaudeInterceptLifecycle<T>(): ClaudeInterceptLifecycle<T> {
  let listener: Server<T> | null = null;
  let options: StartClaudeInterceptOptions<T> | undefined;
  let handle: ClaudeInterceptHandle<T> | null = null;
  let inflight: Promise<ClaudeInterceptOutcome> | undefined;
  let stopped = false;
  let startupPending = false;
  let retryAfterStartup = false;
  let observed: ClaudeDesktopModeObservation | undefined;
  const stateOf = (bound: ClaudeInterceptHandle<T>) => ({ proxyPort: bound.proxyPort, caCertPath: bound.caCertPath, pickerProxyPort: bound.pickerProxyPort, pickerReason: bound.pickerReason ?? null, pickerFailurePort: bound.pickerFailurePort });
  let outcome: ClaudeInterceptOutcome | null = null;
  const ensure = (): Promise<ClaudeInterceptOutcome> => {
    if (stopped) return Promise.resolve(outcome = { ok: false, reason: "stopped" });
    if (inflight) {
      if (startupPending) retryAfterStartup = true;
      return inflight;
    }
    if (handle) {
      if (options) observed = observeClaudeDesktopMode(options.config);
      return Promise.resolve(outcome = { ok: true, state: stateOf(handle) });
    }
    if (!options) return Promise.resolve(outcome = { ok: false, reason: "failed" });
    const opts = options;
    const run = async (): Promise<ClaudeInterceptOutcome> => {
      if (opts.config.runtimeRole === "client") return { ok: false, reason: "client_role" };
      if (!claudeInterceptEnabled(opts.config)) return { ok: false, reason: "disabled" };
      if (opts.requestedPort === 0 && typeof opts.config.claudeCode?.intercept?.port !== "number")
        return { ok: false, reason: "ephemeral_port" };
      try {
        observed = observeClaudeDesktopMode(opts.config);
        handle = await startClaudeIntercept<T>({
          ...opts,
          desiredClients: () => buildInterceptDesiredClients(opts.config, observed!)(),
          loadPickerRoutes: opts.loadPickerRoutes ?? loadPickerRoutesFromCatalog,
          dispatch: (req, requestServer) => {
            listener ??= requestServer;
            return opts.dispatch(req, requestServer);
          },
        });
        if (!handle) return { ok: false, reason: "disabled" };
        listener = handle.listener;
        console.log(`🔐 Claude intercept proxy active on http://127.0.0.1:${handle.proxyPort} (CONNECT api.anthropic.com → local TLS)`);
        return { ok: true, state: stateOf(handle) };
      } catch (error) {
        listener = null;
        console.warn(`⚠ Claude intercept proxy could not start: ${error instanceof Error ? error.message : String(error)}`);
        return error instanceof ClaudeInterceptProxyBindError && error.code === "EADDRINUSE"
          ? { ok: false, reason: "port_in_use", port: error.port }
          : { ok: false, reason: "failed" };
      }
    };
    inflight = run().then(async result => {
      // An ensure arriving during startup first joins that attempt, then retries its null outcome.
      if (!result.ok && retryAfterStartup && !stopped) return run();
      return result;
    }).then(result => outcome = result).finally(() => {
      inflight = undefined; startupPending = false; retryAfterStartup = false;
    });
    return inflight;
  };
  return {
    ownsListener: requestServer => listener !== null && requestServer === listener,
    start(opts) { options = opts; startupPending = true; void ensure(); },
    ensure,
    lastOutcome: () => outcome,
    async stop() {
      stopped = true;
      await inflight;
      await handle?.stop();
      handle = null;
      listener = null;
      outcome = { ok: false, reason: "stopped" };
    },
  };
}
