#!/usr/bin/env bun
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

type Status = "pass" | "fail" | "error" | "unsupported";

interface DroidModel {
  id: string;
  model: string;
  displayName: string;
  baseUrl: string;
  provider: string;
  noImageSupport?: boolean;
  supportedReasoningEfforts?: string[];
  defaultReasoningEffort?: string;
}

interface DroidSettings {
  customModels: DroidModel[];
}

interface CommandResult {
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

interface CaseResult {
  status: Status;
  detail: string;
  evidence?: string;
  durationMs?: number;
}

interface ModelResult {
  id: string;
  model: string;
  cases: Record<string, CaseResult>;
}

const args = process.argv.slice(2);

function option(name: string, fallback?: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(name + " requires a value");
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(option(name, String(fallback)));
  if (!Number.isInteger(value) || value < 1) throw new Error(name + " must be a positive integer");
  return value;
}

if (args.includes("--help")) {
  console.log([
    "Usage: bun .agents/skills/verify-droid-integration/scripts/run.ts [options]",
    "",
    "Options:",
    "  --dry-run             Export and validate every active Droid model without model requests",
    "  --run-dir <path>      Evidence directory (default: .tmp/verify-droid-integration/<timestamp>)",
    "  --concurrency <n>     Models tested concurrently (default: 3)",
    "  --timeout-ms <n>      Per-request timeout (default: 180000)",
    "  --long-words <n>      Deterministic long-context padding words (default: 20000)",
    "  --models <csv>        Limit to exact custom model IDs or upstream selectors",
    "  --cases <csv>         Limit full runs to text,stream,reasoning,tool,image,long-context",
  ].join("\n"));
  process.exit(0);
}

const repoRoot = resolve(import.meta.dir, "../../../..");
const runId = new Date().toISOString().replaceAll(":", "-") + "-" + process.pid;
const requestedRunDir = option("--run-dir");
const runDir = requestedRunDir
  ? (isAbsolute(requestedRunDir) ? requestedRunDir : resolve(repoRoot, requestedRunDir))
  : join(repoRoot, ".tmp", "verify-droid-integration", runId);
const settingsPath = join(runDir, "settings.json");
const concurrency = positiveInt("--concurrency", 3);
const timeoutMs = positiveInt("--timeout-ms", 180_000);
const longWords = positiveInt("--long-words", 20_000);
const dryRun = args.includes("--dry-run");
const selectedModels = new Set((option("--models", "") ?? "").split(",").filter(Boolean));
const selectedCases = new Set((option("--cases", "") ?? "").split(",").filter(Boolean));
const allCases = ["text", "stream", "reasoning", "tool", "image", "long-context"];
for (const item of selectedCases) {
  if (!allCases.includes(item)) throw new Error("unknown case: " + item);
}

await mkdir(runDir, { recursive: true });

async function runCommand(command: string[], cwd: string, timeout: number): Promise<CommandResult> {
  const started = Date.now();
  const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeout);
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    stdoutPromise,
    stderrPromise,
  ]);
  clearTimeout(timer);
  return { command, exitCode, stdout, stderr, durationMs: Date.now() - started, timedOut };
}

async function writeEvidence(
  modelDir: string,
  name: string,
  result: CommandResult,
): Promise<string> {
  const path = join(modelDir, name + ".json");
  await Bun.write(path, JSON.stringify(result, null, 2) + "\n");
  return path;
}

