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
  ocx system settings [--auto-start <on|off>] [--stream-mode <auto|legacy-tee|eager-relay>]
      [--desktop-authless <on|off>] [--client-compaction <on|off>] [--json]
  ocx system startup <health|install-service|install-shim> [--json]
  ocx system diagnostics [--json]
  ocx system sync [--json]
  ocx system codex-app-server [--json]
  ocx system codex-restart --yes [--json]
  ocx system codex-cli-update check [--json]
  ocx system codex-cli-update attest [--json]
  ocx system codex-cli-update attest --candidate <absolute-path> --npm-prefix <absolute-path> --npm-cli <absolute-path> --node <absolute-path> [--json]
  ocx system update check [--channel <latest|preview>] [--json]
  ocx system update run [--channel <latest|preview>] [--restart <on|off>] --yes [--json]
  ocx system update status <job-id> [--json]

--client-compaction favors native replay portability for future compactions while
keeping OpenCodeX routing active; the configured provider may process summaries
and consume its quota.`;

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

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function desktopSwitchInertReason(reason: unknown): string {
  if (reason === "client_role") return "this proxy is running in the client role";
  if (reason === "non_loopback_bind_requires_admission_token") {
    return "a non-loopback bind requires an admission token, so this flag is inert";
  }
  return "the stored setting is not effective in the current runtime configuration";
}

function desktopSwitchApplyReason(reason: unknown): string {
  if (reason === "not_requested") return "no desktop switch rewrite was requested";
  if (reason === "proxy_not_running") return "the proxy is not running";
  if (reason === "integration_disabled") return "Codex integration is disabled";
  if (reason === "write_lock_busy") return "the Codex config write lock is busy";
  if (reason === "injection_refused") return "Codex config injection was refused";
  return "the rewrite could not be completed";
}

function settingsUpdateLines(
  result: unknown,
  changed: { desktopAuthless: boolean; clientCompaction: boolean },
): string[] {
  if (!changed.desktopAuthless && !changed.clientCompaction) return ["System settings updated."];
  const switches = recordValue(recordValue(result)?.codexDesktopSwitches);
  if (!switches) return ["System settings updated."];

  const lines: string[] = [];
  const appendSwitch = (key: string, label: string): boolean => {
    const state = recordValue(switches[key]);
    if (!state || typeof state.stored !== "boolean" || typeof state.effective !== "boolean") return false;
    lines.push(`${label}: stored ${state.stored ? "on" : "off"}.`);
    // The effective value is always stated, even when it matches. Printing it only on a
    // mismatch would make silence ambiguous — the reader could not tell "the stored value is
    // in force" from "this build does not report effective state", and that ambiguity is a
    // smaller version of the defect being fixed.
    lines.push(state.effective === state.stored
      ? `${label}: effective ${state.effective ? "on" : "off"}.`
      : `${label}: effective ${state.effective ? "on" : "off"} because ${desktopSwitchInertReason(state.inertReason)}.`);
    return true;
  };

  if (changed.desktopAuthless && !appendSwitch("codexDesktopAuthless", "Codex desktop authless")) {
    return ["System settings updated."];
  }
  if (changed.clientCompaction && !appendSwitch("codexClientCompaction", "Codex client compaction")) {
    return ["System settings updated."];
  }

  const apply = recordValue(switches.apply);
  const authSource = recordValue(switches.authSource);
  if (!apply || typeof apply.applied !== "boolean" || !authSource || typeof authSource.summary !== "string") {
    return ["System settings updated."];
  }
  if (apply.applied) {
    lines.push("Codex config: ~/.codex/config.toml was rewritten.");
  } else {
    const detail = typeof apply.detail === "string" && apply.detail.length > 0 ? ` Details: ${apply.detail}` : "";
    lines.push(`Codex config: ~/.codex/config.toml was not rewritten because ${desktopSwitchApplyReason(apply.reason)}.${detail} Run 'ocx sync' to apply the stored settings.`);
  }
  lines.push(`Auth source: ${authSource.summary}`);
  return lines;
}

async function settings(argv: string[], deps: RuntimeApiDeps): Promise<void> {
  const args = [...argv];
  const wantsJson = takeFlag(args, "--json");
  const autoStart = takeBooleanOption(args, "--auto-start");
  const streamMode = takeOption(args, "--stream-mode");
  const desktopAuthless = takeBooleanOption(args, "--desktop-authless");
  const clientCompaction = takeBooleanOption(args, "--client-compaction");
  rejectArgs(args, USAGE);
  if (autoStart === undefined && streamMode === undefined
    && desktopAuthless === undefined && clientCompaction === undefined) {
    const result = await runtimeRequest("/api/settings", {}, deps);
    printData(result, wantsJson, summaryLines(result));
    return;
  }
  const body = {
    ...(autoStart !== undefined ? { codexAutoStart: autoStart } : {}),
    ...(streamMode !== undefined ? { streamMode } : {}),
    ...(desktopAuthless !== undefined ? { codexDesktopAuthless: desktopAuthless } : {}),
    ...(clientCompaction !== undefined ? { codexClientCompaction: clientCompaction } : {}),
  };
  const result = await runtimeRequest("/api/settings", { method: "PUT", body: JSON.stringify(body) }, deps);
  printData(result, wantsJson, settingsUpdateLines(result, {
    desktopAuthless: desktopAuthless !== undefined,
    clientCompaction: clientCompaction !== undefined,
  }));
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
  const [sub = "status", ...rest] = argv;
  if (sub === "codex-cli-update") {
    const { handleCodexCliUpdateCommand } = await import("./codex-cli-update");
    return await handleCodexCliUpdateCommand(rest);
  }
  return runCliAction(async () => {
    if (sub === "status") await status(rest, deps);
    else if (sub === "settings") await settings(rest, deps);
    else if (sub === "startup") await startup(rest, deps);
    else if (sub === "diagnostics") {
      const args = [...rest]; const wantsJson = takeFlag(args, "--json"); rejectArgs(args, USAGE);
      printData(await runtimeRequest("/api/diagnostics/project-config", {}, deps), wantsJson);
    } else if (sub === "sync") {
      const args = [...rest]; const wantsJson = takeFlag(args, "--json"); rejectArgs(args, USAGE);
      printData(await runtimeRequest("/api/sync", { method: "POST" }, deps), wantsJson);
    } else if (sub === "codex-app-server") {
      // The GUI reads this state directly (gui/src/codex-app-server-state.ts). Without a verb
      // an agent could not see whether the Codex app-server was reachable at all.
      const args = [...rest]; const wantsJson = takeFlag(args, "--json"); rejectArgs(args, USAGE);
      printData(await runtimeRequest("/api/system/codex-app-server", {}, deps), wantsJson);
    } else if (sub === "codex-restart") {
      // --yes required: this fully quits and relaunches the user's Codex desktop app as well as
      // restarting app-servers, which can discard unsaved drafts, selections, and approval prompts.
      const args = [...rest];
      const wantsJson = takeFlag(args, "--json");
      const yes = takeFlag(args, "--yes");
      if (!yes) throw new CliUsageError(
        "system codex-restart requires --yes: this fully quits and relaunches the Codex desktop app, so unsaved composer drafts, model-picker selections, and pending approval prompts may be lost; it also restarts the app-servers",
        USAGE,
      );
      rejectArgs(args, USAGE);
      printData(
        await runtimeRequest("/api/system/codex-restart", { method: "POST" }, deps),
        wantsJson,
        ["Codex desktop app and app-server restart requested. Unsaved composer drafts, model-picker selections, and pending approval prompts may be lost."],
      );
    } else if (sub === "update") await update(rest, deps);
    else throw new CliUsageError(`unknown system command ${sub}`, USAGE);
  });
}

export const SYSTEM_USAGE = USAGE;
