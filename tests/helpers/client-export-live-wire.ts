/**
 * Live-wire harness for the OpenCode/Kilo client-config export contracts.
 *
 * Everything here is deterministic and local: a scripted OpenAI-compatible
 * upstream records every request, the client binaries under test are spawned
 * with an isolated HOME/XDG tree, and no remote model is ever contacted.
 *
 * Opt-in: callers gate on OCX_TEST_OPENCODE_BIN / OCX_TEST_KILO_BIN (absolute
 * paths; anything else skips). OCX_TEST_LIVE_SCRATCH relocates the disposable
 * client trees. Verified live against @opencode/cli 2.0.21 and @kilocode/cli
 * 7.8.3 on 2026-10-01; see tests/clients/client-export-live-wire.test.ts for
 * the full matrix, or run the compact smoke matrix directly:
 *
 *   OCX_TEST_OPENCODE_BIN=... OCX_TEST_KILO_BIN=... \
 *     bun tests/helpers/client-export-live-wire.ts
 */

import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { buildClientConfig } from "../../src/clients/config-export";
import type { ExportModel } from "../../src/clients/config-export/contracts";
import { exportModelLabel } from "../../src/clients/config-export/model-metadata";
import { KILO_API_KEY_ENV, OPENCODE_API_KEY_ENV } from "../../src/clients/config-export/constants";

/** Dummy value handed to the clients through the env refs the export emits. */
export const LIVE_WIRE_KEY_VALUE = "ocx-live-wire-key";

/**
 * Resolve an opt-in binary path: undefined (suite skips) unless the value is
 * an absolute path to an existing file, so a stale env value skips instead of
 * failing every test on a spawn error.
 */
export function resolveOptInBin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!isAbsolute(value)) return undefined;
  try { return statSync(value).isFile() ? value : undefined; }
  catch { return undefined; }
}

/** Everything the upstream saw. `body` is the parsed JSON request body. */
export interface CapturedChatRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
  at: number;
}

interface Chunk {
  id: string;
  object: string;
  choices: Array<Record<string, unknown>>;
  usage?: unknown;
}

/** Build one deterministic OpenAI-compatible streaming delta. */
function chunk(delta: Record<string, unknown>, finish: string | null = null, index = 0): Chunk {
  return { id: "chatcmpl-livewire", object: "chat.completion.chunk", choices: [{ index, delta, finish_reason: finish }] };
}

/** End a fixture stream with stable token usage, independent of the client. */
function usageChunk(): Chunk {
  return { id: "chatcmpl-livewire", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } };
}

/** Emit a complete answer, optionally exposing reasoning and the received effort. */
function textTurn(marker: string, opts: { reasoning?: boolean; effortEcho?: unknown } = {}): Chunk[] {
  const out: Chunk[] = [];
  if (opts.reasoning) out.push(chunk({ role: "assistant", reasoning_content: `REASONING(${marker})` }));
  out.push(chunk({ role: "assistant", content: `ANSWER(${marker})${opts.effortEcho === undefined ? "" : ` effort=${String(opts.effortEcho)}`}` }));
  out.push(chunk({}, "stop"));
  out.push(usageChunk());
  return out;
}

/** Ask the client to execute its read tool while retaining assistant reasoning. */
function toolCallTurn(args: Record<string, unknown>): Chunk[] {
  return [
    chunk({ role: "assistant", reasoning_content: "REASONING(tool)" }),
    chunk({
      role: "assistant",
      tool_calls: [{ index: 0, id: "call_livewire_1", type: "function", function: { name: "read", arguments: JSON.stringify(args) } }],
    }),
    chunk({}, "tool_calls"),
  ];
}

export interface LiveWireUpstream {
  url: string;
  requests: CapturedChatRequest[];
  /** Arm "reply with one tool call on the next tools-bearing request for model". */
  forceToolCall(model: string, args?: Record<string, unknown>): void;
  /** One-shot: reply with reasoning even when the request carries no effort. */
  alwaysReasoning(model: string): void;
  reset(): void;
  stop(): void;
}

