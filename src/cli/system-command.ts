import {
  CliUsageError,
  printData,
  rejectArgs,
  runCliAction,
  runtimeRequest,
  summaryLines,
  takeBooleanOption,
  takeFlag,
  takeOption,
  type RuntimeApiDeps,
} from "./runtime-api";

const USAGE = `Usage:
  ocx system [status] [--json]
  ocx system settings [--auto-start <on|off>] [--stream-mode <auto|legacy-tee|eager-relay>] [--json]
  ocx system startup <health|install-service|install-shim> [--json]
  ocx system diagnostics [--json]
  ocx system sync [--json]
  ocx system update check [--channel <latest|preview>] [--json]
  ocx system update run [--channel <latest|preview>] [--restart <on|off>] --yes [--json]
  ocx system update status <job-id> [--json]`;

async function status(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  const [settings, startup, memory] = await Promise.all([
    runtimeRequest("/api/settings", {}, deps),
    runtimeRequest("/api/startup-health", {}, deps),
    runtimeRequest("/api/system/memory", {}, deps),
  ]);
  const result = { settings, startup, memory };
  printData(result, wantsJson, summaryLines(result));
}

async function settings(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const autoStart = takeBooleanOption(args, "--auto-start");
  const streamMode = takeOption(args, "--stream-mode");
  rejectArgs(args, USAGE);
  if (autoStart === undefined && streamMode === undefined) {
    const result = await runtimeRequest("/api/settings", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  const body = { ...(autoStart !== undefined ? { codexAutoStart: autoStart } : {}), ...(streamMode !== undefined ? { streamMode } : {}) };
  const result = await runtimeRequest("/api/settings", { method: "PUT", body: JSON.stringify(body) }, deps);
  printData(result, wantsJson, ["System settings updated."]);
}

async function startup(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "health").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  rejectArgs(args, USAGE);
  if (action === "health" || action === "status") {
    const result = await runtimeRequest("/api/startup-health", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  if (action !== "install-service" && action !== "install-shim") throw new CliUsageError("startup action must be health, install-service, or install-shim", USAGE);
  const result = await runtimeRequest("/api/startup-action", { method: "POST", body: JSON.stringify({ action }) }, deps);
  printData(result, wantsJson, [String((result as Record<string, unknown>).message ?? `${action} complete.`)]);
}

async function update(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const action = (args.shift() ?? "check").toLowerCase();
  const wantsJson = takeFlag(args, "--json");
  if (action === "status") {
    const jobId = args.shift();
    if (!jobId) throw new CliUsageError("update job id is required", USAGE);
    rejectArgs(args, USAGE);
    printData(await runtimeRequest(`/api/update/status?jobId=${encodeURIComponent(jobId)}`, {}, deps), wantsJson);
    return;
  }
  const channel = takeOption(args, "--channel") ?? "latest";
  if (channel !== "latest" && channel !== "preview") throw new CliUsageError("--channel must be latest or preview", USAGE);
  if (action === "check") {
    rejectArgs(args, USAGE);
    printData(await runtimeRequest(`/api/update/check?tag=${channel}`, {}, deps), wantsJson);
    return;
  }
  if (action !== "run") throw new CliUsageError(`unknown update action ${action}`, USAGE);
  const restart = takeBooleanOption(args, "--restart") ?? true;
  const yes = takeFlag(args, "--yes");
  if (!yes) throw new CliUsageError("update run requires --yes", USAGE);
  rejectArgs(args, USAGE);
  const result = await runtimeRequest("/api/update/run", { method: "POST", body: JSON.stringify({ tag: channel, restart }) }, deps);
  printData(result, wantsJson, [`Update started (${channel}).`]);
}

export async function handleSystemCommand(argv: string[], deps: RuntimeApiDeps = {}): Promise<number> {
  return runCliAction(async () => {
    const [sub = "status", ...rest] = argv;
    if (sub === "status") await status(rest, deps);
    else if (sub === "settings") await settings(rest, deps);
    else if (sub === "startup") await startup(rest, deps);
    else if (sub === "diagnostics") {
      const args = [...rest]; const wantsJson = takeFlag(args, "--json"); rejectArgs(args, USAGE);
      printData(await runtimeRequest("/api/diagnostics/project-config", {}, deps), wantsJson);
    } else if (sub === "sync") {
      const args = [...rest]; const wantsJson = takeFlag(args, "--json"); rejectArgs(args, USAGE);
      printData(await runtimeRequest("/api/sync", { method: "POST" }, deps), wantsJson);
    } else if (sub === "update") await update(rest, deps);
    else throw new CliUsageError(`unknown system command ${sub}`, USAGE);
  });
}

export const SYSTEM_USAGE = USAGE;
