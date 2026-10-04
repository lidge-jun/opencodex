import type { Server } from "bun";
import type { OcxConfig } from "../../types";
import { getConfigDir } from "../../config/paths";
import type { DesktopPickerController } from "../desktop-picker";
import type { ClaudeFirstPartyDesired } from "../first-party-settings";
import { classifyInterceptClient, interceptRouteFor } from "./client-class";
import { createCliCatalogProvider } from "./cli-picker";
import { CLAUDE_INTERCEPT_HOSTS, isBrowserConnect, startConnectProxy, type ConnectProxyHandle } from "./connect-proxy";
import { startClaudeInterceptListener } from "./listener";
import { claudeInterceptCaCertPath, ensureLocalInterceptCaForStartup, issueLocalInterceptLeaf } from "./local-ca";
import { discardPickerCaKey, ensurePickerCa } from "./picker-ca";
import { drainPendingPickerCaUntrust } from "./picker-ca-cleanup";
import type { PickerRouteInput } from "./picker-models";
import {
  CLAUDE_INTERCEPT_PORT_OFFSET,
  claudeInterceptEnabled,
  claudeInterceptProxyPort,
  claudePickerProxyPort,
} from "./port-policy";
import { createPickerRuntime, type CreatePickerRuntimeOptions, type PickerRuntime } from "./picker-runtime";
import type { SecurityRunner } from "./picker-trust";
import { ensureClaudeInterceptProxyToken, readClaudeInterceptProxyToken } from "./proxy-auth";
import { buildClaudeInterceptEnv, migrateClaudeInterceptSettings } from "./settings";

/**
 * Lifecycle for the Claude intercept pair (CONNECT proxy + TLS listener).
 *
 * Started next to the public listener, torn down with it. The proxy port is derived from the
 * public port unless configured, because Claude Code's `settings.json` must name a port that
 * survives restarts; the TLS listener is ephemeral and only ever reached through the proxy.
 *
 * Picker mode adds a second CONNECT proxy on the next port, used as Claude Desktop's pinned egress
 * proxy. Desktop also hands that proxy to the Claude Code processes it spawns, so the choice is per
 * client: Claude Code (no User-Agent on CONNECT) trusts only the intercept CA and gets the
 * api.anthropic.com intercept and nothing else; the app itself (a browser User-Agent) trusts only
 * the login keychain and never meets the api.anthropic.com intercept, and only its claude.ai
 * tunnels may be terminated by the picker runtime (src/claude/intercept/picker-runtime.ts).
 */

export { CLAUDE_INTERCEPT_PORT_OFFSET, claudeInterceptEnabled, claudeInterceptProxyPort, claudePickerProxyPort } from "./port-policy";

export type ClaudeInterceptOutcome = { ok: true; state: ClaudeInterceptState } | { ok: false; reason: "disabled" | "client_role" | "ephemeral_port" | "port_in_use" | "stopped" | "failed"; port?: number; message?: string };

export interface ClaudeInterceptState {
  pickerReason?: "port_in_use" | "failed" | null;
  pickerFailurePort?: number;
  proxyPort: number;
  caCertPath: string;
  /** Desktop egress proxy for picker mode; null when the picker is not wired or could not bind. */
  pickerProxyPort: number | null;
}

export interface ClaudeInterceptHandle<T = undefined> extends ClaudeInterceptState {
  listener: Server<T>;
  stop(): Promise<void>;
}

let activeState: ClaudeInterceptState | null = null;
let activePicker: PickerRuntime | null = null;
let activeController: DesktopPickerController | null = null;

/** Live intercept endpoints, or `null` when the pair is not running in this process. */
export function getClaudeInterceptState(): ClaudeInterceptState | null {
  return activeState;
}

/** The running picker runtime, or `null` when picker mode is not wired in this process. */
export function getClaudePickerRuntime(): PickerRuntime | null {
  return activePicker;
}

/** The picker controller that owns every picker mutation while this server runs, or `null`. */
export function getClaudePickerController(): DesktopPickerController | null {
  return activeController;
}

/**
 * Persist `claudeCode.intercept.picker` through the field-scoped writer and adopt the committed
 * subtree into the live config, so a later whole-config save neither reverts nor re-applies it.
 */
