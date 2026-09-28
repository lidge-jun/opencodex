#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../../../../");
const scratchRoot = resolve(root, ".tmp/droid-integration-verification");
const runsRoot = resolve(scratchRoot, "runs");
const evidenceRoot = resolve(scratchRoot, "evidence");
const scriptPath = resolve(import.meta.path);
const servicePort = 12587;
const guiPort = 12687;
const mockPort = 12588;
const fixtureModels = ["ladder-alpha", "ladder-beta", "no-ladder"] as const;
const args = process.argv.slice(2);

type Run = { id: string; pid: number; servicePort: number; guiPort: number; mockPort: number; startedAt: string };
let latestCapture: { model: string; effort: string | null; privateDefaultHeaderAbsent: boolean; route: string } | null = null;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function validId(value: string | undefined): value is string {
  return value !== undefined && /^[a-z0-9-]{8,64}$/.test(value);
}

function paths(id: string) {
  const dir = resolve(runsRoot, id);
  return { dir, state: resolve(dir, "run.json"), log: resolve(dir, "server.log") };
}

async function readRun(id: string): Promise<Run> {
  const run = JSON.parse(await readFile(paths(id).state, "utf8")) as Run;
  if (run.id !== id || run.servicePort !== servicePort || run.guiPort !== guiPort || run.mockPort !== mockPort) fail("Run metadata does not match this harness.");
  return run;
}

async function freePort(port: number): Promise<boolean> {
  return (await listenerPids(port)).length === 0;
}

async function listenerPids(port: number): Promise<number[]> {
  const proc = Bun.spawn(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { stdout: "pipe", stderr: "ignore" });
  const output = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return output.split(/\s+/).filter(Boolean).map(Number).filter(Number.isInteger);
}

async function processCommand(pid: number): Promise<string | null> {
  const proc = Bun.spawn(["ps", "-p", String(pid), "-o", "command="], { stdout: "pipe", stderr: "ignore" });
  const output = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  return output || null;
}

async function doctor(id: string, record = true, print = true): Promise<void> {
  const run = await readRun(id);
  const command = await processCommand(run.pid);
  if (!command?.includes(scriptPath) || !command.includes(`serve ${id}`)) fail(`Recorded process ${run.pid} is not this harness run.`);
  for (const port of [servicePort, guiPort, mockPort]) {
    const owners = await listenerPids(port);
    if (owners.length !== 1 || owners[0] !== run.pid) fail(`Port ${port} is not owned exclusively by run ${id}.`);
  }
  const response = await fetch(`http://127.0.0.1:${servicePort}/healthz`, { signal: AbortSignal.timeout(1500) });
  const health = await response.json() as { service?: string; pid?: number; port?: number };
  if (!response.ok || health.service !== "opencodex" || health.pid !== run.pid || health.port !== servicePort) {
    fail(`Health identity mismatch for run ${id}.`);
  }
  const gui = await fetch(`http://127.0.0.1:${servicePort}/`, { signal: AbortSignal.timeout(1500) });
  if (!gui.ok) fail(`Dashboard listener returned HTTP ${gui.status}.`);
  const result = { runId: id, pid: run.pid, serviceUrl: `http://127.0.0.1:${servicePort}`, dashboardUrl: `http://127.0.0.1:${servicePort}/#integrations/droid`, interceptPort: guiPort, mockPort, health: "healthy", dashboardStatus: gui.status };
  if (record) await writeEvidence(id, "doctor.json", result);
  if (print) console.log(JSON.stringify(result, null, 2));
}

