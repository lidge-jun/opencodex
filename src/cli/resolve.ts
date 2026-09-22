/**
 * `ocx resolve` — the machine-readable runtime resolution surface for an embedding shell.
 *
 * D5 of devlog/_plan/260921_app_runtime_ownership/: the desktop shell must stop resolving
 * the config home, the port and liveness itself. The tuned probe budgets in
 * src/server/proxy-liveness.ts exist because a shell-side reimplementation answered
 * "nobody listening" twice and started duplicate proxies; this verb exposes that module's
 * verdict instead of copying it, alongside src/config/paths.ts (the home) and the CLI's
 * own preferred-port selection (`config.port ?? 10100` — resolve takes no --port).
 *
 * Contract:
 *  - `--json` puts exactly ONE JSON document on stdout, versioned by `schema`; the
 *    default prints two human lines, the same opt-in split as `ocx ready --json`.
 *  - liveness has three answers, not two: "live", "absent-proven" (every recorded and
 *    configured endpoint definitively refused or answered non-opencodex), and unknown.
 *    Unknown NEVER reaches the wire as absent — a probe that timed out, a listener that
 *    withheld /healthz, or an identity mismatch exits 1 instead. Only "absent-proven"
 *    may authorise starting a new runtime.
 *  - exit 0 whenever a trustworthy verdict exists — live, or proven absent. A MISSING
 *    config.json is defaults, not an error.
 *  - exit 1 when the CLI cannot resolve: an invalid config.json must NOT be answered
 *    with `loadConfig`'s repair-to-defaults behaviour, because that hands the caller
 *    a guessed port; and unknown liveness must not be answered as absence.
 *  - exit 64 for any argument, pre-parsed in src/cli/root.ts before preflight side
 *    effects, mirroring `ocx ready`. The verb is read-only and listed in
 *    skipsCodexShimAutoRestore, so a lookup made to populate a consent surface never
 *    triggers a shim repair side effect.
 *
 * Discovery uses the START_OWNERSHIP_LIVENESS budget, not the 750ms single-shot default:
 * the shell's launch decision keys on this verdict, and answering "nobody" for a slow
 * live proxy is the duplicate-proxy decision the start path tunes against (#5004).
 *
 * Lives outside cli/index.ts (which dispatches argv at module top level) so tests can
 * import it, the same split as ready.ts.
 */
import { readConfigDiagnostics, type ConfigDiagnostics } from "../config";
import { getConfigDir } from "../config/paths";
import { readRuntimePort } from "../config/process-state";
import { packageVersion } from "../lib/package-version";
import {
  findLiveProxy,
  probeEndpointLiveness,
  START_OWNERSHIP_LIVENESS,
  type EndpointLiveness,
  type LiveProxy,
} from "../server/proxy-liveness";
import { endpointsToProve, everyEndpointProvenDownAsync, type ProbeEndpoint } from "./uninstall-plan";

/** Wire version of the resolve document. Bump only on an incompatible shape change. */
export const RESOLVE_SCHEMA = "ocx-resolve/1";

/** The port every preferred-port selection in the CLI falls back to. */
export const RESOLVE_DEFAULT_PORT = 10100;

export interface ResolveLivenessJson {
  /**
   * "live" when the identity-checked probe found our proxy; "absent-proven" when every
   * recorded and configured endpoint is definitively dead. The third state — unknown —
   * exits 1 before this document is printed, so it never appears on the wire as absence.
   */
  status: "live" | "absent-proven";
  pid: number | null;
  port: number | null;
  /** Raw bind hostname that answered; compose probe URLs via probeHostname semantics. */
  hostname?: string;
  /** Where the verdict came from: the runtime record, or the configured listen port. */
  source: LiveProxy["source"] | null;
  /** Version the live proxy reported on /healthz, when it reported one. */
  version?: string;
  /** Listener role the live proxy reported, when it reported one ("client" = connected client). */
  role?: string;
}

export interface ResolveJson {
  schema: typeof RESOLVE_SCHEMA;
  /** Version of this CLI binary, so a shell can compare its engine against the live proxy. */
  cliVersion: string;
  /** Resolved opencodex home (OPENCODEX_HOME or ~/.opencodex), from src/config/paths.ts. */
  configHome: string;
  port: {
    /** The port a client should use: the live listener's port when one answers, else the configured one. */
    effective: number;
    /** The configured listen port (config.port ?? 10100); what a start would prefer. */
    configured: number;
    /** Whether `effective` came from a live proxy or from configuration. */
    source: LiveProxy["source"];
  };
  liveness: ResolveLivenessJson;
}

export interface ResolveArgs {
  json: boolean;
}

export type ResolveParseResult = { ok: true; args: ResolveArgs } | { ok: false; code: 64 };

/** Pure argument parser: the only flag is `--json`. */
export function parseResolveArgs(argv: string[]): ResolveParseResult {
  for (const flag of argv) {
    if (flag !== "--json") return { ok: false, code: 64 };
  }
  return { ok: true, args: { json: argv.includes("--json") } };
}