export async function createPickerPreferenceWriter(live: OcxConfig): Promise<(value: boolean) => boolean> {
  const { adoptPersistedClaudeCode, mutatePersistedConfig } = await import("../../config");
  return value => {
    const outcome = mutatePersistedConfig(persisted => {
      const claudeCode = persisted.claudeCode ?? {};
      const intercept = claudeCode.intercept ?? {};
      if (intercept.picker === value) return { changed: false, value: structuredClone(persisted.claudeCode) };
      persisted.claudeCode = { ...claudeCode, intercept: { ...intercept, picker: value } };
      return { changed: true, value: structuredClone(persisted.claudeCode) };
    });
    if (outcome.status === "unavailable") return false;
    adoptPersistedClaudeCode(live, outcome.value);
    return true;
  };
}

export class ClaudeInterceptProxyBindError extends Error {
  readonly code: unknown;
  constructor(error: unknown, readonly port: number) {
    super(error instanceof Error ? error.message : "CONNECT proxy bind failed", { cause: error });
    this.code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  }
}

export interface StartClaudeInterceptOptions<T> {
  config: OcxConfig;
  /** Bound public port; the derived proxy port is offset from it. */
  publicPort: number;
  /**
   * Port the operator asked for. `0` (ephemeral) gives the derived proxy port no stable value
   * to write into `settings.json`, so intercept stays off unless `intercept.port` is explicit.
   */
  requestedPort?: number;
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  /** Live first-party intent; absent preserves router behavior. */
  desiredClients?: () => ClaudeFirstPartyDesired;
  maxRequestBodySize?: number;
  configDir?: string;
  /** Routes for Desktop's Code-tab picker. Picker mode is wired only when this is given. */
  loadPickerRoutes?: () => Promise<PickerRouteInput>;
  /** Test seam: builds the picker runtime. */
  createPicker?: (options: CreatePickerRuntimeOptions) => PickerRuntime;
  /** Test seam: bind real CONNECT handlers on kernel-assigned ports without probe-and-release races. */
  startProxy?: typeof startConnectProxy;
  /** Test seams: the macOS `security` runner and platform for the picker runtime and controller. */
  pickerSecurity?: SecurityRunner;
  pickerPlatform?: NodeJS.Platform;
}

/**
 * Bind both halves. Resolves `null` when intercept is disabled. A bind failure is reported by
 * rejecting; callers treat it as a degraded optional integration, never as a startup failure.
 */