async function writeEvidence(id: string, name: string, value: unknown): Promise<void> {
  const dir = resolve(evidenceRoot, id);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function startRun(id: string, startedAt = new Date().toISOString()): Promise<Run> {
  const { dir } = paths(id);
  const child = spawn(process.execPath, ["run", scriptPath, "serve", id], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      OPENCODEX_HOME: resolve(dir, "opencodex-home"),
      CODEX_HOME: resolve(dir, "codex-home"),
      DROID_VERIFY_RUN_ID: id,
    },
  });
  if (!child.pid) throw new Error("Could not start the isolated server process.");
  child.unref();
  const run: Run = { id, pid: child.pid, servicePort, guiPort, mockPort, startedAt };
  try {
    await writeFile(paths(id).state, `${JSON.stringify(run, null, 2)}\n`, { mode: 0o600 });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${servicePort}/healthz`, { signal: AbortSignal.timeout(500) });
        const health = await response.json() as { service?: string; pid?: number; port?: number };
        const owners = await Promise.all([servicePort, guiPort, mockPort].map(listenerPids));
        if (response.ok && health.service === "opencodex" && health.pid === child.pid && health.port === servicePort
          && owners.every(pids => pids.length === 1 && pids[0] === child.pid)) return run;
      } catch { /* Wait for this child to bind its listeners. */ }
      if (Date.now() + 500 >= deadline) break;
      await Bun.sleep(250);
    }
    throw new Error("Server did not become ready with the expected identity and listeners.");
  } catch (error) {
    await stopChild(child.pid, id);
    throw error;
  }
}

async function launch(): Promise<void> {
  if (!(await freePort(servicePort)) || !(await freePort(guiPort)) || !(await freePort(mockPort))) fail(`Refusing to use occupied verification ports ${servicePort}/${guiPort}/${mockPort}.`);
  const id = `${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}-${crypto.randomUUID().slice(0, 8)}`.toLowerCase();
  const { dir } = paths(id);
  const opencodexHome = resolve(dir, "opencodex-home");
  const codexHome = resolve(dir, "codex-home");
  let run: Run | undefined;
  try {
    await mkdir(opencodexHome, { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await seedFixtures(dir);
    run = await startRun(id);
    await writeEvidence(id, "launch.json", { runId: id, pid: run.pid, servicePort, guiPort, mockPort, fixtureModels, opencodexHome: "isolated scratch", codexHome: "isolated scratch", ready: true });
    console.log(JSON.stringify({ runId: id, pid: run.pid, serviceUrl: `http://127.0.0.1:${servicePort}`, dashboardUrl: `http://127.0.0.1:${servicePort}/#integrations/droid`, interceptPort: guiPort, mockPort, evidence: resolve(evidenceRoot, id) }, null, 2));
  } catch (error) {
    if (run) await stopChild(run.pid, id);
    await rm(dir, { recursive: true, force: true });
    fail(error instanceof Error ? `${error.message} Launch scratch state was cleaned.` : "Launch failed; its process and scratch state were cleaned.");
  }
}

async function cleanup(id: string): Promise<void> {
  const run = await readRun(id);
  const command = await processCommand(run.pid);
  if (command) await stopChild(run.pid, id);
  const remainingOwners = (await Promise.all([servicePort, guiPort, mockPort].map(listenerPids))).flat();
  if (remainingOwners.includes(run.pid)) fail(`Run ${id} still owns a listener; scratch state retained.`);
  const health = await fetch(`http://127.0.0.1:${servicePort}/healthz`, { signal: AbortSignal.timeout(300) }).then(r => r.json().catch(() => null)).catch(() => null) as { pid?: number } | null;
  if (health?.pid === run.pid) fail(`Run ${id} still owns the service listener; scratch state retained.`);
  const evidence = resolve(evidenceRoot, id);
  await writeEvidence(id, "cleanup.json", { runId: id, pid: run.pid, stopped: true, evidenceRetainedAt: evidence });
  await rm(paths(id).dir, { recursive: true, force: true });
  console.log(JSON.stringify({ runId: id, stopped: true, scratchRemoved: true, evidenceRetainedAt: evidence }, null, 2));
}

