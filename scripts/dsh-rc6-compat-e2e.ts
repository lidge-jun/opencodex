import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";

export const DSH_RC6_VERSION = "0.1.0-rc.6";

const OUTPUT_LIMIT_BYTES = 256 * 1024;
const RUN_TIMEOUT_MS = 60_000;
const TEMPLATE_PLACEHOLDER = "__OCX_BASE_URL__";
const E2E_MODEL = "dsh-e2e-reasoner";
const MISSING_MODEL = "dsh-e2e-missing";
export const DSH_E2E_TOOL_CALLS = [
  { id: "fc_dsh_e2e_alpha", callId: "call_dsh_e2e_alpha", filePath: "probe-alpha.txt", marker: "TOOL_ALPHA" },
  { id: "fc_dsh_e2e_beta", callId: "call_dsh_e2e_beta", filePath: "probe-beta.txt", marker: "TOOL_BETA" },
] as const;
const CREDENTIAL_ENV_PATTERN = /(?:_API_KEY|_API_TOKEN|_AUTH_TOKEN|_ACCESS_TOKEN|_SECRET_ACCESS_KEY)$/i;

type StringEnv = Record<string, string | undefined>;

interface ChildDirs {
  home: string;
  dshHome: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface UpstreamRequest {
  model?: unknown;
  reasoning?: { effort?: unknown };
  tools?: Array<{ name?: unknown; function?: { name?: unknown } }>;
  input?: unknown;
}

export function assertExpectedDshVersion(stdout: string): void {
  const actual = stdout.trim();
  if (actual !== DSH_RC6_VERSION) {
    throw new Error(`expected DSH ${DSH_RC6_VERSION}, received ${actual || "no version"}`);
  }
}

export function renderDshSettings(template: string, openCodexBaseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(openCodexBaseUrl);
  } catch {
    throw new Error("DSH compatibility E2E requires a valid loopback OpenCodex URL");
  }
  if (parsed.protocol !== "http:" || !["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) {
    throw new Error("DSH compatibility E2E requires a loopback OpenCodex URL");
  }
  if (template.split(TEMPLATE_PLACEHOLDER).length !== 2) {
    throw new Error(`DSH settings template must contain exactly one ${TEMPLATE_PLACEHOLDER} placeholder`);
  }
  return template.replace(TEMPLATE_PLACEHOLDER, openCodexBaseUrl.replace(/\/+$/, ""));
}

export function buildDshChildEnv(base: StringEnv, dirs: ChildDirs): StringEnv {
  const env: StringEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (/^(?:HTTP|HTTPS|ALL)_PROXY$/i.test(key) || CREDENTIAL_ENV_PATTERN.test(key)) {
      delete env[key];
    }
  }
  env.HOME = dirs.home;
  env.DSH_HOME = dirs.dshHome;
  env.DSH_TELEMETRY_DISABLED = "1";
  env.NO_PROXY = "127.0.0.1,localhost,::1";
  return env;
}

async function readLimited(stream: ReadableStream<Uint8Array>, maxBytes: number): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new Error("child process output exceeded the compatibility E2E limit");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

