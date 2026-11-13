/**
 * A real proxy and its real management route, in a process of its own, for the #8416 test.
 *
 * The regression: "ocx service restart" on Windows ends the Task Scheduler task, kills the
 * surviving wrappers, then asks the still-running proxy to stop through its own
 * POST /api/stop. That route re-asks "is a scheduler task registered that could respawn
 * me?", the task being replaced is still registered, and it answers 409
 * respawnable_service. Before the re-land the refusal escaped repairService, leaving the
 * task stopped and the proxy serving.
 *
 * The proxy lives here, in a child process, so a stop the route ACCEPTS can only terminate
 * this child. Everything that decides the refusal is production code: the HTTP route,
 * admin-token admission, the pid and runtime-port records, stopProxy, and the route's own
 * respawn gate. Only what needs a Windows host is replaced:
 *
 * 1. process.platform is pinned to win32, the same seam repairService({ platform }) uses.
 * 2. The Task Scheduler query is a fixture: /query reports a registered task and every
 *    mutating verb throws, so no scheduler change can reach the host.
 * 3. The manager stop (no SCM on a test host) and the client-config teardown (no native
 *    Codex config in a temp home) report their benign answers.
 *
 * The Task Scheduler probe feeding installedServiceRespawnRisk is deliberately NOT mocked.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mock } from "bun:test";

const home = process.env.OPENCODEX_HOME;
const token = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
if (!home || !token) {
  throw new Error("the fixture requires OPENCODEX_HOME and OPENCODEX_ADMIN_AUTH_TOKEN");
}

/** Resolve a repository file from this fixture, independent of the process cwd. */
const source = (relative: string): string => new URL("../../" + relative, import.meta.url).href;

// Windows-only branch selection inside this process. The host is untouched.
const hostPlatform = process.platform;
Object.defineProperty(process, "platform", { value: "win32", configurable: true });

const scheduler = await import(source("src/service/windows-scheduler.ts"));
const schedulerCallsPath = join(home, "scheduler-calls.json");
const schedulerCalls: string[] = [];
scheduler.setQuerySchtasksForTests((args: string[]) => {
  schedulerCalls.push(args.join(" "));
  writeFileSync(schedulerCallsPath, JSON.stringify(schedulerCalls));
  if (args[0] === "/query") return "TaskName: " + String.fromCharCode(92) + "opencodex-proxy";
  throw new Error("refusing a Task Scheduler mutation from a test fixture: " + args.join(" "));
});

// A test host has neither the SCM registration nor this home's native Codex config. Replace
// only those outcomes; installedServiceRespawnRisk stays the real implementation, so the 409
// under test is produced by production code.
const service = await import(source("src/service.ts"));
mock.module(source("src/service.ts"), () => ({
  ...service,
  stopServiceIfInstalledDetailed: () => "absent",
}));
const inject = await import(source("src/codex/inject.ts"));
mock.module(source("src/codex/inject.ts"), () => ({
  ...inject,
  restoreNativeCodexAsync: async () => ({
    success: true,
    message: "fixture restored",
    artifacts: {
      config: { state: "restored" },
      catalog: { state: "restored" },
      history: { state: "restored" },
    },
  }),
}));
const grok = await import(source("src/grok/inject.ts"));
mock.module(source("src/grok/inject.ts"), () => ({
  ...grok,
  stripGrokConfig: () => ({ ok: true, changed: true, message: "fixture stripped" }),
}));

const { initializeManagementAuthState, managementPrincipal, requireManagementAuth } =
  await import(source("src/server/management-auth.ts"));
const { handleManagementAPI } = await import(source("src/server/management-api.ts"));
const { setServerRef } = await import(source("src/server/lifecycle.ts"));
const processState = await import(source("src/config/process-state.ts"));

const config = { port: 0, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai", shutdownTimeoutMs: 0 };
const auth = initializeManagementAuthState(config);
if (!auth.available) throw new Error("fixture management auth unavailable: " + auth.reason);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  reusePort: false,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return Response.json({ service: "opencodex", pid: process.pid });
    }
    // The same admission startServer applies before the management handler.
    const refusal = requireManagementAuth(req, auth, config);
    if (refusal) return refusal;
    const principal = managementPrincipal(req, auth, config) ?? undefined;
    const body = url.pathname === "/api/stop" ? await req.clone().text() : "";
    const response = await handleManagementAPI(req, url, config, {}, principal);
    if (response && url.pathname === "/api/stop" && req.method === "POST") {
      writeFileSync(join(home, "stop-response.json"), JSON.stringify({ status: response.status, query: url.search, body, response: await response.clone().json() }));
    }
    // The route schedules its own drain and exit after returning the response.
    if (response?.status === 200 && url.pathname === "/api/stop" && req.method === "POST") {
      writeFileSync(join(home, "accepted-stop.json"), JSON.stringify({ pid: process.pid, port: config.port }));
    }
    return response ?? new Response("not found", { status: 404 });
  },
});
config.port = server.port as number;
setServerRef(server);

// The two records stopTrackedProxyIfRunning verifies before it may signal anything.
Object.defineProperty(process, "platform", { value: hostPlatform, configurable: true });
processState.writePid(process.pid);
processState.writeRuntimePort({ pid: process.pid, port: config.port, hostname: "127.0.0.1" });
Object.defineProperty(process, "platform", { value: "win32", configurable: true });
writeFileSync(
  join(home, "config.json"),
  JSON.stringify({ port: config.port, hostname: "127.0.0.1", providers: {}, defaultProvider: "openai" }),
);

process.stdout.write("READY " + process.pid + " " + config.port + String.fromCharCode(10));
setInterval(() => {}, 1000);
