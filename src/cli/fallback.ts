import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  takeFlag,
  takeOption,
  terminalSafeText,
  type RuntimeApiDeps,
} from "./runtime-api";

export const FALLBACK_USAGE = `Usage:
  ocx fallback status [--json]
  ocx fallback off   [--kind model|provider|all] [--provider <name> | --route <selector> | --device <id|alias>] [--json]
  ocx fallback on    [--kind model|provider|all] [--provider <name> | --route <selector> | --device <id|alias>] [--json]
  ocx fallback clear [--kind model|provider|all] [--provider <name> | --route <selector> | --device <id|alias>] [--json]
  ocx fallback local <on|off> --device <id|alias> [--json]`;

type Switches = { model?: boolean; provider?: boolean };
interface DeviceRow { id?: string; alias?: string; localFallback?: boolean; model?: boolean | null; provider?: boolean | null }
interface EventRow { at?: string; site?: string; route?: string; kind?: string; from?: string; to?: string; trigger?: string; outcome?: string; scope?: string }
interface FallbackState {
  global?: { model?: boolean; provider?: boolean };
  providers?: Record<string, Switches>;
  routes?: Record<string, Switches>;
  devices?: DeviceRow[];
  last?: EventRow | null;
}

const onOff = (value: boolean | null | undefined): string => value === false ? "off" : value === true ? "on" : "inherit";

function switchesLine(label: string, value: Switches): string {
  const parts: string[] = [];
  if (value.model !== undefined) parts.push("model " + onOff(value.model));
  if (value.provider !== undefined) parts.push("provider " + onOff(value.provider));
  return terminalSafeText(label) + ": " + parts.join(", ");
}

export function fallbackStatusLines(state: FallbackState): string[] {
  const lines = [
    "model fallback: " + (state.global?.model === false ? "off" : "on") + " (global)",
    "provider fallback: " + (state.global?.provider === false ? "off" : "on") + " (global)",
  ];
  for (const [name, value] of Object.entries(state.providers ?? {})) lines.push(switchesLine("provider " + name, value));
  for (const [name, value] of Object.entries(state.routes ?? {})) lines.push(switchesLine("route " + name, value));
  for (const device of state.devices ?? []) {
    const label = "device " + (device.id ?? "?") + (device.alias ? " (" + device.alias + ")" : "");
    lines.push(terminalSafeText(label) + ": local fallback " + (device.localFallback ? "allowed" : "off")
      + ", model " + onOff(device.model) + ", provider " + onOff(device.provider));
  }
  const last = state.last;
  lines.push(last
    ? terminalSafeText("last: " + last.at + " " + last.outcome + " " + last.kind + " fallback on " + last.route + ": "
      + last.from + " -> " + last.to + " (" + last.trigger + ", " + last.scope + ")")
    : "last: no fallback since this proxy started");
  return lines;
}

function takeScope(args: string[]): { scope: "global" | "provider" | "route" | "device"; key?: string } {
  const provider = takeOption(args, "--provider");
  const route = takeOption(args, "--route");
  const device = takeOption(args, "--device");
  const given = [provider, route, device].filter(value => value !== undefined);
  if (given.length > 1) throw new CliUsageError("use one of --provider, --route or --device", FALLBACK_USAGE);
  if (provider !== undefined) return { scope: "provider", key: provider };
  if (route !== undefined) return { scope: "route", key: route };
  if (device !== undefined) return { scope: "device", key: device };
  return { scope: "global" };
}

function takeKinds(args: string[]): Array<"model" | "provider"> {
  const kind = takeOption(args, "--kind") ?? "all";
  if (kind === "all") return ["model", "provider"];
  if (kind === "model" || kind === "provider") return [kind];
  throw new CliUsageError("--kind must be model, provider or all", FALLBACK_USAGE);
}

async function put(body: Record<string, unknown>, deps: RuntimeApiDeps): Promise<FallbackState> {
  return await runtimeRequest<FallbackState>("/api/fallback", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, deps);
}

async function status(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, FALLBACK_USAGE);
  const state = await runtimeRequest<FallbackState>("/api/fallback", {}, deps);
  printData(state, wantsJson, fallbackStatusLines(state));
}

async function setSwitch(argv: string[], value: boolean | null, deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const kinds = takeKinds(args);
  const scope = takeScope(args);
  rejectArgs(args, FALLBACK_USAGE);
  const state = await put({ writes: kinds.map(setting => ({ ...scope, setting, value })) }, deps);
  printData(state, wantsJson, fallbackStatusLines(state));
}

async function local(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const mode = args.shift();
  if (mode !== "on" && mode !== "off") throw new CliUsageError("fallback local needs on or off", FALLBACK_USAGE);
  const device = takeOption(args, "--device");
  if (!device) throw new CliUsageError("fallback local needs --device <id|alias>", FALLBACK_USAGE);
  rejectArgs(args, FALLBACK_USAGE);
  const state = await put({ scope: "device", key: device, setting: "localFallback", value: mode === "on" }, deps);
  printData(state, wantsJson, fallbackStatusLines(state));
}

export async function handleFallbackCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub, ...rest] = argv;
    if (sub === undefined || sub === "status") await status(rest, deps);
    else if (sub === "off") await setSwitch(rest, false, deps);
    else if (sub === "on") await setSwitch(rest, true, deps);
    else if (sub === "clear") await setSwitch(rest, null, deps);
    else if (sub === "local") await local(rest, deps);
    else throw new CliUsageError("unknown fallback command: " + sub, FALLBACK_USAGE);
  });
}