function events(stdout: string): Record<string, unknown>[] {
  return stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
    try {
      const value = JSON.parse(line);
      return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

function completionText(output: string): string {
  const parsed = events(output);
  const completion = parsed.find(event => event.type === "completion");
  if (completion && typeof completion.finalText === "string") return completion.finalText;
  try {
    const value = JSON.parse(output) as Record<string, unknown>;
    for (const key of ["finalText", "result", "text", "output"]) {
      if (typeof value[key] === "string") return value[key] as string;
    }
  } catch {
    // Plain text and mixed diagnostic output are checked below.
  }
  return output;
}

function verdict(result: CommandResult, marker: string): CaseResult {
  const executionError = result.timedOut || result.exitCode !== 0;
  const ok = !executionError && completionText(result.stdout).trim() === marker;
  return {
    status: executionError ? "error" : ok ? "pass" : "fail",
    detail: result.timedOut
      ? "timed out"
      : ok
        ? "observed " + marker
        : "exit " + result.exitCode + "; exact response mismatch",
    durationMs: result.durationMs,
  };
}

function assertionStatus(base: CaseResult, ok: boolean): Status {
  return base.status === "pass" ? (ok ? "pass" : "fail") : base.status;
}

function readRoundTrip(
  parsed: Record<string, unknown>[],
  filePath: string,
): { called: boolean; returned: boolean; value?: unknown } {
  const call = parsed.find(event => {
    if (event.type !== "tool_call" || event.toolName !== "Read") return false;
    const parameters = event.parameters;
    return parameters && typeof parameters === "object"
      && (parameters as Record<string, unknown>).file_path === filePath;
  });
  if (!call || typeof call.id !== "string") return { called: false, returned: false };
  const result = parsed.find(event =>
    event.type === "tool_result" && event.id === call.id && event.isError === false);
  return { called: true, returned: result !== undefined, value: result?.value };
}

function safeDirName(model: DroidModel): string {
  const slug = model.model.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return slug + "-" + Bun.hash(model.id).toString(16);
}

const exportCommand = [
  process.execPath,
  "run",
  "src/cli/index.ts",
  "export",
  "--client",
  "droid",
  "--out",
  settingsPath,
  "--force",
];
const exportResult = await runCommand(exportCommand, repoRoot, timeoutMs);
await Bun.write(join(runDir, "export.json"), JSON.stringify(exportResult, null, 2) + "\n");
if (exportResult.exitCode !== 0 || exportResult.timedOut) {
  throw new Error("Droid config export failed; see " + join(runDir, "export.json"));
}

const settings = await Bun.file(settingsPath).json() as DroidSettings;
if (!Array.isArray(settings.customModels) || settings.customModels.length === 0) {
  throw new Error("exported settings contain no customModels");
}
const ids = settings.customModels.map(model => model.id);
if (new Set(ids).size !== ids.length) throw new Error("exported custom model IDs are not unique");
if (settings.customModels.some(model => model.provider !== "generic-chat-completion-api")) {
  throw new Error("exported settings contain a non-generic Droid provider");
}
let models = settings.customModels;
if (selectedModels.size > 0) {
  models = models.filter(model => selectedModels.has(model.id) || selectedModels.has(model.model));
  if (models.length !== selectedModels.size) {
    throw new Error("one or more --models selectors did not match the exported active catalog");
  }
}

const healthUrl = new URL(models[0]!.baseUrl);
healthUrl.pathname = "/healthz";
const healthStarted = Date.now();
let health: { ok: boolean; status?: number; body?: string; error?: string; durationMs: number };
try {
  const response = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
  health = {
    ok: response.ok,
    status: response.status,
    body: (await response.text()).slice(0, 2_000),
    durationMs: Date.now() - healthStarted,
  };
} catch (error) {
  health = {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    durationMs: Date.now() - healthStarted,
  };
}
await Bun.write(join(runDir, "health.json"), JSON.stringify({ url: healthUrl.toString(), ...health }, null, 2) + "\n");
if (!health.ok) throw new Error("OpenCodex health check failed; see " + join(runDir, "health.json"));

const versionResult = await runCommand(["droid", "--version"], repoRoot, 10_000);
await Bun.write(join(runDir, "droid-version.json"), JSON.stringify(versionResult, null, 2) + "\n");
if (versionResult.exitCode !== 0) throw new Error("Droid CLI is unavailable");

const summary: {
  runId: string;
  startedAt: string;
  dryRun: boolean;
  settingsPath: string;
  activeModelCount: number;
  selectedModelCount: number;
  results: ModelResult[];
  finishedAt?: string;
} = {
  runId,
  startedAt: new Date().toISOString(),
  dryRun,
  settingsPath,
  activeModelCount: settings.customModels.length,
  selectedModelCount: models.length,
  results: [],
};
const summaryPath = join(runDir, "summary.json");

async function droidCase(
  model: DroidModel,
  modelDir: string,
  name: string,
  extra: string[],
  marker: string,
  timeout: number = timeoutMs,
): Promise<CaseResult> {
  const result = await runCommand([
    "droid",
    "exec",
    "--settings",
    settingsPath,
    "--model",
    model.id,
    "--cwd",
    repoRoot,
    ...extra,
  ], repoRoot, timeout);
  const evidence = await writeEvidence(modelDir, name, result);
  return { ...verdict(result, marker), evidence };
}

async function verifyModel(model: DroidModel): Promise<ModelResult> {
  const modelDir = join(runDir, "models", safeDirName(model));
  await mkdir(modelDir, { recursive: true });
  await Bun.write(join(modelDir, "model.json"), JSON.stringify(model, null, 2) + "\n");
  const cases: Record<string, CaseResult> = {};

  const catalog = await runCommand([
    "droid",
    "exec",
    "--settings",
    settingsPath,
    "--model",
    model.id,
    "--list-tools",
    "--output-format",
    "json",
  ], repoRoot, 30_000);
  const catalogEvidence = await writeEvidence(modelDir, "catalog", catalog);
  let advertisesRead = false;
  try {
    const tools = JSON.parse(catalog.stdout) as Record<string, unknown>[];
    advertisesRead = Array.isArray(tools)
      && tools.some(tool => tool.id === "read-file-cli" || tool.llmId === "Read");
  } catch {
    advertisesRead = false;
  }
  cases.catalog = {
    status: catalog.timedOut || catalog.exitCode !== 0
      ? "error"
      : advertisesRead ? "pass" : "fail",
    detail: catalog.timedOut
      ? "timed out"
      : "exit " + catalog.exitCode + "; Read advertised=" + advertisesRead,
    evidence: catalogEvidence,
    durationMs: catalog.durationMs,
  };
  if (dryRun) return { id: model.id, model: model.model, cases };

  const requested = (name: string) => selectedCases.size === 0 || selectedCases.has(name);
  if (requested("text")) {
    cases.text = await droidCase(
      model,
      modelDir,
      "text",
      ["--output-format", "json", "Reply with exactly TEXT_OK and nothing else."],
      "TEXT_OK",
    );
  }
  if (requested("stream")) {
    const result = await runCommand([
      "droid", "exec", "--settings", settingsPath, "--model", model.id,
      "--cwd", repoRoot, "--output-format", "stream-json",
      "Reply with exactly STREAM_OK and nothing else.",
    ], repoRoot, timeoutMs);
    const parsed = events(result.stdout);
    const evidence = await writeEvidence(modelDir, "stream", result);
    const hasLifecycle = parsed.some(event => event.type === "system")
      && parsed.some(event => event.type === "completion");
    const base = verdict(result, "STREAM_OK");
    cases.stream = {
      ...base,
      status: assertionStatus(base, hasLifecycle),
      detail: hasLifecycle ? base.detail : base.detail + "; stream lifecycle missing",
      evidence,
    };
  }
  if (requested("reasoning")) {
    const efforts = model.supportedReasoningEfforts ?? [];
    if (efforts.length === 0) {
      cases.reasoning = { status: "unsupported", detail: "exported model has no reasoning ladder" };
    } else {
      const effort = model.defaultReasoningEffort && efforts.includes(model.defaultReasoningEffort)
        ? model.defaultReasoningEffort
        : efforts[0]!;
      const result = await runCommand([
        "droid", "exec", "--settings", settingsPath, "--model", model.id,
        "--cwd", repoRoot, "--reasoning-effort", effort,
        "--output-format", "stream-json",
        "Reply with exactly REASONING_OK and nothing else.",
      ], repoRoot, timeoutMs);
      const parsed = events(result.stdout);
      const init = parsed.find(event => event.type === "system" && event.subtype === "init");
      const evidence = await writeEvidence(modelDir, "reasoning", result);
      const base = verdict(result, "REASONING_OK");
      const selected = init?.reasoning_effort === effort;
      cases.reasoning = {
        ...base,
        status: assertionStatus(base, selected),
        detail: selected ? base.detail + "; effort " + effort : base.detail + "; requested effort not observed",
        evidence,
      };
    }
  }
  if (requested("tool")) {
    const marker = "DROID_TOOL_MARKER_" + Bun.hash(model.id).toString(16);
    const markerPath = join(modelDir, "tool-marker.txt");
    await Bun.write(markerPath, marker + "\n");
    const result = await runCommand([
      "droid", "exec", "--settings", settingsPath, "--model", model.id,
      "--cwd", repoRoot, "--only-tools", "Read", "--output-format", "stream-json",
      "Call Read once with " + markerPath + ". After the result, reply with exactly TOOL_OK:"
        + marker + " and no other text.",
    ], repoRoot, timeoutMs);
    const parsed = events(result.stdout);
    const roundTrip = readRoundTrip(parsed, markerPath);
    const resultContainsMarker = typeof roundTrip.value === "string" && roundTrip.value.trim() === marker;
    const evidence = await writeEvidence(modelDir, "tool", result);
    const base = verdict(result, "TOOL_OK:" + marker);
    cases.tool = {
      ...base,
      status: assertionStatus(
        base,
        roundTrip.called && roundTrip.returned && resultContainsMarker,
      ),
      detail: base.detail + "; Read call=" + roundTrip.called + "; result=" + roundTrip.returned
        + "; result marker=" + resultContainsMarker,
      evidence,
    };
  }
  if (requested("image")) {
    if (model.noImageSupport === true) {
      cases.image = { status: "unsupported", detail: "exported model disables image input" };
    } else {
      const sourceImagePath = join(repoRoot, "assets", "pr-gate-screenshot-required.png");
      const imagePath = join(modelDir, "image-" + crypto.randomUUID() + ".png");
      await Bun.write(imagePath, Bun.file(sourceImagePath));
      const result = await runCommand([
        "droid", "exec", "--settings", settingsPath, "--model", model.id,
        "--cwd", repoRoot, "--only-tools", "Read", "--output-format", "stream-json",
        "Use the Read tool on " + imagePath
          + ". Read the image pixels and reply with the exact prefix IMAGE_OK: followed by one space"
          + " and the exact red headline only.",
      ], repoRoot, timeoutMs);
      const parsed = events(result.stdout);
      const roundTrip = readRoundTrip(parsed, imagePath);
      const imagePayload = roundTrip.value === "[object Object],[object Object]";
      const evidence = await writeEvidence(modelDir, "image", result);
      const base = verdict(result, "IMAGE_OK: UI screenshot required");
      cases.image = {
        ...base,
        status: assertionStatus(base, roundTrip.called && roundTrip.returned && imagePayload),
        detail: base.detail + "; image Read call=" + roundTrip.called + "; result=" + roundTrip.returned
          + "; image payload=" + imagePayload,
        evidence,
      };
    }
  }
  if (requested("long-context")) {
    const hash = Bun.hash(model.id).toString(16);
    const startMarker = "LONG_START_" + hash;
    const endMarker = "LONG_END_" + hash;
    const promptPath = join(modelDir, "long-context-prompt.txt");
    const padding = Array.from({ length: longWords }, (_, index) => "context" + (index % 97)).join(" ");
    await Bun.write(
      promptPath,
      [
        "Remember both markers and ignore the padding.",
        startMarker,
        padding,
        endMarker,
        "Reply with exactly LONG_OK:" + startMarker + ":" + endMarker,
      ].join("\n"),
    );
    cases["long-context"] = await droidCase(
      model,
      modelDir,
      "long-context",
      ["--output-format", "json", "--file", promptPath],
      "LONG_OK:" + startMarker + ":" + endMarker,
      timeoutMs * 2,
    );
  }
  return { id: model.id, model: model.model, cases };
}

let cursor = 0;
const workers = Array.from({ length: Math.min(concurrency, models.length) }, async () => {
  while (cursor < models.length) {
    const model = models[cursor++]!;
    let result: ModelResult;
    try {
      result = await verifyModel(model);
    } catch (error) {
      result = {
        id: model.id,
        model: model.model,
        cases: {
          execution: {
            status: "error",
            detail: error instanceof Error ? error.stack ?? error.message : String(error),
          },
        },
      };
    }
    summary.results.push(result);
    summary.results.sort((a, b) => a.model.localeCompare(b.model));
    await Bun.write(summaryPath, JSON.stringify(summary, null, 2) + "\n");
    const nonPassing = Object.values(result.cases)
      .filter(item => item.status === "fail" || item.status === "error").length;
    console.log(model.model + ": " + (nonPassing === 0 ? "PASS" : "FAIL (" + nonPassing + ")"));
  }
});
await Promise.all(workers);

summary.finishedAt = new Date().toISOString();
await Bun.write(summaryPath, JSON.stringify(summary, null, 2) + "\n");
const failures = summary.results.flatMap(model =>
  Object.entries(model.cases)
    .filter(([, result]) => result.status === "fail" || result.status === "error")
    .map(([name, result]) => ({
      model: model.model, case: name, status: result.status, detail: result.detail,
    })));
await Bun.write(join(runDir, "failures.json"), JSON.stringify(failures, null, 2) + "\n");
console.log("Evidence: " + runDir);
console.log("Models: " + summary.results.length + "; failures: " + failures.length);
process.exit(failures.length === 0 ? 0 : 1);