/** Start a loopback-only scripted upstream and capture requests for wire assertions. */
export function startLiveWireUpstream(): LiveWireUpstream {
  const requests: CapturedChatRequest[] = [];
  const forcedTool = new Map<string, Record<string, unknown>>();
  const forcedReasoning = new Set<string>();
  const servedTool = new Set<string>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET") {
        if (url.pathname.endsWith("/models")) {
          return Response.json({
            object: "list",
            data: [
              { id: "ocxmock/alpha-ladder" },
              { id: "ocxmock/bravo-fixed" },
              { id: "ocxmock/delta-plain" },
            ],
          });
        }
        return new Response("ok");
      }
      const cap: CapturedChatRequest = {
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers.entries()),
        body: undefined,
        at: Date.now(),
      };
      const text = await req.text();
      try {
        cap.body = JSON.parse(text);
      } catch {
        cap.body = text;
      }
      requests.push(cap);
      const body = cap.body ?? {};
      const model = String(body.model ?? "");
      const messages: any[] = Array.isArray(body.messages) ? body.messages : [];
      const tools: any[] = Array.isArray(body.tools) ? body.tools : [];
      let events: Chunk[];
      if (messages.some(m => m?.role === "tool")) {
        events = textTurn("after-tool", { reasoning: true });
      } else if (tools.length > 0 && forcedTool.has(model) && !servedTool.has(model)) {
        servedTool.add(model);
        events = toolCallTurn(forcedTool.get(model)!);
      } else {
        events = textTurn(model, {
          reasoning: forcedReasoning.has(model) || body.reasoning_effort !== undefined,
          effortEcho: body.reasoning_effort,
        });
      }
      const sse = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n";
      return new Response(sse, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/v1`,
    requests,
    forceToolCall(model, args = { path: "note.txt" }) {
      forcedTool.set(model, args);
    },
    alwaysReasoning(model) {
      forcedReasoning.add(model);
    },
    reset() {
      requests.length = 0;
      forcedTool.clear();
      forcedReasoning.clear();
      servedTool.clear();
    },
    stop() {
      server.stop(true);
    },
  };
}

// ---------------------------------------------------------------------------
// Deterministic fixture models (one per capability situation the export must
// distinguish). These feed BOTH the repo serializer (as ExportModel[]) and the
// intended-shape document builders below.
// ---------------------------------------------------------------------------

export const ALPHA = "ocxmock/alpha-ladder";
export const BRAVO = "ocxmock/bravo-fixed";
export const DELTA = "ocxmock/delta-plain";

/** Return fresh adjustable, fixed-reasoning and unknown-capability model fixtures. */
export function liveWireExportModels(): ExportModel[] {
  return [
    {
      namespaced: ALPHA,
      provider: "ocxmock",
      id: "alpha-ladder",
      displayName: "Alpha Ladder",
      contextWindow: 200000,
      maxTokens: 32768,
      maxInputTokens: 100000,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["none", "low", "high", "max"],
      defaultReasoningEffort: "low",
      supportsTools: true,
      supportsReasoning: true,
      supportsReasoningSummaries: true,
    },
    {
      namespaced: BRAVO,
      provider: "ocxmock",
      id: "bravo-fixed",
      displayName: "Bravo Fixed",
      contextWindow: 128000,
      maxTokens: 16384,
      inputModalities: ["text"],
      reasoningEfforts: [],
      supportsTools: true,
      supportsReasoning: true,
    },
    {
      namespaced: DELTA,
      provider: "ocxmock",
      id: "delta-plain",
      displayName: "Delta Plain",
      contextWindow: 64000,
      maxTokens: 8192,
    },
  ];
}

/**
 * The Kilo synthesis kill-switch that actually works on @kilocode/cli 7.8.3.
 *
 * A single disabled sentinel entry does NOT suppress synthesis: the loader
 * filters disabled entries before its "is the declared map non-empty" check,
 * so an all-disabled map reads as empty and the fallback ladder (low/medium/
 * high, or none..max for known fixed-thinking families) is generated anyway —
 * verified live: `kilo run --variant high` against a `{"__ocx_no_effort":
 * {disabled:true}}` map sends `reasoning_effort:"high"`, an effort the model
 * never declared. Disabling every synthesizable rung does suppress: each
 * generated id merges with its disabled override and is dropped, leaving an
 * empty offered set without fabricating a selectable variant.
 */
export const KILO_SUPPRESS_VARIANTS: Record<string, { disabled: true }> = {
  none: { disabled: true },
  minimal: { disabled: true },
  low: { disabled: true },
  medium: { disabled: true },
  high: { disabled: true },
  xhigh: { disabled: true },
  max: { disabled: true },
};

const FIXTURES = liveWireExportModels();

/** Use the production label policy without duplicating it in shape fixtures. */
function modelName(index: number): string {
  return exportModelLabel(FIXTURES[index]!);
}

/** Intended OpenCode document shape (V1 connection block + V2 provider block). */
export function buildIntendedOpenCodeDocument(baseUrl: string): unknown {
  const apiKey = `{env:${OPENCODE_API_KEY_ENV}}`;
  return {
    $schema: "https://opencode.ai/config.json",
    provider: {
      opencodex: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenCodex",
        options: { baseURL: baseUrl, apiKey },
        models: {
          [ALPHA]: {
            name: modelName(0),
            reasoning: true,
            options: { reasoningEffort: "low" },
            interleaved: { field: "reasoning_content" },
            variants: {
              none: { reasoningEffort: "none" },
              low: { reasoningEffort: "low" },
              high: { reasoningEffort: "high" },
              max: { reasoningEffort: "max" },
            },
            limit: { context: 200000, output: 32768, input: 100000 },
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            tool_call: true,
          },
          [BRAVO]: {
            name: modelName(1),
            reasoning: true,
            interleaved: { field: "reasoning_content" },
            variants: KILO_SUPPRESS_VARIANTS,
            limit: { context: 128000, output: 16384 },
            attachment: false,
            modalities: { input: ["text"], output: ["text"] },
            tool_call: true,
          },
          [DELTA]: {
            name: modelName(2),
            limit: { context: 64000, output: 8192 },
          },
        },
      },
    },
    providers: {
      opencodex: {
        package: "@opencode/ai/providers/openai-compatible",
        name: "OpenCodex",
        settings: { baseURL: baseUrl, apiKey },
        models: {
          [ALPHA]: {
            name: modelName(0),
            limit: { context: 200000, output: 32768, input: 100000 },
            capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
            compatibility: { reasoningField: "reasoning_content" },
            settings: { reasoningEffort: "low" },
            variants: [
              { id: "none", settings: { reasoningEffort: "none" } },
              { id: "low", settings: { reasoningEffort: "low" } },
              { id: "high", settings: { reasoningEffort: "high" } },
              { id: "max", settings: { reasoningEffort: "max" } },
            ],
          },
          [BRAVO]: {
            name: modelName(1),
            limit: { context: 128000, output: 16384 },
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            compatibility: { reasoningField: "reasoning_content" },
            variants: [],
          },
          // Unknown tool support: the V2 Config.Model schema REQUIRES capabilities.tools
          // whenever capabilities is present, and ONE invalid entry discards the whole
          // V2 provider block (falling back to the V1 migration and its synthesized
          // ladder everywhere). Omit capabilities entirely for unknown models —
          // verified live on @opencode/cli 2.0.21 by bisection.
          [DELTA]: {
            name: modelName(2),
            limit: { context: 64000, output: 8192 },
            variants: [],
          },
        },
      },
    },
  };
}

/** Intended Kilo document shape (V1 family, kilo.jsonc). */
export function buildIntendedKiloDocument(baseUrl: string): unknown {
  return {
    $schema: "https://app.kilo.ai/config.json",
    provider: {
      opencodex: {
        npm: "@ai-sdk/openai-compatible",
        name: "OpenCodex",
        options: { baseURL: baseUrl, apiKey: `{env:${KILO_API_KEY_ENV}}` },
        models: {
          [ALPHA]: {
            name: modelName(0),
            reasoning: true,
            options: { reasoningEffort: "low" },
            interleaved: { field: "reasoning_content" },
            variants: {
              none: { reasoningEffort: "none" },
              low: { reasoningEffort: "low" },
              high: { reasoningEffort: "high" },
              max: { reasoningEffort: "max" },
            },
            limit: { context: 200000, output: 32768, input: 100000 },
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
          },
          // Fixed-depth reasoning: keep `reasoning: true` (the model does think) but
          // suppress every synthesizable rung — see KILO_SUPPRESS_VARIANTS above.
          [BRAVO]: {
            name: modelName(1),
            reasoning: true,
            interleaved: { field: "reasoning_content" },
            variants: KILO_SUPPRESS_VARIANTS,
            limit: { context: 128000, output: 16384 },
            tool_call: true,
            attachment: false,
            modalities: { input: ["text"], output: ["text"] },
          },
          [DELTA]: {
            name: modelName(2),
            limit: { context: 64000, output: 8192 },
          },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Client process harness
// ---------------------------------------------------------------------------

export const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export interface ClientRunResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ClientHarness {
  kind: "opencode" | "kilo";
  bin: string;
  root: string;
  /** Runs one client invocation in an isolated project. */
  run(args: string[], opts?: { project?: string; timeoutMs?: number }): Promise<ClientRunResult>;
  /** Fresh project directory with note.txt + pixel.png laid down. */
  freshProject(name: string): string;
  cleanup(): void;
}

const SCRATCH_BASE = process.env.OCX_TEST_LIVE_SCRATCH ?? join(tmpdir(), "ocx-live-wire");

/** Create disposable client homes, caches and projects under the test-owned root. */
function makeTree(root: string): { home: string; base: string } {
  const home = join(root, "home");
  mkdirSync(join(home, ".config", "opencode"), { recursive: true });
  mkdirSync(join(home, ".config", "kilo"), { recursive: true });
  mkdirSync(join(home, ".local", "share"), { recursive: true });
  mkdirSync(join(home, ".cache"), { recursive: true });
  mkdirSync(join(home, "tmp"), { recursive: true });
  mkdirSync(join(root, "projects"), { recursive: true });
  return { home, base: root };
}

/** Supply isolated homes and synthetic credentials without inheriting real secrets. */
function clientEnv(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    TMPDIR: join(home, "tmp"),
    // The intended documents reference both client env names; provide the same
    // dummy value for whichever client is running.
    OPENCODEX_OPENCODE_API_KEY: LIVE_WIRE_KEY_VALUE,
    OPENCODEX_KILO_API_KEY: LIVE_WIRE_KEY_VALUE,
    NO_COLOR: "1",
    CI: "1",
    TERM: "dumb",
    LANG: "C.UTF-8",
  };
}

/** Capture a bounded client run; termination errors must never masquerade as success. */
export async function spawnClient(bin: string, args: string[], env: Record<string, string>, cwd: string, timeoutMs: number): Promise<ClientRunResult> {
  const proc = Bun.spawn([bin, ...args], { env, cwd, stdout: "pipe", stderr: "pipe" });
  return collectClientRun(proc, timeoutMs);
}

/** Minimal subprocess contract lets deadline failures be tested without leaking real children. */
interface ClientProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal: number): void;
}

/** Bound output collection even when termination fails or inherited pipes never close. */
export async function collectClientRun(proc: ClientProcess, timeoutMs: number, terminationGraceMs = 5_000): Promise<ClientRunResult> {
  let timedOut = false;
  let terminationFailed = false;
  let stdout = "";
  let stderr = "";
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  let expire: () => void = () => undefined;
  const deadline = new Promise<undefined>(resolve => { expire = () => resolve(undefined); });
  const timer = setTimeout(() => {
    timedOut = true;
    graceTimer = setTimeout(expire, terminationGraceMs);
    try {
      proc.kill(9);
    } catch {
      terminationFailed = true;
    }
  }, timeoutMs);
  try {
    const done = Promise.all([
      new Response(proc.stdout).text().then(value => { stdout = value; }),
      new Response(proc.stderr).text().then(value => { stderr = value; }),
      proc.exited,
    ]);
    const result = await Promise.race([done, deadline]);
    const diagnostic = terminationFailed ? "Client termination failed."
      : result === undefined ? "Client output/exit deadline exceeded after termination." : undefined;
    return {
      code: diagnostic || result === undefined ? -1 : result[2],
      stdout,
      stderr: diagnostic ? `${stderr}\n${diagnostic}` : stderr,
      timedOut,
    };
  } catch {
    try {
      proc.kill(9);
    } catch {
      terminationFailed = true;
    }
    return {
      code: -1,
      stdout,
      stderr: `${stderr}\nClient output collection failed.${terminationFailed ? " Client termination failed." : ""}`,
      timedOut,
    };
  } finally {
    clearTimeout(timer);
    if (graceTimer !== undefined) clearTimeout(graceTimer);
  }
}

/** Run the supplied OpenCode binary against an isolated global config and projects. */
export function openCodeHarness(bin: string, name: string): ClientHarness & { writeGlobalConfig(doc: unknown): void } {
  mkdirSync(SCRATCH_BASE, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_BASE, `opencode-${name}-`));
  const { home } = makeTree(root);
  const projects = join(root, "projects");
  return {
    kind: "opencode",
    bin,
    root,
    writeGlobalConfig(doc: unknown) {
      writeFileSync(join(home, ".config", "opencode", "opencode.json"), JSON.stringify(doc, null, 2));
    },
    freshProject(projectName: string): string {
      const dir = join(projects, projectName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "note.txt"), "live-wire tool note 42\n");
      writeFileSync(join(dir, "pixel.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
      writeFileSync(join(dir, "AGENTS.md"), "Live-wire probe project.\n");
      return dir;
    },
    async run(args, opts = {}) {
      const project = opts.project ?? projects;
      mkdirSync(project, { recursive: true });
      return spawnClient(bin, ["--log-level", "error", ...args], clientEnv(home), project, opts.timeoutMs ?? 150_000);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** Run the supplied Kilo binary against an isolated global config and projects. */
export function kiloHarness(bin: string, name: string): ClientHarness & { writeGlobalConfig(doc: unknown): void } {
  mkdirSync(SCRATCH_BASE, { recursive: true });
  const root = mkdtempSync(join(SCRATCH_BASE, `kilo-${name}-`));
  const { home } = makeTree(root);
  const projects = join(root, "projects");
  return {
    kind: "kilo",
    bin,
    root,
    writeGlobalConfig(doc: unknown) {
      writeFileSync(join(home, ".config", "kilo", "kilo.jsonc"), JSON.stringify(doc, null, 2));
    },
    freshProject(projectName: string): string {
      const dir = join(projects, projectName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "note.txt"), "live-wire tool note 42\n");
      writeFileSync(join(dir, "pixel.png"), Buffer.from(TINY_PNG_BASE64, "base64"));
      writeFileSync(join(dir, "AGENTS.md"), "Live-wire probe project.\n");
      return dir;
    },
    async run(args, opts = {}) {
      const project = opts.project ?? projects;
      mkdirSync(project, { recursive: true });
      return spawnClient(bin, ["--pure", "--log-level", "ERROR", ...args], clientEnv(home), project, opts.timeoutMs ?? 150_000);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Capture inspection helpers
// ---------------------------------------------------------------------------

/** Read conversation roles in wire order, treating a missing conversation as empty. */
export function rolesOf(body: any): string[] {
  return (body?.messages ?? []).map((m: any) => m?.role);
}

/** Inspect the effort actually sent upstream, not the client's configured preference. */
export function reasoningEffortOf(body: any): unknown {
  return body?.reasoning_effort;
}

/** Find tool results replayed by the client after an upstream tool call. */
export function findToolMessages(body: any): any[] {
  return (body?.messages ?? []).filter((m: any) => m?.role === "tool");
}

/** Extract textual reasoning replay from the first assistant history message. */
export function assistantReasoningReplay(body: any, field: string): unknown {
  const assistant = (body?.messages ?? []).find((m: any) => m?.role === "assistant");
  const value = assistant?.[field];
  return typeof value === "string" ? value : undefined;
}

/** Check whether an image survived client serialization into the upstream request. */
export function hasImagePart(body: any): boolean {
  for (const m of body?.messages ?? []) {
    const content = m?.content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type === "image_url" && typeof part.image_url?.url === "string") return true;
    }
  }
  return false;
}

/** The final upstream request of a turn — the one whose tools/history reflect the real conversation. */
export function lastRealTurn(requests: CapturedChatRequest[]): CapturedChatRequest | undefined {
  for (let i = requests.length - 1; i >= 0; i--) {
    const body = requests[i]?.body;
    if (body && Array.isArray(body.messages) && body.messages.length > 0) return requests[i];
  }
  return requests[requests.length - 1];
}

/** Redact the (dummy) credential and strip ANSI for stable evidence output. */
export function sanitizeEvidence(text: string): string {
  return text
    .replace(new RegExp(LIVE_WIRE_KEY_VALUE, "g"), "<live-wire-key>")
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Standalone runner: `bun tests/helpers/client-export-live-wire.ts` executes a
// compact smoke matrix against whatever binaries the env names and prints a
// sanitized summary. The bun:test file above is the authoritative harness.
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const ocBin = resolveOptInBin(process.env.OCX_TEST_OPENCODE_BIN);
  const kiloBin = resolveOptInBin(process.env.OCX_TEST_KILO_BIN);
  if (!ocBin && !kiloBin) {
    console.error("Set OCX_TEST_OPENCODE_BIN and/or OCX_TEST_KILO_BIN to absolute client paths.");
    process.exit(2);
  }
  const upstream = startLiveWireUpstream();
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });

  if (ocBin) {
    const client = openCodeHarness(ocBin, "standalone");
    client.writeGlobalConfig(buildClientConfig("opencode", { baseUrl: upstream.url, models: liveWireExportModels() }));
    for (const [label, selector, want] of [
      ["default", `opencodex/${ALPHA}`, "low"],
      ["#none", `opencodex/${ALPHA}#none`, "none"],
      ["#high", `opencodex/${ALPHA}#high`, "high"],
      ["#max", `opencodex/${ALPHA}#max`, "max"],
    ] as const) {
      upstream.reset();
      const run = await client.run(["run", "--standalone", "-m", selector, "hi"]);
      const effort = run.code === 0 ? reasoningEffortOf(lastRealTurn(upstream.requests)?.body) : undefined;
      check(`opencode ${label}`, run.code === 0 && effort === want, `code=${run.code} effort=${String(effort)}`);
    }
    upstream.reset();
    const rejected = await client.run(["run", "--standalone", "-m", `opencodex/${ALPHA}#medium`, "hi"]);
    check("opencode #medium rejected", rejected.code !== 0, sanitizeEvidence(rejected.stderr).slice(0, 80));
    upstream.reset();
    const bravo = await client.run(["run", "--standalone", "-m", `opencodex/${BRAVO}`, "hi"]);
    check(
      "opencode bravo [] suppresses",
      bravo.code === 0 && reasoningEffortOf(lastRealTurn(upstream.requests)?.body) === undefined,
    );
    client.cleanup();
  }

  if (kiloBin) {
    const client = kiloHarness(kiloBin, "standalone");
    client.writeGlobalConfig(buildClientConfig("kilo", { baseUrl: upstream.url, models: liveWireExportModels() }));
    for (const variant of ["none", "high", "max"] as const) {
      upstream.reset();
      const run = await client.run(["run", "-m", `opencodex/${ALPHA}`, "--variant", variant, "hi"]);
      const effort = run.code === 0 ? reasoningEffortOf(lastRealTurn(upstream.requests)?.body) : undefined;
      check(`kilo --variant ${variant}`, run.code === 0 && effort === variant, `code=${run.code} effort=${String(effort)}`);
    }
    upstream.reset();
    const bravo = await client.run(["run", "-m", `opencodex/${BRAVO}`, "hi"]);
    check(
      "kilo bravo suppressed default",
      bravo.code === 0 && reasoningEffortOf(lastRealTurn(upstream.requests)?.body) === undefined,
    );
    upstream.reset();
    const bravoHigh = await client.run(["run", "-m", `opencodex/${BRAVO}`, "--variant", "high", "hi"]);
    const bravoHighEffort = bravoHigh.code === 0 ? reasoningEffortOf(lastRealTurn(upstream.requests)?.body) : undefined;
    check(
      "kilo bravo --variant high suppressed",
      bravoHigh.code === 0 && bravoHighEffort === undefined,
      bravoHighEffort === undefined ? "" : `synthesis leaked: undeclared effort ${String(bravoHighEffort)} was offered`,
    );
    client.cleanup();
  }

  upstream.stop();
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `  -- ${r.detail}` : ""}`);
  process.exit(results.every(r => r.ok) ? 0 : 1);
}