async function runCommand(
  executable: string,
  args: string[],
  options: { cwd: string; env: StringEnv; timeoutMs: number },
): Promise<CommandResult> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([executable, ...args], {
      cwd: options.cwd,
      env: options.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch {
    throw new Error("failed to execute the binary selected by DSH_RC6_BIN");
  }

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, options.timeoutMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      readLimited(child.stdout, OUTPUT_LIMIT_BYTES),
      readLimited(child.stderr, OUTPUT_LIMIT_BYTES),
    ]);
    if (timedOut) throw new Error(`DSH compatibility process exceeded ${options.timeoutMs}ms`);
    return { exitCode, stdout, stderr };
  } catch (error) {
    child.kill();
    await child.exited.catch(() => undefined);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function sse(events: Array<Record<string, unknown>>): Response {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function usage() {
  return {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 14,
  };
}

function toolResponse(): Response {
  const items = DSH_E2E_TOOL_CALLS.map(call => ({
    type: "function_call",
    id: call.id,
    call_id: call.callId,
    name: "read",
    arguments: JSON.stringify({ file_path: call.filePath }),
    status: "completed",
  }));
  const events: Array<Record<string, unknown>> = [
    { type: "response.created", response: { id: "resp_dsh_e2e_tool", status: "in_progress", output: [] } },
  ];
  // Interleave both calls so rc.6 must keep their indices and call ids distinct.
  items.forEach((item, outputIndex) => {
    events.push({
      type: "response.output_item.added",
      output_index: outputIndex,
      item: { ...item, arguments: "", status: "in_progress" },
    });
  });
  items.forEach((item, outputIndex) => {
    events.push({
      type: "response.function_call_arguments.delta",
      output_index: outputIndex,
      item_id: item.id,
      delta: item.arguments,
    });
  });
  items.forEach((item, outputIndex) => {
    events.push({
      type: "response.function_call_arguments.done",
      output_index: outputIndex,
      item_id: item.id,
      arguments: item.arguments,
    });
  });
  items.forEach((item, outputIndex) => {
    events.push({ type: "response.output_item.done", output_index: outputIndex, item });
  });
  events.push(
    {
      type: "response.completed",
      response: { id: "resp_dsh_e2e_tool", status: "completed", output: items, usage: usage() },
    },
  );
  return sse(events);
}

function textResponse(text: string, suffix: string): Response {
  const item = {
    type: "message",
    id: `msg_dsh_e2e_${suffix}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return sse([
    { type: "response.created", response: { id: `resp_dsh_e2e_${suffix}`, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: text },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id: `resp_dsh_e2e_${suffix}`, status: "completed", output: [item], usage: usage() },
    },
  ]);
}

function finalResponse(): Response {
  return textResponse("DSH_E2E_OK", "final");
}

function hasReadTool(request: UpstreamRequest): boolean {
  return (request.tools ?? []).some(tool => tool.name === "read" || tool.function?.name === "read");
}

/** Both results must correlate to the exact call id that requested their file. */
export function hasExpectedDshToolOutputs(input: unknown): boolean {
  if (!Array.isArray(input)) return false;
  const outputs = new Map<string, string>();
  for (const item of input) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as { type?: unknown; call_id?: unknown; output?: unknown };
    if (record.type !== "function_call_output" || typeof record.call_id !== "string") continue;
    outputs.set(record.call_id, typeof record.output === "string" ? record.output : (JSON.stringify(record.output) ?? ""));
  }
  return DSH_E2E_TOOL_CALLS.every(call => outputs.get(call.callId)?.includes(call.marker) === true);
}

function opencodexConfig(baseUrl: string): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "dsh-e2e",
    providers: {
      "dsh-e2e": {
        adapter: "openai-responses",
        baseUrl,
        authMode: "key",
        apiKey: "test-key",
        allowPrivateNetwork: true,
        liveModels: false,
        models: [E2E_MODEL],
      },
    },
  } as OcxConfig;
}

function settingsWithDefaultModel(settings: string, model: string): string {
  const needle = `  model: ${E2E_MODEL}`;
  if (settings.split(needle).length !== 2) throw new Error("DSH E2E fixture has an ambiguous default model");
  return settings.replace(needle, `  model: ${model}`);
}

async function runCompatibilityE2E(): Promise<void> {
  const dshBin = process.env.DSH_RC6_BIN?.trim();
  if (!dshBin) throw new Error("set DSH_RC6_BIN to the DSH 0.1.0-rc.6 executable");

  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const template = readFileSync(join(repoRoot, "tests", "fixtures", "dsh-rc6-compat-e2e-settings.yaml"), "utf8");
  const root = mkdtempSync(join(tmpdir(), "ocx-dsh-rc6-e2e-"));
  const ocxHome = join(root, "ocx-home");
  const childHome = join(root, "home");
  const dshHome = join(root, "dsh-home");
  const workspace = join(root, "workspace");
  for (const dir of [ocxHome, childHome, dshHome, workspace]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const call of DSH_E2E_TOOL_CALLS) {
    writeFileSync(join(workspace, call.filePath), `${call.marker}\n`, { mode: 0o600 });
  }

  const previousOpenCodexHome = process.env.OPENCODEX_HOME;
  const requests: UpstreamRequest[] = [];
  let upstream: ReturnType<typeof Bun.serve> | undefined;
  let proxy: ReturnType<typeof startServer> | undefined;
  try {
    const childEnv = buildDshChildEnv(process.env, { home: childHome, dshHome });
    const version = await runCommand(dshBin, ["--version"], { cwd: workspace, env: childEnv, timeoutMs: 10_000 });
    if (version.exitCode !== 0) throw new Error("DSH version probe failed");
    assertExpectedDshVersion(version.stdout);

    upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname !== "/v1/responses" || req.method !== "POST") {
          return new Response("not found", { status: 404 });
        }
        const request = await req.json() as UpstreamRequest;
        requests.push(request);
        const hasToolOutputs = hasExpectedDshToolOutputs(request.input);
        if (requests.length === 1) {
          if (request.model !== E2E_MODEL) return new Response("unexpected model", { status: 400 });
          if (request.reasoning?.effort !== "high") return new Response("unexpected reasoning effort", { status: 400 });
          if (!hasReadTool(request)) return new Response("read tool missing", { status: 400 });
          return toolResponse();
        }
        if (hasToolOutputs && hasReadTool(request)) {
          return finalResponse();
        }
        // rc.6 performs one no-tools title request alongside the two Agent data steps.
        if (!hasToolOutputs && !hasReadTool(request)) return textResponse("DSH E2E", "title");
        return new Response("unexpected DSH request shape", { status: 400 });
      },
    });

    process.env.OPENCODEX_HOME = ocxHome;
    saveConfig(opencodexConfig(new URL("/v1", upstream.url).toString()));
    proxy = startServer(0);
    const settings = renderDshSettings(template, new URL("/v1", proxy.url).toString());
    writeFileSync(join(dshHome, "settings.yaml"), settings, { mode: 0o600 });

    const success = await runCommand(
      dshBin,
      ["--profile", "headless", "Read probe-alpha.txt and probe-beta.txt with the read tool, then report both results."],
      { cwd: workspace, env: childEnv, timeoutMs: RUN_TIMEOUT_MS },
    );
    if (success.exitCode !== 0) throw new Error("DSH success scenario exited non-zero");
    if (!success.stdout.includes("DSH_E2E_OK")) throw new Error("DSH success scenario did not return DSH_E2E_OK");
    const agentRequests = requests.filter(hasReadTool);
    if (agentRequests.length !== 2) {
      throw new Error(`DSH success scenario made ${agentRequests.length} Agent requests instead of 2`);
    }
    if (requests.length !== 3) throw new Error(`DSH rc.6 made ${requests.length} total requests instead of 3`);

    writeFileSync(join(dshHome, "settings.yaml"), settingsWithDefaultModel(settings, MISSING_MODEL), { mode: 0o600 });
    const beforeUnknown = requests.length;
    const unknown = await runCommand(
      dshBin,
      ["--profile", "headless", "This request must fail before network dispatch."],
      { cwd: workspace, env: childEnv, timeoutMs: RUN_TIMEOUT_MS },
    );
    if (unknown.exitCode === 0) throw new Error("DSH unknown-model scenario unexpectedly succeeded");
    if (!`${unknown.stdout}\n${unknown.stderr}`.includes("UNKNOWN_MODEL")) {
      throw new Error("DSH unknown-model scenario did not report UNKNOWN_MODEL");
    }
    if (requests.length !== beforeUnknown) throw new Error("DSH unknown-model scenario reached the upstream server");

    console.log(`DSH ${DSH_RC6_VERSION} compatibility E2E passed: parallel tool continuation and unknown-model refusal`);
  } finally {
    if (proxy) await proxy.stop(true);
    upstream?.stop(true);
    if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousOpenCodexHome;
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  await runCompatibilityE2E().catch((error) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    console.error(`[dsh-rc6-compat-e2e] ${message}`);
    process.exitCode = 1;
  });
}