async function serve(id: string): Promise<void> {
  const { dir, log } = paths(id);
  const opencodexHome = resolve(dir, "opencodex-home");
  const codexHome = resolve(dir, "codex-home");
  process.env.OPENCODEX_HOME = opencodexHome;
  process.env.CODEX_HOME = codexHome;
  const { setIntegrationPathTestHooks } = await import("../../../../src/server/management/integration-routes");
  const { startServer } = await import("../../../../src/server");
  const { createReadinessGate } = await import("../../../../src/server/readiness");
  setIntegrationPathTestHooks({ home: resolve(dir, "client-files"), env: process.env });
  const gate = createReadinessGate();
  gate.markReady();
  const originalLog = console.log;
  const originalError = console.error;
  const logFile = Bun.file(log).writer();
  console.log = (...values: unknown[]) => { logFile.write(`${values.map(String).join(" ")}\n`); };
  console.error = (...values: unknown[]) => { logFile.write(`${values.map(String).join(" ")}\n`); };
  const mock = Bun.serve({ hostname: "127.0.0.1", port: mockPort, async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/__capture/latest" && request.method === "GET") {
      return latestCapture ? Response.json(latestCapture) : Response.json({ error: "no fixture request captured" }, { status: 404 });
    }
    if (url.pathname !== "/v1/chat/completions" || request.method !== "POST") return new Response("Not found", { status: 404 });
    const body = await request.json() as Record<string, unknown>;
    const model = typeof body.model === "string" ? body.model : "";
    if (!fixtureModels.some(id => model === id || model.endsWith(`/${id}`))) return Response.json({ error: "unknown fixture model" }, { status: 404 });
    const nested = body.reasoning && typeof body.reasoning === "object" ? body.reasoning as Record<string, unknown> : {};
    latestCapture = {
      model,
      effort: typeof body.reasoning_effort === "string" ? body.reasoning_effort : typeof nested.effort === "string" ? nested.effort : null,
      privateDefaultHeaderAbsent: !request.headers.has("x-opencodex-droid-default-effort"),
      route: `${request.method} ${url.pathname}`,
    };
    return Response.json({ id: "fixture-response", object: "chat.completion", created: 0, model,
      choices: [{ index: 0, message: { role: "assistant", content: "fixture-ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  } });
  const server = startServer(servicePort, { readinessGate: gate });
  process.on("SIGTERM", async () => {
    await server.stop(true);
    mock.stop(true);
    await logFile.end();
    console.log = originalLog;
    console.error = originalError;
    process.exit(0);
  });
  await new Promise(() => {});
}

async function seedFixtures(dir: string): Promise<void> {
  const config = {
    port: servicePort,
    defaultProvider: "droid-fixture",
    providers: {
      "droid-fixture": {
        adapter: "openai-chat",
        baseUrl: `http://127.0.0.1:${mockPort}/v1`,
        allowPrivateNetwork: true,
        liveModels: false,
        models: [...fixtureModels],
        modelReasoningEfforts: {
          "ladder-alpha": ["low", "medium", "high"],
          "ladder-beta": ["low", "medium", "high"],
          "no-ladder": [],
        },
      },
    },
  };
  const clientHome = resolve(dir, "client-files");
  await mkdir(resolve(clientHome, ".factory"), { recursive: true });
  await writeFile(resolve(dir, "opencodex-home/config.json"), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await writeFile(resolve(clientHome, ".factory/settings.json"), `${JSON.stringify({ customModels: [] }, null, 2)}\n`, { mode: 0o600 });
}

async function stopChild(pid: number, id: string): Promise<void> {
  const ownsProcess = (command: string | null) => command?.includes(scriptPath) === true && command.includes(`serve ${id}`);
  let command = await processCommand(pid);
  if (!command) return;
  if (!ownsProcess(command)) throw new Error(`Refusing to stop PID ${pid}; its command does not match run ${id}.`);
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    command = await processCommand(pid);
    if (!command) return;
    if (!ownsProcess(command)) throw new Error(`PID ${pid} changed identity while stopping run ${id}.`);
    await Bun.sleep(100);
  }
  command = await processCommand(pid);
  if (!command) return;
  if (!ownsProcess(command)) throw new Error(`PID ${pid} changed identity while stopping run ${id}.`);
  process.kill(pid, "SIGKILL");
  const forcedDeadline = Date.now() + 2_000;
  while (Date.now() < forcedDeadline && await processCommand(pid)) await Bun.sleep(100);
  if (await processCommand(pid)) throw new Error(`PID ${pid} could not be stopped; scratch state retained.`);
}

async function request(id: string, model: string, mode: string): Promise<void> {
  await doctor(id, false, false);
  if (!fixtureModels.includes(model as typeof fixtureModels[number])) fail("Use one of the three seeded fixture model IDs.");
  if (mode !== "none" && !/^(top|nested)=(low|medium|high)$/.test(mode)) {
    fail("Effort mode must be none, top=low|medium|high, or nested=low|medium|high.");
  }
  const selectedEffort = mode === "none" ? null : mode.slice(mode.indexOf("=") + 1);
  const savedEffort = await fixtureDefault(id, `droid-fixture/${model}`);
  const body: Record<string, unknown> = {
    model: `droid-fixture/${model}`,
    messages: [{ role: "user", content: "verification fixture" }],
  };
  if (mode.startsWith("top=")) body.reasoning_effort = selectedEffort;
  else if (mode.startsWith("nested=")) body.reasoning = { effort: selectedEffort };
  const capture = async (headers: Record<string, string> = {}) => {
    const response = await fetch(`http://127.0.0.1:${servicePort}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) fail(`Fixture request returned HTTP ${response.status}; inspect the isolated server log.`);
    const captured = await fetch(`http://127.0.0.1:${mockPort}/__capture/latest`, { signal: AbortSignal.timeout(1000) });
    return { ok: captured.ok, summary: await captured.json() as { model: string; effort: string | null; privateDefaultHeaderAbsent: boolean; route: string } };
  };
  const baselineHeaders = mode.startsWith("nested=") || !savedEffort
    ? {}
    : { "x-opencodex-droid-default-effort": savedEffort };
  const baseline = await capture(baselineHeaders);
  let summary = baseline.summary;
  let headerEffort: string | null | undefined;
  const expectedEffort = mode === "none" ? savedEffort : selectedEffort;
  if (mode.startsWith("nested=")) {
    const fallbackEffort = ["high", "medium", "low"].find(effort => effort !== selectedEffort)!;
    const comparisonHeader = savedEffort && savedEffort !== selectedEffort ? savedEffort : fallbackEffort;
    const withHeader = await capture({ "x-opencodex-droid-default-effort": comparisonHeader });
    headerEffort = withHeader.summary.effort;
    if (!withHeader.ok || withHeader.summary.model !== baseline.summary.model
      || withHeader.summary.route !== baseline.summary.route
      || withHeader.summary.privateDefaultHeaderAbsent !== baseline.summary.privateDefaultHeaderAbsent
      || withHeader.summary.effort !== baseline.summary.effort) {
      fail("Nested-effort boundary behavior changed when the Droid header was present.");
    }
    summary = withHeader.summary;
  } else if (summary.effort !== expectedEffort) {
    fail("Fixture boundary effort did not match the expected safe summary.");
  }
  if (!baseline.ok || !baseline.summary.privateDefaultHeaderAbsent
    || (summary.model !== model && !summary.model.endsWith(`/${model}`))
    || !summary.privateDefaultHeaderAbsent || summary.route !== "POST /v1/chat/completions") {
    fail("Fixture boundary capture did not match the expected safe summary.");
  }
  const proof = headerEffort === undefined ? summary : { ...summary, headerEffort };
  await writeEvidence(id, `request-${Date.now()}.json`, proof);
  console.log(JSON.stringify(proof, null, 2));
}

async function fixtureDefault(id: string, model: string): Promise<string | null> {
  const settingsPath = resolve(paths(id).dir, "client-files/.factory/settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8")) as { customModels?: Array<{ model?: string; extraHeaders?: Record<string, string> }> };
  const entry = settings.customModels?.find(row => row.model === model);
  return entry?.extraHeaders?.["x-opencodex-droid-default-effort"] ?? null;
}

async function changeFixture(id: string, action: string, model: string, efforts = ""): Promise<void> {
  const run = await readRun(id);
  await doctor(id, false);
  if (!fixtureModels.includes(model as typeof fixtureModels[number])) fail("Use one of the three seeded fixture model IDs.");
  const configPath = resolve(paths(id).dir, "opencodex-home/config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as {
    providers: Record<string, { models: string[]; modelReasoningEfforts: Record<string, string[]> }>;
  };
  const provider = config.providers["droid-fixture"]!;
  if (action === "remove") {
    provider.models = provider.models.filter(candidate => candidate !== model);
    delete provider.modelReasoningEfforts[model];
  } else if (action === "efforts") {
    const ladder = efforts === "none" ? [] : efforts.split(",");
    if (ladder.some(effort => !["low", "medium", "high"].includes(effort))) fail("Fixture efforts may contain only low, medium, and high, or none.");
    if (!provider.models.includes(model)) provider.models.push(model);
    provider.modelReasoningEfforts[model] = ladder;
  } else fail("Fixture action must be remove or efforts.");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await stopChild(run.pid, id);
  let restarted: Run;
  try {
    restarted = await startRun(id, run.startedAt);
  } catch (error) {
    throw new Error(error instanceof Error ? `Fixture server restart failed: ${error.message}` : "Fixture server restart failed.");
  }
  const proof = { runId: id, action, model, efforts: action === "efforts" ? (efforts || "none") : null, restartedPid: restarted.pid };
  await writeEvidence(id, `fixture-${Date.now()}.json`, proof);
  console.log(JSON.stringify(proof, null, 2));
}

const [command, id] = args;
if (command === "serve") {
  if (!validId(id)) fail("Invalid internal run ID.");
  await serve(id);
} else if (command === "launch" && id === undefined) await launch();
else if ((command === "doctor" || command === "cleanup") && validId(id)) {
  if (command === "doctor") await doctor(id);
  else await cleanup(id);
} else if (command === "request" && validId(id) && args[2] && args[3]) {
  await request(id, args[2], args[3]);
} else if (command === "fixture" && validId(id) && args[2] && args[3]) {
  await changeFixture(id, args[2], args[3], args[4]);
} else fail("Usage: harness.ts launch | doctor <run-id> | request <run-id> <model> <none|top=EFFORT|nested=EFFORT> | fixture <run-id> remove|efforts <model> [low,medium,high|none] | cleanup <run-id>");
