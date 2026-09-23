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
import {
  resolveServiceOwnership,
  resolveServiceState,
  type ServiceInstallState,
  type ServiceOwnershipResolution,
  type ServiceStateResolution,
} from "../service/state";
import {
  assessServiceTakeoverCompatibility,
  type ManagingCliObservation,
  type ManagingCliRole,
} from "../service/ownership-compatibility";
import { observeManagingClis } from "../service/managing-cli";
import { SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION } from "../service/install-state-contract.mjs";

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
  /**
   * The recorded runtime owner, in the CLI's own three answers. `unknown` is on the wire
   * deliberately: it never changes the exit code — the liveness verdict is still
   * trustworthy — and the embedding shell fails closed on it rather than asking consent
   * against a record it could not read.
   */
  ownership: ServiceOwnershipResolution;
  /**
   * Whether a desktop takeover can be offered, and the token that binds that approval to
   * the exact subject and managing-CLI observations a later `ocx service claim` must find
   * unchanged. `ownership-unknown` is produced only here: it is a wire reason, not a new
   * member of `ServiceTakeoverCompatibility`'s union.
   */
  takeover: ResolveTakeover;
}

export type ResolveTakeover =
  | { kind: "supported"; protocolVersion: number; minimumCliVersion: string; token: string }
  | { kind: "blocked"; reason: string; detail: string; minimumCliVersion: string };

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
  /** Recorded-ownership resolver; production default is resolveServiceOwnership. */
  resolveOwnership?: () => ServiceOwnershipResolution;
  /** Full install-state resolver; production default is resolveServiceState. */
  resolveState?: () => ServiceStateResolution;
  /** Managing-CLI observer; production default is observeManagingClis. */
  observeManagers?: (
    state: ServiceInstallState | null,
  ) => Readonly<Record<ManagingCliRole, ManagingCliObservation>>;
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
  ownership: ServiceOwnershipResolution,
  takeover: ResolveTakeover,
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
    ownership,
    takeover,
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
  const ownership = json.ownership;
  if (ownership.kind === "owned") {
    stdout.log(`Owner: ${ownership.ownership.owner} (install ${ownership.ownership.installId}, generation ${ownership.ownership.consentGeneration})`);
  } else if (ownership.kind === "unknown") {
    stdout.log(`Owner: unknown (${ownership.reason})`);
  } else {
    stdout.log("Owner: none recorded");
  }
  stdout.log(
    json.takeover.kind === "supported"
      ? "Takeover: supported"
      : `Takeover: blocked (${json.takeover.reason}: ${json.takeover.detail})`,
  );
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
  const resolveOwnership = io.resolveOwnership ?? resolveServiceOwnership;
  const resolveState = io.resolveState ?? resolveServiceState;
  const observeManagers = io.observeManagers ?? observeManagingClis;
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
  let ownership: ServiceOwnershipResolution;
  try {
    ownership = resolveOwnership();
  } catch (error) {
    ownership = { kind: "unknown", reason: error instanceof Error ? error.message : String(error) };
  }
  let takeover: ResolveTakeover;
  if (!live) {
    // A proven absence may authorize start, but there is no runtime to take over.
    // Avoid synchronous managing-CLI version probes on this launch path.
    takeover = {
      kind: "blocked",
      reason: "runtime-absent",
      detail: "no live runtime is available for takeover",
      minimumCliVersion: SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
    };
  } else if (ownership.kind === "unknown") {
    // The claim cannot be read, so nothing can be approved against it. This reason is a
    // wire answer, not a new member of the compatibility union.
    takeover = {
      kind: "blocked",
      reason: "ownership-unknown",
      detail: ownership.reason,
      minimumCliVersion: SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
    };
  } else {
    try {
      const resolved = resolveState();
      if (resolved.kind === "unknown") {
        takeover = {
          kind: "blocked",
          reason: "ownership-unknown",
          detail: resolved.reason,
          minimumCliVersion: SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
        };
      } else {
        const resolvedState = resolved.kind === "state" ? resolved.state : null;
        takeover = assessServiceTakeoverCompatibility({
          state: resolvedState,
          subject: ownership,
          managers: observeManagers(resolvedState),
        });
      }
    } catch (error) {
      takeover = {
        kind: "blocked",
        reason: "managing-cli-unknown",
        detail: error instanceof Error ? error.message : String(error),
        minimumCliVersion: SERVICE_OWNERSHIP_MINIMUM_CLI_VERSION,
      };
    }
  }
  const json = buildResolveJson(diagnostics.config, live, configHome, cliVersion(), ownership, takeover);
  if (args.json) stdout.log(JSON.stringify(json));
  else reportHuman(json, stdout);
  return 0;
}
