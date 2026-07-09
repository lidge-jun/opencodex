import { findLiveProxy, probeHostname } from "../server/proxy-liveness";
import { DEBUG_ENV, type DebugSettingsView } from "../lib/debug-settings";
import { runningProxyUpdateHeaders } from "../oauth/login-cli";

type DebugScope = "provider" | "usage";

async function requireLiveProxy() {
  const live = await findLiveProxy();
  if (!live) {
    console.error("Proxy is not running. Start it with: ocx start");
    process.exit(1);
  }
  return live;
}

async function fetchDebugSettings(): Promise<DebugSettingsView> {
  const live = await requireLiveProxy();
  try {
    const res = await fetch(`http://${probeHostname(live.hostname)}:${live.port}/api/debug`, {
      headers: runningProxyUpdateHeaders(),
    });
    if (!res.ok) {
      console.error(`Failed to read debug settings (${res.status})`);
      process.exit(1);
    }
    return await res.json() as DebugSettingsView;
  } catch (err) {
    console.error(`Proxy is running but /api/debug is unreachable: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

async function putDebugSettings(body: Record<string, unknown>): Promise<DebugSettingsView> {
  const live = await requireLiveProxy();
  const res = await fetch(`http://${probeHostname(live.hostname)}:${live.port}/api/debug`, {
    method: "PUT",
    headers: runningProxyUpdateHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Failed to update debug settings (${res.status})${text ? `: ${text.slice(0, 200)}` : ""}`);
    process.exit(1);
  }
  return await res.json() as DebugSettingsView;
}

function printScopeStatus(scope: DebugScope, view: DebugSettingsView): void {
  if (scope === "provider") {
    console.log(`Provider debug: ${view.enabled ? "ON" : "off"}`);
    console.log(`  env=${view.env.debug ? "on" : "off"}, runtime=${view.runtimeOverride.debug === undefined ? "env/default" : view.runtimeOverride.debug ? "on" : "off"}`);
    console.log("  Tail: ocx debug provider logs [-f]");
  } else {
    console.log(`Usage debug: ${view.usage ? "ON" : "off"}`);
    console.log(`  env=${view.env.usage ? "on" : "off"}, runtime=${view.runtimeOverride.usage === undefined ? "env/default" : view.runtimeOverride.usage ? "on" : "off"}`);
    console.log("  Tail: ocx debug usage logs [-f] (via running proxy API)");
  }
}

function envDebugEnabled(): boolean {
  return process.env.OCX_DEBUG === "1"
    || process.env.OCX_DEBUG_FRAMES === "1";
}

async function printProviderLogs(follow: boolean): Promise<void> {
  const live = await requireLiveProxy();
  const base = `http://${probeHostname(live.hostname)}:${live.port}/api/debug/logs`;

  let after = 0;
  try {
    const res = await fetch(`${base}?limit=500`, { headers: runningProxyUpdateHeaders() });
    if (!res.ok) {
      console.error(`Failed to read debug logs (${res.status})`);
      process.exit(1);
    }
    const entries = await res.json() as { seq: number; line: string }[];
    for (const entry of entries) console.log(entry.line);
    if (entries.length > 0) after = entries[entries.length - 1]!.seq;
  } catch (err) {
    console.error(`Failed to read debug logs: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!follow) return;

  while (true) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const res = await fetch(`${base}?after=${after}&limit=500`, { headers: runningProxyUpdateHeaders() });
      if (!res.ok) continue;
      const entries = await res.json() as { seq: number; line: string }[];
      for (const entry of entries) console.log(entry.line);
      if (entries.length > 0) after = entries[entries.length - 1]!.seq;
    } catch {
      /* keep following */
    }
  }
}

async function printUsageLogs(follow: boolean): Promise<void> {
  const live = await requireLiveProxy();
  const base = `http://${probeHostname(live.hostname)}:${live.port}/api/debug/usage-logs`;

  let after = 0;
  try {
    const res = await fetch(`${base}?limit=500`, { headers: runningProxyUpdateHeaders() });
    if (!res.ok) {
      console.error(`Failed to read usage debug logs (${res.status})`);
      process.exit(1);
    }
    const entries = await res.json() as { seq: number; line: string }[];
    for (const entry of entries) console.log(entry.line);
    if (entries.length === 0) console.log("(empty — enable with: ocx debug usage on)");
    if (entries.length > 0) after = entries[entries.length - 1]!.seq;
  } catch (err) {
    console.error(`Failed to read usage debug logs: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (!follow) return;

  while (true) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    try {
      const res = await fetch(`${base}?after=${after}&limit=500`, { headers: runningProxyUpdateHeaders() });
      if (!res.ok) continue;
      const entries = await res.json() as { seq: number; line: string }[];
      for (const entry of entries) console.log(entry.line);
      if (entries.length > 0) after = entries[entries.length - 1]!.seq;
    } catch {
      /* keep following */
    }
  }
}

async function handleScopeCommand(scope: DebugScope, actionArgv: string[]): Promise<void> {
  const action = (actionArgv[0] ?? "status").trim().toLowerCase();

  if (action === "on" || action === "off") {
    const enabled = action === "on";
    const body = scope === "provider" ? { debug: enabled } : { usage: enabled };
    printScopeStatus(scope, await putDebugSettings(body));
    console.log(`\n${scope} debug is now ${enabled ? "enabled" : "disabled"}.`);
    return;
  }

  if (action === "status") {
    printScopeStatus(scope, await fetchDebugSettings());
    return;
  }

  if (action === "reset") {
    const resetKey = scope === "provider" ? "provider" : "usage";
    printScopeStatus(scope, await putDebugSettings({ reset: resetKey }));
    console.log(`\nRuntime override cleared for ${scope}; effective value follows env again.`);
    return;
  }

  if (action === "logs") {
    const follow = actionArgv.slice(1).some(arg => arg === "-f" || arg === "--follow");
    if (scope === "provider") await printProviderLogs(follow);
    else await printUsageLogs(follow);
    return;
  }

  console.error(`Usage: ocx debug ${scope} on|off|status|reset|logs [-f]`);
  process.exit(1);
}

function printTopLevelHelp(): void {
  console.log("Debug commands (proxy must be running):");
  console.log("");
  console.log("  ocx debug provider on|off|status|reset|logs [-f]");
  console.log("  ocx debug usage on|off|status|reset|logs [-f]");
  console.log("");
  console.log("Env defaults on start:");
  console.log("  provider → OCX_DEBUG=1 (legacy OCX_DEBUG_FRAMES still works)");
  console.log(`  usage    → ${DEBUG_ENV.usage}=1`);
}

export async function handleDebugCommand(argv: string[]): Promise<void> {
  const sub = (argv[0] ?? "").trim().toLowerCase();

  if (sub === "provider" || sub === "usage") {
    await handleScopeCommand(sub, argv.slice(1));
    return;
  }

  if (sub === "" || sub === "help" || sub === "--help" || sub === "-h") {
    const live = await findLiveProxy();
    if (!live) {
      console.log("Proxy is not running — env defaults for the next start:");
      console.log(`  provider → OCX_DEBUG = ${envDebugEnabled() ? "on" : "off"}`);
      console.log(`  usage    → ${DEBUG_ENV.usage} = ${process.env[DEBUG_ENV.usage] === "1" ? "on" : "off"}`);
      console.log("");
    }
    printTopLevelHelp();
    return;
  }

  printTopLevelHelp();
  process.exit(1);
}
