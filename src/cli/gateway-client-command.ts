/**
 * `ocx connect|disconnect antigravity|agy` and `ocx connect antigravity|agy status`.
 *
 * Points Google's Antigravity desktop app and `agy` CLI at this proxy. The running proxy owns the
 * work (`/api/gateway-clients`); when none is running the same connectors run in this process, so
 * a first-time setup does not need `ocx start` first.
 */
import { loadConfig } from "../config";
import {
  connectGatewayClient, disconnectGatewayClient, gatewayActionBody, gatewayClientsStatus, isGatewayClientId,
  productionGatewayClientContext, resolveGatewayTarget, type GatewayClientContext, type GatewayClientId, type GatewayClientStatus, type GatewayNote,
} from "../integrations/gateway-clients";
import { CliUsageError, RuntimeApiError, printData, rejectArgs, runCliAction, runtimeRequest, takeJsonFlag, takeOption, terminalSafeText, type RuntimeApiDeps } from "./runtime-api";

type GatewayClientVerb = "connect" | "disconnect" | "status";

export interface GatewayClientCommandDeps extends RuntimeApiDeps {
  /** Local-fallback seams; production reads the real home and config. */
  context?: () => GatewayClientContext;
  loadConfig?: typeof loadConfig;
}

const USAGE: Record<GatewayClientVerb, string> = {
  connect: "ocx connect antigravity|agy [--model <id>] [--json]",
  disconnect: "ocx disconnect antigravity|agy [--json]",
  status: "ocx connect antigravity|agy status [--json]",
};

/** True when the first operand after `connect` or `disconnect` names a gateway client. */
export const isGatewayClientOperand = (operand: string | undefined): operand is GatewayClientId => isGatewayClientId(operand);

type Body = Record<string, unknown> & { ok: boolean; message?: string; notes?: GatewayNote[]; changedFiles?: string[]; restore?: string; status?: GatewayClientStatus };

function actionLines(body: Body, offlinePort: number | null): string[] {
  const out = [body.message ?? (body.ok ? "Done." : "Failed.")];
  for (const file of body.changedFiles ?? []) out.push(`  changed: ${file}`);
  if (body.restore) out.push(`  restore: ${body.restore}`);
  for (const override of body.status?.overrides ?? []) out.push(`  warning (${override.source}): ${override.detail}`);
  for (const note of body.notes ?? []) out.push(`  ${note.text}`);
  if (offlinePort !== null && body.ok) out.push(`  The proxy is not running. Start it so the client has something to talk to: ocx start (port ${offlinePort}).`);
  return out;
}

function statusLines(status: GatewayClientStatus, offline: boolean): string[] {
  const out = [`${status.label}: ${status.state}`];
  for (const file of status.files) out.push(`  ${file.exists ? "found  " : "missing"} ${file.role}: ${file.path}`);
  for (const override of status.overrides) out.push(`  warning (${override.source}): ${override.detail}`);
  for (const note of status.notes) out.push(`  ${note.text}`);
  if (offline) out.push("  The proxy is not running.");
  return out;
}

const isOffline = (error: unknown): boolean => error instanceof RuntimeApiError && error.code === "proxy_not_running";

function refusalBody(error: unknown): Body | null {
  if (!(error instanceof RuntimeApiError) || error.status !== 409) return null;
  const body = error.body as Body | null;
  return body && typeof body === "object" && body.ok === false ? body : null;
}

/** Exit 5 is the CLI's "refused" code, the same one runCliAction gives any 409. */
function refuse(body: Body, wantsJson: boolean): void {
  if (wantsJson) console.log(JSON.stringify(body, null, 2));
  else console.error(`Error: ${terminalSafeText(String(body.message ?? "refused"))}`);
}

async function runLocally(verb: GatewayClientVerb, id: GatewayClientId, model: string | undefined, wantsJson: boolean, deps: GatewayClientCommandDeps): Promise<number> {
  const config = (deps.loadConfig ?? loadConfig)();
  const ctx = (deps.context ?? productionGatewayClientContext)();
  const resolved = resolveGatewayTarget(config, config.port, model);
  const target = resolved.ok ? resolved.target : undefined;
  if (verb === "status") {
    const mine = gatewayClientsStatus(ctx, target).find(client => client.id === id)!;
    printData(mine, wantsJson, statusLines(mine, true));
    return 0;
  }
  const outcome = verb === "connect" ? connectGatewayClient(id, ctx, config, config.port, model) : disconnectGatewayClient(id, ctx, target);
  const body = gatewayActionBody(outcome) as Body;
  if (!outcome.ok) { refuse(body, wantsJson); return 5; }
  printData(body, wantsJson, actionLines(body, verb === "connect" ? config.port : null));
  return 0;
}

export async function runGatewayClientCommand(verb: GatewayClientVerb, id: GatewayClientId, argv: string[], deps: GatewayClientCommandDeps = {}): Promise<number> {
  const args = [...argv];
  let exit = 0;
  const code = await runCliAction(async () => {
    const wantsJson = takeJsonFlag(args);
    const model = verb === "connect" ? takeOption(args, "--model") : undefined;
    rejectArgs(args, USAGE[verb], { redactValues: true });
    if (model !== undefined && model.trim() === "") throw new CliUsageError("--model requires a non-empty value", USAGE[verb]);
    try {
      if (verb === "status") {
        const { clients } = await runtimeRequest<{ clients: GatewayClientStatus[] }>("/api/gateway-clients", {}, deps);
        const mine = clients.find(client => client.id === id);
        if (!mine) throw new RuntimeApiError(`The proxy did not report ${id}.`, 404, null);
        printData(mine, wantsJson, statusLines(mine, false));
        return;
      }
      const init: RequestInit = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(verb === "connect" && model ? { model } : {}) };
      const body = await runtimeRequest<Body>(`/api/gateway-clients/${id}/${verb}`, init, deps);
      printData(body, wantsJson, actionLines(body, null));
    } catch (error) {
      const refusal = refusalBody(error);
      if (refusal) { refuse(refusal, wantsJson); exit = 5; return; }
      if (!isOffline(error)) throw error;
      exit = await runLocally(verb, id, model, wantsJson, deps);
    }
  });
  return code !== 0 ? code : exit;
}

/** Route `connect|disconnect <client> ...` here; `args` is argv after the command word. */
export function runGatewayClientFromArgs(command: "connect" | "disconnect", args: string[], deps: GatewayClientCommandDeps = {}): Promise<number> {
  const id = args[0] as GatewayClientId;
  const rest = args.slice(1);
  if (command === "connect" && rest[0] === "status") return runGatewayClientCommand("status", id, rest.slice(1), deps);
  return runGatewayClientCommand(command, id, rest, deps);
}
