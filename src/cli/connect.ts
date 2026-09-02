import { existsSync, lstatSync } from "node:fs";
import { DEFAULT_CATALOG_PATH } from "../codex/paths";
import {
  disconnectClient,
  revokeConnectedClientKey,
  rotateConnectedClientKey,
  connectClient,
} from "../client/connect";
import { inspectClientRotationRecoveryGate, readClientConnectionState } from "../client/state";
import { readServiceApiTokenState } from "../lib/service-secrets";
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
};

export function collectClientConnectionStatus(now = Date.now()): ClientConnectionStatus {
  const state = readClientConnectionState();
  const tokenState = readServiceApiTokenState();
  const rotation = inspectClientRotationRecoveryGate(state).kind;
  let catalog: ClientConnectionStatus["catalog"] = "missing";
  if (existsSync(DEFAULT_CATALOG_PATH)) {
    try {
      const stat = lstatSync(DEFAULT_CATALOG_PATH);
      catalog = !stat.isSymbolicLink() && stat.isFile() ? "present" : "unsafe";
    } catch {
      catalog = "unsafe";
    }
  }
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
  };
}

function parseClients(raw: string | undefined): OcxConnectedClientId[] {
  const values = csv(raw) ?? ["codex", "claude"];
  if (values.length < 1 || values.some(value => value !== "codex" && value !== "claude")) {
    throw new CliUsageError("--clients must contain codex and/or claude", CONNECT_USAGE);
  }
  return values as OcxConnectedClientId[];
}

function statusLines(status: ClientConnectionStatus): string[] {
  if (status.state !== "connected") {
    return [`Connection: ${status.state}${status.reason ? ` (${status.reason})` : ""}`];
  }
  return [
    "Connection: connected",
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

async function runRotate(argv: string[], deps: RuntimeApiDeps): Promise<void> {
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
  }, { fetchImpl: deps.fetchImpl });
  printData({ apiKeyId: connection.apiKeyId, rotation: "committed" }, wantsJson, [
    `Rotated connected API key ${connection.apiKeyId}; the previous key is no longer admitted.`,
  ]);
}

async function runConnect(argv: string[], deps: RuntimeApiDeps): Promise<void> {
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
  }, { fetchImpl: deps.fetchImpl });
  console.log(`Connected to ${connection.serverUrl} as key ${connection.apiKeyId}.`);
}

async function runRevoke(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const admin = takeFlag(args, "--admin-token-stdin");
  if (!admin) throw new CliUsageError("revoke requires --admin-token-stdin", CONNECT_USAGE);
  rejectArgs(args, CONNECT_USAGE, { redactValues: true });
  const value = new TextEncoder().encode(await readSecretLine(deps, "admin token"));
  const result = await revokeConnectedClientKey({ kind: "admin", value }, { fetchImpl: deps.fetchImpl });
  printData(result, wantsJson, [`Revoked connected API key ${result.apiKeyId}. Disconnect this client next.`]);
}

export async function handleConnectCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    if (argv[0] === "status") {
      const args = argv.slice(1);
      const wantsJson = takeFlag(args, "--json");
      rejectArgs(args, CONNECT_USAGE, { redactValues: true });
      const status = collectClientConnectionStatus();
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

export async function handleDisconnectCommand(argv: string[]): Promise<number> {
  return runCliAction(async () => {
    const args = [...argv];
    const keepCatalog = takeFlag(args, "--keep-catalog");
    const wantsJson = takeFlag(args, "--json");
    rejectArgs(args, DISCONNECT_USAGE, { redactValues: true });
    const result = await disconnectClient({ keepCatalog });
    const payload = {
      ...result,
      revoke: {
        apiKeyId: result.apiKeyId,
        location: "Integrations → API Keys",
      },
    };
    printData(payload, wantsJson, [
      "Disconnected locally; native Codex state was restored.",
      `The hub key ${result.apiKeyId} is still valid. Revoke it from Integrations → API Keys.`,
    ]);
  });
}
