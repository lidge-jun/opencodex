import { ADVISOR_CONTEXT_SHARING_CONSENT_VERSION, ADVISOR_CONTEXT_SHARING_DISCLOSURE } from "../advisor/disclosure";
import { ADVISOR_MCP_CLIENT_IDS, isAdvisorMcpClientId } from "../advisor/settings";
import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeIntegerOption,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx advisor status [--json]
  ocx advisor activity [--json]
  ocx advisor consult [--question <text>] [--context <text>] [--worker-model <model>] [--task-id <id>] [--consultation-id <id>] [--wait-ms <ms>] [--json]
  ocx advisor mcp
  ocx advisor on [--ack-context-sharing] [--json]
  ocx advisor off [--json]
  ocx advisor consent [--revoke] [--json]
  ocx advisor set [--model <model>] [--effort <effort>] [--policy <manual|preflight|adaptive>] [--context-mode <context|full|question-only>] [--max-consultations <1-3>] [--timeout-ms <ms>] [--auto-mount-mcp <on|off>] [--mcp-clients <list|auto|none>] [--json]`;

const VALUED_FLAGS = new Set([
  "--model",
  "--effort",
  "--policy",
  "--context-mode",
  "--timeout-ms",
  "--max-consultations",
  "--auto-mount-mcp",
  "--mcp-clients",
]);

interface SetOptions {
  model?: string;
  effort?: string;
  policy?: string;
  contextMode?: string;
  timeoutMs?: string;
  maxConsultations?: string;
  autoMountMcp?: string;
  mcpClients?: string;
}

function parseSetArgs(args: string[]): SetOptions {
  const options: SetOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!VALUED_FLAGS.has(arg)) throw new CliUsageError(`unknown advisor set option ${arg}`, USAGE);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) throw new CliUsageError(`${arg} requires a value`, USAGE);
    // An explicitly supplied empty value is meaningful for --model alone: the settings route
    // treats "" as the supported "clear the model" state. Every other valued flag still needs one.
    if (value === "" && arg !== "--model") throw new CliUsageError(`${arg} requires a value`, USAGE);
    if (arg === "--model") options.model = value;
    else if (arg === "--effort") options.effort = value;
    else if (arg === "--policy") options.policy = value;
    else if (arg === "--context-mode") options.contextMode = value;
    else if (arg === "--max-consultations") options.maxConsultations = value;
    else if (arg === "--auto-mount-mcp") options.autoMountMcp = value;
    else if (arg === "--mcp-clients") options.mcpClients = value;
    else options.timeoutMs = value;
  }
  if (Object.keys(options).length === 0) {
    throw new CliUsageError("advisor set requires a model, effort, policy, context mode, task limit, MCP mode, or timeout option", USAGE);
  }
  return options;
}

function summarizeMcpTrustLines(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const clients = (payload as { mcpClients?: unknown }).mcpClients;
  if (!Array.isArray(clients)) return [];
  const mounted = clients.filter((item): item is Record<string, unknown> =>
    !!item && typeof item === "object" && (item as { mounted?: unknown }).mounted === true);
  if (mounted.length === 0) return [];
  const lines = ["Mounted MCP clients:"];
  for (const item of mounted) {
    const label = String(item.label ?? item.clientId ?? "");
    const configPath = String(item.configPath ?? "");
    const trustStatus = String(item.trustStatus ?? "unknown");
    const trustNote = typeof item.trustNoteEn === "string" ? item.trustNoteEn : "";
    lines.push(`- ${label} (${trustStatus}): ${configPath}${trustNote && trustStatus !== "trusted" && trustStatus !== "auto_enabled" ? ` — ${trustNote}` : ""}`);
  }
  return lines;
}

async function status(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  printData(await runtimeRequest("/api/advisor/settings", {}, deps), wantsJson);
}

function printDisclosure(): void {
  console.error(ADVISOR_CONTEXT_SHARING_DISCLOSURE);
}

async function readConsent(deps: RuntimeApiDeps): Promise<unknown> {
  const current = await runtimeRequest("/api/advisor/settings", {}, deps) as {
    settings?: { contextSharingConsent?: unknown };
  };
  return current.settings?.contextSharingConsent;
}

async function setEnabled(enabled: boolean, argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const acknowledge = takeFlag(args, "--ack-context-sharing");
  rejectArgs(args, USAGE);
  if (!enabled) {
    if (acknowledge) {
      throw new CliUsageError(
        "--ack-context-sharing has no effect with `ocx advisor off`; it never records consent.",
        USAGE,
      );
    }
    printData(await runtimeRequest("/api/advisor/settings", {
      method: "PUT",
      body: JSON.stringify({ enabled: false }),
    }, deps), wantsJson, ["Advisor disabled."]);
    return;
  }
  const consent = await readConsent(deps);
  if (acknowledge) {
    printDisclosure();
    const res = await runtimeRequest("/api/advisor/settings", {
      method: "PUT",
      body: JSON.stringify({
        enabled: true,
        contextSharingConsent: ADVISOR_CONTEXT_SHARING_CONSENT_VERSION,
      }),
    }, deps);
    printData(res, wantsJson, ["Advisor enabled with context-sharing consent v1.", ...summarizeMcpTrustLines(res)]);
    return;
  }
  if (consent !== ADVISOR_CONTEXT_SHARING_CONSENT_VERSION) {
    printDisclosure();
    throw new CliUsageError(
      "Advisor context-sharing consent is required before consultations can send task content. "
      + "Re-run `ocx advisor on --ack-context-sharing` after reading the disclosure, or run `ocx advisor consent`.",
      USAGE,
    );
  }
  const res = await runtimeRequest("/api/advisor/settings", {
    method: "PUT",
    body: JSON.stringify({ enabled: true }),
  }, deps);
  printData(res, wantsJson, ["Advisor enabled.", ...summarizeMcpTrustLines(res)]);
}

async function consent(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const revoke = takeFlag(args, "--revoke");
  rejectArgs(args, USAGE);
  if (!revoke) printDisclosure();
  printData(await runtimeRequest("/api/advisor/settings", {
    method: "PUT",
    body: JSON.stringify({
      contextSharingConsent: revoke ? null : ADVISOR_CONTEXT_SHARING_CONSENT_VERSION,
    }),
  }, deps), wantsJson, [revoke
    ? "Advisor context-sharing consent removed. Consultations not yet dispatched will not send task content; a dispatched consultation cannot be cancelled and task content already sent cannot be retracted."
    : "Advisor context-sharing consent v1 recorded.",
  ]);
}

async function set(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const options = parseSetArgs(args);
  const patch: Record<string, unknown> = {};
  if (options.model !== undefined) patch.model = options.model;
  if (options.effort !== undefined) patch.effort = options.effort;
  if (options.policy !== undefined) patch.policy = options.policy;
  if (options.contextMode !== undefined) patch.contextMode = options.contextMode;
  if (options.maxConsultations !== undefined) {
    const limit = Number(options.maxConsultations);
    if (!Number.isInteger(limit) || limit < 1 || limit > 3) throw new CliUsageError("--max-consultations must be an integer between 1 and 3", USAGE);
    patch.maxConsultationsPerTask = limit;
  }
  if (options.timeoutMs !== undefined) {
    const parsed = Number(options.timeoutMs);
    if (!Number.isFinite(parsed)) throw new CliUsageError("--timeout-ms must be a number", USAGE);
    patch.timeoutMs = parsed;
  }
  if (options.autoMountMcp !== undefined) {
    if (options.autoMountMcp !== "on" && options.autoMountMcp !== "off") {
      throw new CliUsageError("--auto-mount-mcp must be on or off", USAGE);
    }
    patch.autoMountMcp = options.autoMountMcp === "on";
  }
  if (options.mcpClients !== undefined) {
    if (options.mcpClients === "auto") {
      patch.mcpClients = null;
    } else if (options.mcpClients === "none") {
      patch.mcpClients = [];
    } else {
      const ids = options.mcpClients.split(",").map(s => s.trim()).filter(Boolean);
      const invalid = ids.find(id => !isAdvisorMcpClientId(id));
      if (invalid) {
        throw new CliUsageError(`unknown MCP client "${invalid}" (supported: ${ADVISOR_MCP_CLIENT_IDS.join(", ")})`, USAGE);
      }
      patch.mcpClients = ids;
    }
  }
  const res = await runtimeRequest("/api/advisor/settings", {
    method: "PUT",
    body: JSON.stringify(patch),
  }, deps);
  printData(res, wantsJson, ["Advisor settings saved.", ...summarizeMcpTrustLines(res)]);
}

const MAX_CLI_POLL_ATTEMPTS = 20;

async function consult(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const consultationId = takeOption(args, "--consultation-id");
  const question = takeOption(args, "--question");
  const context = takeOption(args, "--context");
  const workerModel = takeOption(args, "--worker-model");
  const taskId = takeOption(args, "--task-id");
  const waitMs = takeIntegerOption(args, "--wait-ms", { min: 0, max: 300_000 });
  rejectArgs(args, USAGE);

  if (!consultationId?.trim() && !question?.trim()) {
    throw new CliUsageError("advisor consult requires --question or --consultation-id", USAGE);
  }

  const requestConsult = (body: Record<string, unknown>) =>
    runtimeRequest<Record<string, unknown>>(
      "/api/advisor/consult",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      deps,
    );

  let result = await requestConsult(
    consultationId?.trim()
      ? { consultationId: consultationId.trim(), ...(waitMs !== undefined ? { waitMs } : {}) }
      : {
          question: question!.trim(),
          ...(context !== undefined ? { context } : {}),
          ...(workerModel !== undefined ? { workerModel } : {}),
          ...(taskId !== undefined ? { taskId } : {}),
          ...(waitMs !== undefined ? { waitMs } : {}),
        },
  );

  // When a caller runs `ocx advisor consult --question ...` without an explicit --wait-ms or
  // --consultation-id, continue polling 202 in_progress responses so the CLI returns final advice.
  if (waitMs === undefined && !consultationId?.trim()) {
    for (let attempt = 0; attempt < MAX_CLI_POLL_ATTEMPTS && result.status === "in_progress" && typeof result.consultationId === "string"; attempt += 1) {
      result = await requestConsult({ consultationId: result.consultationId });
    }
  }

  const lines = result.status === "in_progress"
    ? [`Consultation in progress (${String(result.consultationId)}). Re-run with --consultation-id ${String(result.consultationId)}.`]
    : typeof result.advice === "string" && result.advice.length > 0
      ? [`[advisor (${String(result.advisorModel ?? "advisor")})]`, "", result.advice]
      : [typeof result.content === "string" ? result.content : "Consultation finished."];
  printData(result, wantsJson, lines);
}

async function mcp(argv: string[]): Promise<void> {
  const args = [...argv];
  rejectArgs(args, USAGE);
  const { serveAdvisorMcp } = await import("../advisor/mcp-server");
  await serveAdvisorMcp();
}

export async function handleAdvisorCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "status", ...rest] = argv;
    if (sub === "status") await status(rest, deps);
    else if (sub === "activity") {
      const args = [...rest];
      const wantsJson = takeFlag(args, "--json");
      rejectArgs(args, USAGE);
      printData(await runtimeRequest("/api/advisor/activity", {}, deps), wantsJson);
    }
    else if (sub === "consult") await consult(rest, deps);
    else if (sub === "mcp") await mcp(rest);
    else if (sub === "on") await setEnabled(true, rest, deps);
    else if (sub === "off") await setEnabled(false, rest, deps);
    else if (sub === "consent") await consent(rest, deps);
    else if (sub === "set") await set(rest, deps);
    else throw new CliUsageError(`unknown advisor command ${sub}`, USAGE);
  });
}

export const ADVISOR_USAGE = USAGE;
