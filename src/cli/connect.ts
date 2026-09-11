import { existsSync, lstatSync, readFileSync } from "node:fs";
import { DEFAULT_CATALOG_PATH } from "../codex/paths";
import { codexSupportedReasoningEfforts } from "../codex/catalog/effort";
import { resolveCodexRuntime } from "../codex/runtime";
import {
  inspectClientCatalogReadiness,
  type CatalogCompatibilityDeps,
  type ClientCatalogFileState,
  type ClientCatalogReadiness,
} from "../client/catalog-compatibility";
import {
  disconnectClient,
  revokeConnectedClientKey,
  rotateConnectedClientKey,
  connectClient,
} from "../client/connect";
import { inspectClientRotationRecoveryGate, readClientConnectionState } from "../client/state";
import { readServiceApiTokenState } from "../lib/service-secrets";
import type { ClientLifecycleLockDeps } from "../client/lifecycle-lock";
import { inspectRemoteDesktopStore } from "../claude/desktop-remote-store";
import type { OcxConnectedClientId } from "../types";
import {
  CliUsageError,
  csv,
  printData,
  readSecretLine,
  rejectArgs,
  runCliAction,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

export interface ClientCommandDeps extends RuntimeApiDeps {
  lifecycleLockDeps?: ClientLifecycleLockDeps;
  catalogProbeDeps?: ClientCatalogProbeDeps;
}

export interface ClientCatalogProbeDeps extends CatalogCompatibilityDeps {
  /** Injected in tests; defaults to reading the materialized client catalog off disk. */
  readCatalogBody?: () => string | null;
}

export const CONNECT_USAGE = `Usage:
  ocx connect <url> [--management-url <url>]
      (--pairing-code-stdin | --admin-token-stdin)
      [--clients codex,claude] [--management-transport direct|relay]
      [--catalog-timeout <seconds>] [--no-sync]
  ocx connect status [--json]
  ocx connect rotate (--pairing-code-stdin | --admin-token-stdin)
      [--json]
  ocx connect revoke --admin-token-stdin [--json]`;

export const DISCONNECT_USAGE = `Usage:
  ocx disconnect [--keep-catalog] [--json]`;

export type ClientConnectionStatus = {
  state: "disconnected" | "connected" | "invalid" | "mismatched";
  reason?: string;
  serverUrl?: string;
  managementUrl?: string;
  managementTransport?: "direct" | "relay";
  protocolVersion?: number;
  apiKeyId?: string;
  selectedClients?: OcxConnectedClientId[];
  connectedAt?: string;
  catalogSyncedAt?: string;
  catalogAgeSeconds?: number;
  catalog: "present" | "missing" | "unsafe";
  token: "owned" | "missing" | "changed" | "unsafe";
  rotation: "clean" | "orphan-cleaned" | "recovery-required" | "unsafe";
  /**
   * Whether the selected local Codex CLI can actually launch against this connection (#4207).
   *
   * `state: "connected"` proves the hub answered and the credential works. It never proved the
   * local runtime could consume what was downloaded, which is how a connection kept reporting
   * itself healthy while `codex exec` exited on `unknown variant` before its first request.
   *
   * Reported only while connected, and reported as its own field rather than as a fourth
   * `catalog` value: the status JSON is documented additive-only, so widening an existing
   * field's value domain would change what `catalog: "present"` means for every consumer that
   * already reads it.
   */
  readiness?: ClientCatalogReadiness["kind"];
  /** Present whenever readiness is not `ready`; names the fault and the way out. */
  readinessReason?: string;
};

function readInstalledCatalogBody(): string | null {
  try {
    return readFileSync(DEFAULT_CATALOG_PATH, "utf8");
  } catch {
    return null;
  }
}

/**
 * The ladder the selected Codex CLI accepts, observed without persisting anything.
 *
 * `codexSupportedReasoningEfforts()` with no deps reaches `resolveAndPersistCodexRuntime`, which
 * writes codex-runtime.json. `ocx status` deliberately resolves without persisting, and a
 * read-only diagnostics command should not start writing runtime selection state because a
 * readiness check was added to it. Handing the already-resolved command in as the only candidate
 * skips that path and reuses the resolve cache `ocx status` has usually already filled.
 */
function observeLocalCodexEffortLadder(): ReadonlySet<string> | null {
  const command = resolveCodexRuntime().runtime.command;
  return codexSupportedReasoningEfforts({ commandCandidates: () => [command] });
}

/**
 * One observer per command, for the write-time gate and the readiness check alike. Built even
 * when nothing was injected, so production does not silently fall back to the default inside
 * {@link assertClientCatalogCompatible} — that default persists runtime selection state and
 * would run its own probe, which is how the two checks could disagree about the ladder within
 * a single `ocx connect`.
 */
function catalogObserver(deps: ClientCatalogProbeDeps | undefined): CatalogCompatibilityDeps {
  return { supportedEfforts: deps?.supportedEfforts ?? observeLocalCodexEffortLadder };
}

/** The stat half of the catalog verdict, shared by the status collector and `ocx connect`. */
function installedCatalogFileState(): ClientCatalogFileState {
  if (!existsSync(DEFAULT_CATALOG_PATH)) return "missing";
  try {
    const stat = lstatSync(DEFAULT_CATALOG_PATH);
    return !stat.isSymbolicLink() && stat.isFile() ? "present" : "unsafe";
  } catch {
    return "unsafe";
  }
}

/**
 * Observing the runtime spawns `codex debug models`, so this runs only for a connected client —
 * the one configuration that installs hub bytes the local clamp never touched. A standalone or
 * hub install pays nothing for it.
 *
 * Never throws. A status command that dies because a Codex probe failed would replace one wrong
 * answer with a worse one.
 */
function inspectInstalledCatalogReadiness(
  file: ClientCatalogFileState,
  deps: ClientCatalogProbeDeps,
): ClientCatalogReadiness {
  try {
    const read = deps.readCatalogBody ?? readInstalledCatalogBody;
    return inspectClientCatalogReadiness(file, file === "present" ? read() : null, catalogObserver(deps));
  } catch {
    return { kind: "unverified", reason: "the selected local Codex runtime could not be inspected" };
  }
}

export function collectClientConnectionStatus(
  now = Date.now(),
  lifecycleLockDeps?: ClientLifecycleLockDeps,
  catalogProbeDeps: ClientCatalogProbeDeps = {},
): ClientConnectionStatus {
  const state = readClientConnectionState();
  const tokenState = readServiceApiTokenState();
  const rotation = inspectClientRotationRecoveryGate(state, lifecycleLockDeps).kind;
  const catalog = installedCatalogFileState();
  if (state.kind !== "connected") {
    return {
      state: state.kind,
      ...(state.kind === "invalid" || state.kind === "mismatched" ? { reason: state.reason } : {}),
      catalog,
      token: tokenState.kind === "absent" ? "missing" : tokenState.kind === "unsafe" ? "unsafe" : "changed",
      rotation,
    };
  }
  const catalogAgeSeconds = state.value.catalogSyncedAt
    ? Math.max(0, Math.floor((now - Date.parse(state.value.catalogSyncedAt)) / 1000))
    : undefined;
  const token = tokenState.kind === "absent"
    ? "missing"
    : tokenState.kind === "unsafe"
      ? "unsafe"
      : tokenState.fingerprint === state.value.tokenFingerprint ? "owned" : "changed";
  const readiness = inspectInstalledCatalogReadiness(catalog, catalogProbeDeps);
  return {
    state: "connected",
    serverUrl: state.value.serverUrl,
    managementUrl: state.value.managementUrl,
    managementTransport: state.value.managementTransport,
    protocolVersion: state.value.protocolVersion,
    apiKeyId: state.value.apiKeyId,
    selectedClients: [...state.value.selectedClients],
    connectedAt: state.value.connectedAt,
    ...(state.value.catalogSyncedAt ? { catalogSyncedAt: state.value.catalogSyncedAt } : {}),
    ...(catalogAgeSeconds !== undefined ? { catalogAgeSeconds } : {}),
    catalog,
    token,
    rotation,
    readiness: readiness.kind,
    ...(readiness.kind === "ready" ? {} : { readinessReason: readiness.reason }),
  };
}

function parseClients(raw: string | undefined): OcxConnectedClientId[] {
  const values = csv(raw) ?? ["codex", "claude"];
  if (values.length < 1 || values.some(value => value !== "codex" && value !== "claude")) {
    throw new CliUsageError("--clients must contain codex and/or claude", CONNECT_USAGE);
  }
  return values as OcxConnectedClientId[];
}

/** Reads as a verdict, not a field dump: "ready" is the only word that means the client works. */
function readinessLine(status: ClientConnectionStatus): string {
  const label = status.readiness === "ready"
    ? "ready"
    : status.readiness === "incompatible"
      ? "not ready"
      : "unverified";
  return `Local Codex CLI: ${label}${status.readinessReason ? ` (${status.readinessReason})` : ""}`;
}

export type ConnectCompletionReport = {
  readonly lines: readonly string[];
  /** Non-null when `ocx connect` must exit non-zero rather than report success. */
  readonly failure: string | null;
};

/**
 * What `ocx connect` says once the hub and the credential are settled, and whether the command
 * still fails (#4207).
 *
 * Pure so the fail-closed decision can be exercised without a hub. Two rules it encodes:
 *
 * On a proven incompatibility the verdict is printed FIRST and the `Connected to …` line is
 * withheld, because a caller grepping for that phrase would otherwise read a catalog the local
 * CLI cannot parse as a success. The connection really was saved, so the replacement line says
 * where to see it.
 *
 * And that failure applies only when this connection selected Codex. A Claude-only connection
 * never launches the Codex CLI, so an old binary somewhere on PATH is not a reason to fail the
 * operator's Claude Desktop setup — it is still worth saying, which is why the line survives
 * without the exit code.
 */
export function connectCompletionReport(
  connection: { serverUrl: string; apiKeyId: string },
  selectedClients: readonly OcxConnectedClientId[],
  readiness: ClientCatalogReadiness,
): ConnectCompletionReport {
  const connected = `Connected to ${connection.serverUrl} as key ${connection.apiKeyId}.`;
  if (readiness.kind === "ready") {
    return { lines: [connected, "Local Codex CLI: ready (it accepts every reasoning level in the installed catalog)."], failure: null };
  }
  if (readiness.kind === "unverified") {
    // Not a failure. A client with no observable Codex CLI is a working configuration, and the
    // write-time gate deliberately lets it through; saying so is the honest middle report.
    return { lines: [connected, `Local Codex CLI: unverified (${readiness.reason}).`], failure: null };
  }
  const verdict = `Local Codex CLI: not ready (${readiness.reason})`;
  if (!selectedClients.includes("codex")) {
    return {
      lines: [connected, `${verdict} This connection selected ${selectedClients.join(", ")}, so nothing here launches Codex.`],
      failure: null,
    };
  }
  return {
    lines: [verdict, `The connection to ${connection.serverUrl} as key ${connection.apiKeyId} was saved; run 'ocx connect status' to see it.`],
    failure: `client_not_ready: ${readiness.reason}`,
  };
}

function statusLines(status: ClientConnectionStatus): string[] {
  if (status.state !== "connected") {
    return [`Connection: ${status.state}${status.reason ? ` (${status.reason})` : ""}`];
  }
  return [
    "Connection: connected",
    // Second line on purpose. The whole of #4207 is that a reader stopped at "connected" and
    // believed the client was usable, so the local verdict has to arrive before the hub detail.
    readinessLine(status),
    `Hub: ${status.serverUrl}`,
    `Management: ${status.managementUrl} (${status.managementTransport})`,
    `Protocol: ${status.protocolVersion}`,
    `API key id: ${status.apiKeyId}`,
    `Clients: ${status.selectedClients?.join(", ")}`,
    `Token file: ${status.token}`,
    `Key rotation: ${status.rotation}`,
    `Catalog: ${status.catalog}${status.catalogAgeSeconds !== undefined ? ` (${status.catalogAgeSeconds}s old)` : ""}`,
  ];
}

async function runRotate(argv: string[], deps: ClientCommandDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const pairing = takeFlag(args, "--pairing-code-stdin");
  const admin = takeFlag(args, "--admin-token-stdin");
  if (Number(pairing) + Number(admin) !== 1) {
    throw new CliUsageError("choose exactly one of --pairing-code-stdin or --admin-token-stdin", CONNECT_USAGE);
  }
  rejectArgs(args, CONNECT_USAGE, { redactValues: true });
  const value = new TextEncoder().encode(await readSecretLine(deps, pairing ? "pairing code" : "admin token"));
  const connection = await rotateConnectedClientKey({
    credential: { kind: pairing ? "pairing-grant" : "admin", value },
  }, { fetchImpl: deps.fetchImpl, lifecycleLockDeps: deps.lifecycleLockDeps });
  const restartRequired = inspectRemoteDesktopStore({ serverUrl: connection.serverUrl, apiKeyId: connection.apiKeyId, connectedAt: connection.connectedAt }).kind !== "absent";
  printData({ apiKeyId: connection.apiKeyId, rotation: connection.rotationOutcome, restartRequired }, wantsJson, [
    connection.rotationOutcome === "committed"
      ? `Rotated connected API key ${connection.apiKeyId}; the previous key is no longer admitted.`
      : `Rotation rolled back for API key ${connection.apiKeyId}; the previous key was retained or restored.`,
    ...(restartRequired ? ["Fully quit and reopen Claude Desktop; a running app may still hold the previous credential."] : []),
  ]);
}

async function runConnect(argv: string[], deps: ClientCommandDeps): Promise<void> {
  const args = [...argv];
  const serverUrl = args.shift();
  if (!serverUrl || serverUrl.startsWith("--")) throw new CliUsageError("hub URL is required", CONNECT_USAGE);
  const managementUrl = takeOption(args, "--management-url");
  const clients = parseClients(takeOption(args, "--clients"));
  const catalogTimeoutSeconds = takeIntegerOption(args, "--catalog-timeout", { min: 1 });
  if (catalogTimeoutSeconds !== undefined && catalogTimeoutSeconds > 120) {
    throw new CliUsageError("--catalog-timeout must be an integer between 1 and 120", CONNECT_USAGE);
  }
  const managementTransport = takeOption(args, "--management-transport") ?? "direct";
  if (managementTransport !== "direct" && managementTransport !== "relay") {
    throw new CliUsageError("--management-transport must be direct or relay", CONNECT_USAGE);
  }
  const pairing = takeFlag(args, "--pairing-code-stdin");
  const admin = takeFlag(args, "--admin-token-stdin");
  const noSync = takeFlag(args, "--no-sync");
  if (Number(pairing) + Number(admin) !== 1) {
    throw new CliUsageError("choose exactly one of --pairing-code-stdin or --admin-token-stdin", CONNECT_USAGE);
  }
  rejectArgs(args, CONNECT_USAGE, { redactValues: true });
  const secret = await readSecretLine(deps, pairing ? "pairing code" : "admin token");
  const value = new TextEncoder().encode(secret);
  const connection = await connectClient({
    serverUrl,
    ...(managementUrl ? { managementUrl } : {}),
    credential: { kind: pairing ? "pairing-grant" : "admin", value },
    selectedClients: clients,
    managementTransport,
    noSync,
    ...(catalogTimeoutSeconds === undefined ? {} : { catalogTimeoutMs: catalogTimeoutSeconds * 1_000 }),
  }, {
    fetchImpl: deps.fetchImpl,
    lifecycleLockDeps: deps.lifecycleLockDeps,
    // Same observer the readiness check below uses. Passed unconditionally: leaving it out in
    // production would let the gate fall back to its own probing, persisting default, so one
    // command could run two probes and act on two different ladders.
    catalogCompatibility: catalogObserver(deps.catalogProbeDeps),
  });
  // The hub and the credential are proven at this point; the local runtime is not. Reporting
  // only the first half is what #4207 was filed for, so the catalog now on disk is checked
  // against the Codex CLI that will read it.
  const readiness = inspectInstalledCatalogReadiness(installedCatalogFileState(), deps.catalogProbeDeps ?? {});
  const report = connectCompletionReport(connection, clients, readiness);
  for (const line of report.lines) console.log(line);
  if (report.failure) throw new Error(report.failure);
}

async function runRevoke(argv: string[], deps: ClientCommandDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const admin = takeFlag(args, "--admin-token-stdin");
  if (!admin) throw new CliUsageError("revoke requires --admin-token-stdin", CONNECT_USAGE);
  rejectArgs(args, CONNECT_USAGE, { redactValues: true });
  const value = new TextEncoder().encode(await readSecretLine(deps, "admin token"));
  const result = await revokeConnectedClientKey({ kind: "admin", value }, { fetchImpl: deps.fetchImpl, lifecycleLockDeps: deps.lifecycleLockDeps });
  printData(result, wantsJson, [`Revoked connected API key ${result.apiKeyId}. Disconnect this client next.`]);
}

export async function handleConnectCommand(argv: string[], deps: ClientCommandDeps = {}): Promise<number> {
  return runCliAction(async () => {
    if (argv[0] === "status") {
      const args = argv.slice(1);
      const wantsJson = takeFlag(args, "--json");
      rejectArgs(args, CONNECT_USAGE, { redactValues: true });
      const status = collectClientConnectionStatus(Date.now(), deps.lifecycleLockDeps, deps.catalogProbeDeps ?? {});
      printData(status, wantsJson, statusLines(status));
      return;
    }
    if (argv[0] === "revoke") {
      await runRevoke(argv.slice(1), deps);
      return;
    }
    if (argv[0] === "rotate") {
      await runRotate(argv.slice(1), deps);
      return;
    }
    await runConnect(argv, deps);
  });
}

export async function handleDisconnectCommand(argv: string[], deps: Pick<ClientCommandDeps, "lifecycleLockDeps"> = {}): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const keepCatalog = takeFlag(args, "--keep-catalog");
    const wantsJson = takeFlag(args, "--json");
    rejectArgs(args, DISCONNECT_USAGE, { redactValues: true });
    const result = await disconnectClient({ keepCatalog }, deps);
    const payload = {
      ...result,
      revoke: {
        apiKeyId: result.apiKeyId,
        location: "Integrations → API Keys",
      },
    };
    printData(payload, wantsJson, [
      "Disconnected locally; native Codex state was restored.",
      ...(result.desktopRestoration === "standard_fallback"
        ? ["Previous Desktop settings were not recorded; the managed profile was switched to standard mode."] : []),
      ...(result.restartRequired ? ["Fully quit and reopen Claude Desktop; local cleanup cannot revoke an in-memory credential."] : []),
      `The hub key ${result.apiKeyId} is still valid. Revoke it from Integrations → API Keys.`,
    ]);
  });
}