export async function startClaudeIntercept<T>(options: StartClaudeInterceptOptions<T>): Promise<ClaudeInterceptHandle<T> | null> {
  // An older release may have left the picker's exportable signing key on disk. Remove it on every
  // start, even when the intercept or the picker is off, so an upgrade with the picker disabled
  // does not keep the key of a CA that may still be trusted. Failure here must not block startup.
  try { discardPickerCaKey(options.configDir ?? getConfigDir()); } catch { /* retried on the next start */ }
  if (!claudeInterceptEnabled(options.config)) return null;
  const explicitPort = typeof options.config.claudeCode?.intercept?.port === "number";
  if (options.requestedPort === 0 && !explicitPort) return null;
  const configDir = options.configDir ?? getConfigDir();
  const ca = await ensureLocalInterceptCaForStartup(configDir);
  const startProxy = options.startProxy ?? startConnectProxy;
  const authToken = ensureClaudeInterceptProxyToken(configDir);
  const leaf = issueLocalInterceptLeaf(ca, CLAUDE_INTERCEPT_HOSTS);
  // Refresh an env we already own (e.g. a pre-auth proxy URL left by an upgrade) before the
  // authenticated proxy takes over the port — a plain `ocx start` after an update would
  // otherwise 407 every CONNECT until the next `ocx ensure` or apply. Only `stale` state is
  // rewritten, so installs that never applied first-party are untouched.
  try {
    const proxyPort = claudeInterceptProxyPort(options.config, options.publicPort);
    migrateClaudeInterceptSettings(buildClaudeInterceptEnv(proxyPort, claudeInterceptCaCertPath(configDir), authToken));
  } catch (error) {
    // A skipped rewrite degrades to the pre-migration behaviour and ensure/apply retries it,
    // but silence here leaves upgraded clients hitting 407 with no recorded cause.
    console.warn(`[claude-intercept] settings migration skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
  const listener = startClaudeInterceptListener<T>({
    leaf,
    dispatch: options.dispatch,
    ...(options.desiredClients ? { route: (req: Request) =>
      interceptRouteFor(classifyInterceptClient(req.headers.get("user-agent")), options.desiredClients!()) } : {}),
    // The CLI's /model catalog (cli-picker.ts): wired from the routes alone, never from Desktop picker state.
    ...(options.loadPickerRoutes && options.desiredClients ? { cliCatalog: createCliCatalogProvider({
      configDir, loadRoutes: options.loadPickerRoutes, desiredClients: options.desiredClients,
    }) } : {}),
    upstreamBase: options.config.claudeCode?.anthropicBaseUrl,
    ...(options.maxRequestBodySize !== undefined ? { maxRequestBodySize: options.maxRequestBodySize } : {}),
  });
  let proxy: ConnectProxyHandle;
  try {
    proxy = await startProxy(claudeInterceptProxyPort(options.config, options.publicPort), {
      interceptPort: listener.port!,
      // A real apply may recreate a missing token while this listener remains live.
      // Read current validated authority per CONNECT; absent/invalid means deny, not mint.
      authToken: () => readClaudeInterceptProxyToken(configDir),
    });
  } catch (error) {
    await listener.stop(true);
    throw new ClaudeInterceptProxyBindError(error, claudeInterceptProxyPort(options.config, options.publicPort));
  }
  // Widened on purpose: assignments happen in nested awaits the catch below must still see.
  let picker = null as PickerRuntime | null;
  let pickerProxy = null as ConnectProxyHandle | null;
  let controller = null as DesktopPickerController | null;
  let pickerProxyLive = false;
  let pickerReason: ClaudeInterceptState["pickerReason"] = null;
  let pickerFailurePort: number | undefined;
  try {
    if (options.loadPickerRoutes) {
      // A picker authority is process-scoped, and older releases persisted an exportable ca.key
      // next to the published certificate. Drop that key before anything else: a cleanup failure
      // below must never leave a signing key on disk that outlives this process.
      discardPickerCaKey(configDir);
      const { inspectDesktopPickerProfile } = await import("../desktop-picker-profile");
      // The applied profile row is durable evidence of the user's picker selection. Rotation keeps
      // it in place — row id and its recorded previous selection included — so the picker proxy
      // can fail to bind without losing it, and the restore enable below only updates the proxy
      // URL inside the same row rather than recreating a selection around a placeholder pivot.
      const pickerProfile = inspectDesktopPickerProfile({
        configDir,
        ...(options.pickerPlatform ? { platform: options.pickerPlatform } : {}),
      });
      const pickerProfileApplied = pickerProfile.kind === "applied";
      let pickerBlocked = false;
      try {
        // A prior process may have died after publishing the journal but before cleanup. Finish
        // that entry before rotation can replace it, then drain the newly queued predecessor.
        const drain = () => drainPendingPickerCaUntrust(configDir, options.pickerSecurity, options.pickerPlatform);
        if (!await drain()) pickerBlocked = true;
        if (!pickerBlocked) {
          ensurePickerCa(configDir, { rotation: "startup" });
          if (!await drain()) pickerBlocked = true;
        }
      } catch (error) {
        pickerBlocked = true;
        pickerReason = "failed";
        console.warn(`⚠ Claude Desktop picker CA cleanup deferred: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (pickerBlocked) {
        pickerReason = "failed";
        console.warn("⚠ Claude Desktop picker disabled: the previous certificate could not be untrusted");
        if (pickerProfile.kind === "applied") {
          // Keep Desktop's actual pinned egress alive without ever constructing a TLS terminator.
          const port = Number(new URL(pickerProfile.proxyUrl).port);
          try {
            pickerProxy = await startProxy(port, {
              interceptPort: listener.port!,
              interceptHosts: [],
              selectTunnel: () => ({ kind: "blind" }),
            });
            pickerProxyLive = true;
          } catch (error) {
            pickerReason = error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE" ? "port_in_use" : "failed";
            if (pickerReason === "port_in_use") pickerFailurePort = port;
            console.warn(`⚠ Claude Desktop blind egress relay could not start: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
      picker = pickerBlocked ? null : (options.createPicker ?? createPickerRuntime)({
        config: options.config,
        configDir,
        loadRoutes: options.loadPickerRoutes,
        // The controller's lock: while it is held, periodic refreshes never arm.
        isBusy: () => controller?.busy() ?? false,
        // Metadata only: method, bootstrap or other, status, and the rewrite outcome.
        log: line => console.log(`[claude-picker] ${line}`),
        ...(options.pickerSecurity ? { security: options.pickerSecurity } : {}),
        ...(options.pickerPlatform ? { platform: options.pickerPlatform } : {}),
      });
      if (picker) {
        const runtime = picker;
        const interceptPort = listener.port!;
        const pickerPort = claudePickerProxyPort(options.config, options.publicPort);
        try {
          pickerProxy = await startProxy(pickerPort, {
            interceptPort,
            // No authToken: Desktop's egressProxyUrl cannot present proxy credentials, so this
            // listener stays an unauthenticated loopback relay until the profile format can carry
            // one. The intercept proxy above is the credential-bearing hop.
            // No host list here: the choice below depends on which client opened the tunnel.
            interceptHosts: [],
            selectTunnel: (host, port, request) => {
              // Desktop hands its pinned egress proxy to the Claude Code processes it spawns, so their
              // api.anthropic.com traffic arrives here too and gets the same intercept as on the Claude
              // Code proxy. Those processes trust only the intercept CA, so the picker never terminates
              // their claude.ai tunnels; only the app's own (browser) CONNECTs reach the picker.
              if (!isBrowserConnect(request)) {
                return port === 443 && (CLAUDE_INTERCEPT_HOSTS as readonly string[]).includes(host.toLowerCase())
                  ? { kind: "intercept", port: interceptPort }
                  : { kind: "blind" };
              }
              return runtime.selectTunnel(host, port);
            },
          });
          pickerProxyLive = true;
        } catch (error) {
          // Picker mode is optional: a busy port leaves the intercept pair running without it.
          // The selected profile row survives, so the next startup retries the restore once the
          // port is free again.
          pickerReason = error && typeof error === "object" && "code" in error && error.code === "EADDRINUSE" ? "port_in_use" : "failed";
          if (pickerReason === "port_in_use") pickerFailurePort = pickerPort;
          console.warn(`⚠ Claude Desktop picker proxy could not start: ${error instanceof Error ? error.message : String(error)}`);
          await runtime.stop();
          picker = null;
        }
      }
      if (picker) {
        // Dynamic: the controller reaches desktop-first-party, which imports this module.
        const [{ createDesktopPickerController }, { loadConfig }, persistPreference] = await Promise.all([
          import("../desktop-picker"),
          import("../../config"),
          createPickerPreferenceWriter(options.config),
        ]);
        const boundProxy = pickerProxy;
        controller = createDesktopPickerController({
          runtime: picker,
          readConfig: loadConfig,
          persistPreference,
          proxyPort: () => (pickerProxyLive && boundProxy ? boundProxy.port : null),
          configDir,
          ...(options.pickerSecurity ? { security: options.pickerSecurity } : {}),
          ...(options.pickerPlatform ? { platform: options.pickerPlatform } : {}),
        });
        await picker.start();
        // The rotated authority still needs the user's consent in the login keychain — a decline
        // reports trust_pending, and the picker stays a blind tunnel until trust is granted. When
        // Desktop was pinned to the picker before the restart, the regular enable flow re-trusts
        // the new authority and rewrites the profile row in place, so a restart does not silently
        // turn the picker off.
        if (pickerProfileApplied && controller) {
          void controller.enable({ persist: false, context: "server" })
            .catch(error => console.warn(`⚠ Claude Desktop picker restore failed: ${error instanceof Error ? error.message : String(error)}`));
        }
      }
    }
  } catch (error) {
    // Construction or start failed after the CONNECT proxy bound: release every socket first,
    // so the lifecycle's catch never leaves a bound port without a handle.
    pickerProxyLive = false;
    controller = null;
    await picker?.stop();
    await pickerProxy?.close();
    await proxy.close();
    await listener.stop(true);
    throw error;
  }
  const state: ClaudeInterceptState = {
    pickerReason,
    pickerFailurePort,
    proxyPort: proxy.port,
    caCertPath: claudeInterceptCaCertPath(configDir),
    pickerProxyPort: pickerProxy?.port ?? null,
  };
  activeState = state;
  activePicker = picker;
  activeController = controller;
  const ownPicker = picker;
  const ownController = controller;
  return {
    ...state,
    listener,
    stop: async () => {
      if (activeState === state) activeState = null;
      if (activePicker === ownPicker) activePicker = null;
      if (activeController === ownController) activeController = null;
      pickerProxyLive = false;
      await ownPicker?.stop();
      await pickerProxy?.close();
      await proxy.close();
      await listener.stop(true);
    },
  };
}
