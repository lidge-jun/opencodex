/**
 * `ocx system-surface` — the remaining routes that had no CLI caller at all (wp7).
 *
 * These are grouped by what an operator is trying to do, not by which server module owns them:
 * inspecting effective configuration, reading the generated client-config snippet, toggling the
 * native client integrations, checking request pacing and routing analytics, and reading the
 * Codex system prompt.
 *
 * One route here is deliberately READ-ONLY forever. `POST /api/github/star` spends the operator's
 * GitHub identity, and no CLI flag can carry that consent — the server requires a real dashboard
 * session for it. So `star` reads status and says what it cannot do, rather than offering a
 * `--yes` that would be a lie.
 */
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx inspect config [--json]
  ocx inspect catalog [--json]
  ocx inspect routing-analytics [--json]
  ocx inspect pacing [--name <provider>] [--json]
  ocx inspect key-providers [--json]
  ocx inspect codex-prompt [--text] [--json]
  ocx inspect client-config --client <id> [--json]
  ocx inspect star [--json]
  ocx inspect windows-tray [--json]
  ocx integration native [list] [--json]
  ocx integration native <claude|claude-desktop|codex|grok> <on|off> [--json]
  ocx integration native cursor [status|local-installer] [--json]
  ocx agent request-user-input [on|off] [--json]`;

/** A read that takes no arguments beyond `--json`. */
async function read(path: string, argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest(path, {}, deps);
  printData(result, wantsJson, summaryLines(result));
}

const NATIVE_CLIENTS = ["claude", "claude-desktop", "codex", "grok"] as const;

interface NativeClientRow {
  clientId?: string;
  state?: string;
  installed?: boolean;
  desiredEnabled?: boolean;
  configPath?: string;
  disableBlocked?: unknown;
}

/**
 * The shared depth-1 flattener renders an array as "N item(s)", so a bare
 * `integration native list` printed `clients: 4 item(s)` -- the per-client state the operator
 * asked for was in the payload and discarded before the terminal. Same defect class wp4 fixed
 * for the account and key tables.
 */
function nativeLines(payload: unknown): string[] {
  const clients = (payload as { clients?: NativeClientRow[] } | null)?.clients;
  if (!Array.isArray(clients) || clients.length === 0) return ["No native client integrations reported."];
  const lines = ["CLIENT           STATE      INSTALLED  DESIRED  CONFIG"];
  for (const row of clients) {
    lines.push([
      (row.clientId ?? "?").padEnd(16),
      (row.state ?? "?").padEnd(10),
      (row.installed === true ? "yes" : row.installed === false ? "no" : "?").padEnd(10),
      (row.desiredEnabled === true ? "on" : row.desiredEnabled === false ? "off" : "?").padEnd(8),
      row.configPath ?? "",
    ].join(" ").trimEnd());
    // A blocked disable is the reason a toggle did not take effect, so it is never silent.
    if (row.disableBlocked !== null && row.disableBlocked !== undefined) {
      lines.push(`  disable blocked: ${typeof row.disableBlocked === "string" ? row.disableBlocked : JSON.stringify(row.disableBlocked)}`);
    }
  }
  return lines;
}

async function nativeIntegration(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const action = argv[0] && !argv[0].startsWith("-") ? argv[0] : "list";
  const rest = argv[0] && !argv[0].startsWith("-") ? argv.slice(1) : argv;

  if (action === "list") {
    const args = [...rest];
    const wantsJson = takeFlag(args, "--json");
    rejectArgs(args, USAGE);
    const result = await runtimeRequest("/api/native-integrations", {}, deps);
    printData(result, wantsJson, nativeLines(result));
    return;
  }

  if (!(NATIVE_CLIENTS as readonly string[]).includes(action)) {
    throw new CliUsageError(`unknown native client ${action}; expected one of ${NATIVE_CLIENTS.join(", ")}`, USAGE);
  }

  const args = [...rest];
  const wantsJson = takeFlag(args, "--json");
  const state = args.shift();
  rejectArgs(args, USAGE);
  if (state !== "on" && state !== "off") {
    throw new CliUsageError(`expected on or off after ${action}`, USAGE);
  }

  // Toggling rewrites the client's own config file, which is why each client has its own route
  // rather than one route with a client parameter.
  const result = await runtimeRequest(`/api/native-integrations/${action}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: state === "on" }),
  }, deps);
  printData(result, wantsJson, summaryLines(result));
}