export interface ResolveIo {
  configDir?: () => string;
  readDiagnostics?: () => ConfigDiagnostics;
  findLive?: () => Promise<LiveProxy | null>;
  /** Runtime-port record reader; production default is readRuntimePort. */
  readRuntime?: () => { port?: number; hostname?: string } | null;
  /** Tri-state endpoint probe; production default runs in-process for compiled standalone binaries. */
  probeEndpoint?: (endpoint: ProbeEndpoint) => EndpointLiveness | Promise<EndpointLiveness>;
  cliVersion?: () => string;
  stdout?: { log: (s: string) => void };
  stderr?: { error: (s: string) => void };
}

function livenessJson(live: LiveProxy | null): ResolveLivenessJson {
  // Reaching here with null means absence was PROVEN by the caller (unknown exits 1
  // before this document is built).
  if (!live) return { status: "absent-proven", pid: null, port: null, source: null };
  return {
    status: "live",
    pid: live.pid,
    port: live.port,
    source: live.source,
    ...(live.hostname === undefined ? {} : { hostname: live.hostname }),
    ...(live.version === undefined ? {} : { version: live.version }),
    ...(live.role === undefined ? {} : { role: live.role }),
  };
}

/** Pure shaper: one live verdict plus configuration becomes the wire document. */
export function buildResolveJson(
  config: { port?: number },
  live: LiveProxy | null,
  configHome: string,
  cliVersion: string,
): ResolveJson {
  const configured = config.port ?? RESOLVE_DEFAULT_PORT;
  return {
    schema: RESOLVE_SCHEMA,
    cliVersion,
    configHome,
    port: {
      effective: live ? live.port : configured,
      configured,
      source: live ? live.source : "config",
    },
    liveness: livenessJson(live),
  };
}

/**
 * Human form: two lines, no prose flourish — an operator skims it, a shell uses --json.
 */
function reportHuman(json: ResolveJson, stdout: { log: (s: string) => void }): void {
  stdout.log(`Config home: ${json.configHome}`);
  const live = json.liveness;
  if (live.status === "live") {
    const pidText = live.pid === null ? "unknown" : String(live.pid);
    const versionText = live.version ?? "unknown version";
    stdout.log(`Proxy live on port ${json.port.effective} (PID ${pidText}, ${versionText}); effective port ${json.port.effective}.`);
  } else {
    stdout.log(`No live proxy (absence proven); effective port ${json.port.effective} (configured).`);
  }
}

/**
 * Run `ocx resolve` over injected I/O. Returns the exit code. The production defaults
 * read config through the diagnostics surface (which distinguishes missing, valid and
 * invalid instead of repairing to defaults) and perform one identity-checked discovery
 * at the ownership-safe budget — resolve adds no probing policy of its own.
 */
export async function runResolve(args: ResolveArgs, io: ResolveIo = {}): Promise<number> {
  const stdout = io.stdout ?? console;
  const stderr = io.stderr ?? console;
  const configDir = io.configDir ?? getConfigDir;
  const readDiagnostics = io.readDiagnostics ?? readConfigDiagnostics;
  const findLive = io.findLive ?? (() => findLiveProxy(START_OWNERSHIP_LIVENESS));
  const readRuntime = io.readRuntime ?? readRuntimePort;
  const probeEndpoint = io.probeEndpoint ?? probeEndpointLiveness;
  const cliVersion = io.cliVersion ?? packageVersion;
  const configHome = configDir();
  let diagnostics: ConfigDiagnostics;
  try {
    diagnostics = readDiagnostics();
  } catch (error) {
    // A resolution that could not run must not read as "no proxy": the caller has to
    // refuse to guess (D5) rather than treat this as a proven-absent verdict.
    stderr.error(`resolve failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (diagnostics.source === "fallback") {
    // An invalid config must not resolve to defaults: the effective port would be a
    // guess at 10100 while the operator's config.port is unread. The repair-to-defaults
    // policy in loadConfig is for interactive recovery, not for a shell contract.
    stderr.error(`resolve failed: the config in ${configHome} is invalid (${diagnostics.error ?? "unknown error"}); refusing to guess.`);
    return 1;
  }
  let live: LiveProxy | null;
  try {
    live = await findLive();
  } catch (error) {
    stderr.error(`resolve failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (!live) {
    // findLiveProxy collapses "definitely nothing" and "could not tell" into the same
    // null. The launch decision keys on this verdict, so resolve owes the caller the
    // tri-state answer the updater already enforces: only EVERY candidate definitively
    // dead is absence. Anything else is unknown, and unknown exits 1 — it must never
    // authorise starting a second runtime.
    let provenDown = false;
    try {
      provenDown = await everyEndpointProvenDownAsync(endpointsToProve(readRuntime(), diagnostics.config), probeEndpoint);
    } catch {
      // A probe that cannot run is not evidence of absence.
      provenDown = false;
    }
    if (!provenDown) {
      stderr.error("resolve: liveness is unknown (a probe timed out or a listener withheld /healthz); refusing to treat unknown as absent.");
      return 1;
    }
  }
  const json = buildResolveJson(diagnostics.config, live, configHome, cliVersion());
  if (args.json) stdout.log(JSON.stringify(json));
  else reportHuman(json, stdout);
  return 0;
}