/**
 * Exported unwrapped so `ocx agent request-user-input` can call it INSIDE its own
 * `runCliAction`. Wrapping an already-wrapped handler reports one failure twice: the inner
 * wrapper prints the error and returns a code, and the outer one prints again on the rethrow.
 */
export async function requestUserInputAction(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const state = args.shift();
  rejectArgs(args, USAGE);

  const path = "/api/codex-auth/features/default-mode-request-user-input";
  // No argument means show. A read must not write the value it is reporting.
  if (state === undefined) {
    const result = await runtimeRequest(path, {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  if (state !== "on" && state !== "off") throw new CliUsageError("expected on or off", USAGE);

  const result = await runtimeRequest(path, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: state === "on" }),
  }, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function clientConfig(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const client = takeOption(args, "--client");
  rejectArgs(args, USAGE);
  if (!client) throw new CliUsageError("--client is required", USAGE);
  // The valid client list is not duplicated here: the route answers 400 naming every accepted id,
  // which is more useful than a local list that can drift out of date.
  const result = await runtimeRequest(`/api/client-config?client=${encodeURIComponent(client)}`, {}, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function pacing(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const name = takeOption(args, "--name");
  rejectArgs(args, USAGE);
  const suffix = name ? `?name=${encodeURIComponent(name)}` : "";
  const result = await runtimeRequest(`/api/provider-request-pacing${suffix}`, {}, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function codexPrompt(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const asText = takeFlag(args, "--text");
  rejectArgs(args, USAGE);
  if (asText && wantsJson) throw new CliUsageError("--text and --json cannot be combined", USAGE);
  if (asText) {
    // The /text variant answers the prompt body itself, so it is printed verbatim rather than
    // flattened through the summary renderer.
    const result = await runtimeRequest<unknown>("/api/codex-prompt/text", {}, deps);
    console.log(typeof result === "string" ? result : JSON.stringify(result, null, 2));
    return;
  }
  const result = await runtimeRequest("/api/codex-prompt", {}, deps);
  printData(result, wantsJson, summaryLines(result));
}

async function star(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const result = await runtimeRequest<Record<string, unknown>>("/api/github/star", {}, deps);
  if (wantsJson) {
    printData(result, true);
    return;
  }
  printData(result, false, summaryLines(result));
  // Said plainly, because the natural next question is "then star it", and the answer is that no
  // CLI invocation can: the POST requires a dashboard session precisely so an agent cannot spend
  // the operator's identity on their behalf.
  console.log("Starring is not available from the CLI: it uses your GitHub identity, so only you can do it from the dashboard.");
}

export async function handleInspectCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const hasSub = argv[0] !== undefined && !argv[0].startsWith("-");
    const sub = hasSub ? argv[0]! : "config";
    const rest = hasSub ? argv.slice(1) : argv;
    if (sub === "config") await read("/api/config", rest, deps);
    else if (sub === "catalog") await read("/api/catalog", rest, deps);
    else if (sub === "routing-analytics") await read("/api/routing-analytics", rest, deps);
    else if (sub === "key-providers") await read("/api/key-providers", rest, deps);
    else if (sub === "windows-tray") await read("/api/windows-tray", rest, deps);
    else if (sub === "pacing") await pacing(rest, deps);
    else if (sub === "client-config") await clientConfig(rest, deps);
    else if (sub === "codex-prompt") await codexPrompt(rest, deps);
    else if (sub === "star") await star(rest, deps);
    else throw new CliUsageError(`unknown inspect command ${sub}`, USAGE);
  });
}

export async function handleIntegrationCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  if (argv[0] === "native" && argv[1] === "cursor") {
    const { handleCursorIntegrationCommand } = await import("./integration-cursor");
    return handleCursorIntegrationCommand(argv.slice(2), deps);
  }
  return runCliAction(async () => {
    const [sub, ...rest] = argv;
    if (sub === "native" || sub === undefined) await nativeIntegration(sub === undefined ? [] : rest, deps);
    else throw new CliUsageError(`unknown integration command ${sub}`, USAGE);
  });
}

export const INSPECT_USAGE = USAGE;
