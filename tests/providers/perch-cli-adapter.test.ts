// perch-cli adapter: outcome mapping on recorded `perch run --json` documents (perchai-cli 2.4.109,
// reduced to the fields the adapter reads), staging, argv, runTurn against a fake CLI, and the
// preload under a real Node against a local HTTP server. Nothing here starts Perch or reaches its API.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import * as A from "../../src/adapters/perch-cli/adapter";
import { PERCH_CLI_PROFILE } from "../../src/adapters/perch-cli/profiles";
import { buildCodeBuddyToolBridge } from "../../src/adapters/codebuddy/tool-bridge";
import { effectiveAdapterContract, getAdapterDefinition } from "../../src/adapters/registry";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { fixturePath, repoPath } from "../helpers/repo-root";

const fx = (name: string) => readFileSync(fixturePath("perch-cli", name), "utf8");
const NODE = Bun.which("node");

// A signed-in Perch (the adapter only checks that the sign-in file exists) and an installed CLI.
const FAKE_ROOT = mkdtempSync(join(tmpdir(), "ocx-perch-test-"));
const AUTH_DIR = join(FAKE_ROOT, "auth");
const FAKE_BIN = join(FAKE_ROOT, "perch");
mkdirSync(AUTH_DIR);
writeFileSync(join(AUTH_DIR, "cli-auth-session.json"), "{}");
writeFileSync(FAKE_BIN, "");
const savedAuthDir = process.env.PERCH_CLI_AUTH_DIR;
process.env.PERCH_CLI_AUTH_DIR = AUTH_DIR;
afterAll(() => {
  if (savedAuthDir === undefined) delete process.env.PERCH_CLI_AUTH_DIR; else process.env.PERCH_CLI_AUTH_DIR = savedAuthDir;
  rmSync(FAKE_ROOT, { recursive: true, force: true });
});
const fakeBridge = (server: string, requireToolCall = false) => ({
  tools: [{ name: "read_project_file", description: "Read a file.", inputSchema: {} }],
  emittedNameMap: new Map([[`mcp__${server}__read_project_file`, "read_project_file"], [`mcp__${server}__list_dir`, "list_dir"]]),
  requireToolCall,
});
const provider = { adapter: "perch-cli", baseUrl: "https://app.perchai.app", modelContextWindows: { "roost-standard": 200_000 } } as any;
const parsedWith = (over: any = {}) => ({
  modelId: "roost-standard", stream: true, options: { reasoning: "high" },
  context: {
    systemPrompt: ["You are Codex."],
    messages: [
      { role: "developer", content: "Be terse.", timestamp: 0 },
      { role: "user", content: "List src.", timestamp: 1 },
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "shell", arguments: { command: ["ls", "src"] } }], timestamp: 2 },
      { role: "toolResult", toolCallId: "call_1", toolName: "shell", content: "a.ts\nb.ts", timestamp: 3 },
    ],
    tools: [{ name: "shell", description: "Run a command", parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } } }, required: ["command"] } }],
    ...over,
  },
}) as any;
/** A minimal `perch run --json` document for synthetic cases. */
const run = (over: any) => JSON.stringify({ ok: false, runId: "tkt-cli-1", assistantText: "", events: [], contextSnapshot: { rows: [] }, ...over });

describe("perch-cli registry row", () => {
  test("the row and the adapter agree on the one destination, and every model is text-only", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "perch-cli")!;
    expect(entry.adapter).toBe("perch-cli");
    expect(entry.baseUrl).toBe(PERCH_CLI_PROFILE.canonicalBaseUrl);
    expect(entry.models).toContain(entry.defaultModel!);
    expect(entry.liveModels).toBe(false);
    for (const model of entry.models ?? []) expect(entry.modelContextWindows?.[model]).toBeGreaterThan(0);
    // Images reach these rows through the vision sidecar; the CLI path is text-only.
    expect(entry.noVisionModels).toEqual(entry.models ?? []);
    expect(providerConfigSeed(entry)).toMatchObject({ authMode: "key", keyOptional: true });
    expect(deriveProviderPresets().find(candidate => candidate.id === "perch-cli")).toMatchObject({ auth: "key", keyOptional: true });
  });
  test("published windows keep Codex compacting before the replay outgrows Perch's rule files", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "perch-cli")!;
    for (const window of Object.values(entry.modelContextWindows ?? {})) expect(window).toBeLessThanOrEqual(512_000);
  });
  test("the adapter inherits the shared coding-agent contract", () => {
    expect(getAdapterDefinition("perch-cli")?.contractParent).toBe("codebuddy");
    expect(effectiveAdapterContract("perch-cli").wire).toBe("codebuddy");
  });
});

describe("perchOutcome on recorded runs", () => {
  test("parallel bridge calls become tool calls; Perch's approval prompt is dropped", () => {
    const out = A.perchOutcome(fx("approval-parallel.json"), "", fakeBridge("ocx"));
    expect(out.kind).toBe("events");
    expect(out.events.filter((e: any) => e.type === "tool_call_start").map((e: any) => e.name)).toEqual(["read_project_file", "list_dir"]);
    expect(out.events.filter((e: any) => e.type === "tool_call_delta").map((e: any) => JSON.parse(e.arguments))).toEqual([{ path: "README.md" }, { path: "src" }]);
    expect(out.events.some((e: any) => e.type === "text_delta" && /Approve|允許/.test(e.text))).toBe(false);
    expect(out.events[0].type).toBe("thinking_delta");
    expect(out.events.at(-1)).toEqual({ type: "done", stopReason: "tool_use", endTurn: false, usage: { inputTokens: 14769 + 9408, outputTokens: 110, cachedInputTokens: 9408, cacheReadInputTokens: 9408, cacheCreationInputTokens: 0 } });
  });
  test("the model's preamble before a tool call is kept as text", () => {
    const out = A.perchOutcome(fx("approval-preamble.json"), "", fakeBridge("ocxprobe"));
    expect(out.events.find((e: any) => e.type === "text_delta")?.text).toBe("I'll read the README.md file for you.");
  });
  test("already-streamed text and reasoning are not repeated; a mirror that stopped early is completed", () => {
    const full = A.perchOutcome(fx("approval-preamble.json"), "", fakeBridge("ocxprobe")).events as any[];
    const text = full.find(e => e.type === "text_delta").text;
    const thinking = full.find(e => e.type === "thinking_delta")?.thinking ?? "";
    const out = A.perchOutcome(fx("approval-preamble.json"), "", fakeBridge("ocxprobe"), { text, thinking });
    expect(out.events.some((e: any) => e.type === "text_delta" || e.type === "thinking_delta")).toBe(false);
    expect(out.events.some((e: any) => e.type === "tool_call_start")).toBe(true);
    const rest = A.perchOutcome(fx("approval-preamble.json"), "", fakeBridge("ocxprobe"), { text: text.slice(0, 5), thinking }).events as any[];
    expect(rest.filter(e => e.type === "text_delta").map(e => e.text)).toEqual([text.slice(5)]);
  });
  test("Perch built-in tool use is a violation", () => {
    expect(A.perchOutcome(fx("native-tools.json"), "", fakeBridge("ocx"))).toMatchObject({ kind: "violation", tools: ["readLocalFile", "listLocalSources"] });
  });
  test("a bare name equal to a client tool is still a Perch built-in", () => {
    const doc = run({ status: "approval_required", events: [{ type: "tool_call_requested", toolName: "list_dir", toolCallId: "x", input: { edits: [] } }] });
    expect(A.perchOutcome(doc, "", fakeBridge("ocx"))).toMatchObject({ kind: "violation", tools: ["list_dir"] });
  });
  test("Perch's own error code outranks the unticketed fallback", () => {
    const doc = run({ status: "failed", runId: "cli-turn-1", events: [{ type: "turn_failed", errorCode: "provider_limit", error: "quota" }] });
    expect(A.perchOutcome(doc, "").events[0]).toMatchObject({ status: 429, code: "perch_cli_limit", retryable: false });
  });
  test("bridge calls in a run that did not stop for approval fail closed", () => {
    const doc = run({ status: "completed", assistantText: "done", events: [{ type: "tool_call_requested", toolName: "mcp__ocx__list_dir", toolCallId: "x", input: {} }], contextSnapshot: { rows: [{ id: "tool-schemas", status: "sent_raw", content: "mcp__ocx__list_dir" }] } });
    expect(A.perchOutcome(doc, "", fakeBridge("ocx")).events[0]).toMatchObject({ code: "tool_call_not_captured" });
  });
  test("a failed run reports its failure even when it also requested a built-in", () => {
    const doc = run({ status: "failed", events: [{ type: "tool_call_requested", toolName: "bash" }, { type: "turn_failed", errorCode: "provider_limit", error: "quota" }] });
    expect(A.perchOutcome(doc, "", fakeBridge("ocx")).events[0]).toMatchObject({ code: "perch_cli_limit" });
  });
  test("bearer tokens never reach an error message", () => {
    const doc = run({ status: "failed", events: [{ type: "turn_failed", error: "request failed: authorization: Bearer abc.DEF-123 rejected" }] });
    const message = (A.perchOutcome(doc, "").events[0] as any).message;
    expect(message).not.toContain("abc.DEF-123");
    expect(message).toContain("[redacted]");
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl";
    const other = (A.perchOutcome(run({ status: "failed", events: [{ type: "turn_failed", error: `refresh_token=r-secret-1 then ${jwt}` }] }), "").events[0] as any).message;
    expect(other).not.toContain("r-secret-1");
    expect(other).not.toContain(jwt);
  });
  test("completed text turn", () => {
    const out = A.perchOutcome(fx("completed.json"), "");
    expect(out.events[0]).toEqual({ type: "text_delta", text: "OK" });
    expect(out.events[1]).toMatchObject({ type: "done", stopReason: "end_turn", endTurn: true });
  });
  test("an unticketed run (keyless fallback) is retryable while signed in, and 401 once the sign-in file is gone", () => {
    const [err] = A.perchOutcome(fx("unticketed.json"), "").events;
    expect([err.status, err.code, err.retryable]).toEqual([503, "perch_cli_unavailable", true]);
    const saved = process.env.PERCH_CLI_AUTH_DIR;
    process.env.PERCH_CLI_AUTH_DIR = join(FAKE_ROOT, "no-auth-here");
    try {
      const [out] = A.perchOutcome(fx("unticketed.json"), "").events;
      expect([out.status, out.code, out.retryable]).toEqual([401, "perch_cli_not_logged_in", false]);
    } finally {
      process.env.PERCH_CLI_AUTH_DIR = saved;
    }
  });
  test("required tool call that never happened fails closed", () => {
    const loaded = run({ status: "completed", assistantText: "done", contextSnapshot: { rows: [{ id: "tool-schemas", status: "sent_raw", content: "mcp__ocx__read_project_file" }] } });
    expect(A.perchOutcome(loaded, "", fakeBridge("ocx", true)).events[0].code).toBe("tool_call_required");
    expect(A.perchOutcome(loaded, "", fakeBridge("ocx")).events[0]).toEqual({ type: "text_delta", text: "done" });
  });
});

describe("perchOutcome on every Perch status", () => {
  const failed = (errorCode: string, error = "x") => run({ status: "failed", events: [{ type: "turn_failed", error, errorCode }] });
  test("failed runs map Perch's errorCode", () => {
    const code = (doc: string) => { const e = A.perchOutcome(doc, "").events[0]; return [e.status, e.code, e.retryable]; };
    expect(code(failed("context_overflow"))).toEqual([400, "context_length_exceeded", false]);
    expect(code(failed("provider_limit"))).toEqual([429, "perch_cli_limit", false]);
    expect(code(failed("provider_transport"))).toEqual([503, "perch_cli_unavailable", true]);
    expect(code(failed("runtime_error"))).toEqual([502, "perch_cli_failed", false]);
    expect(code(failed("runtime_error", "Your plan's Perch turn rate limit has been reached."))).toEqual([429, "perch_cli_rate_limited", true]);
    expect(code(run({ status: "cancelled" }))).toEqual([499, "turn_aborted", false]);
    expect(code(run({ status: "blocked", error: "loop stopped" }))).toEqual([502, "perch_cli_blocked", false]);
    expect(code("")).toEqual([502, "perch_cli_failed", false]);
    expect(code(failed("runtime_error", "Please run perch login"))).toEqual([401, "perch_cli_not_logged_in", false]);
  });
  test("incomplete keeps Perch's text; a clarification ends the turn normally", () => {
    const out = A.perchOutcome(run({ status: "incomplete", assistantText: "Which file?", error: "clarification_required" }), "");
    expect(out.events).toEqual([{ type: "text_delta", text: "Which file?" }, { type: "done", stopReason: "end_turn", endTurn: true }]);
    // A turn Perch cut short reads as truncated, so Codex never installs it as a finished answer.
    const cut = A.perchOutcome(run({ status: "incomplete", assistantText: "Partial", error: "max_iterations" }), "");
    expect(cut.events.at(-1)).toMatchObject({ type: "done", stopReason: "max_tokens" });
  });
  test("compacted client rows fail closed instead of answering from a cut conversation", () => {
    const doc = run({ status: "completed", assistantText: "hi", contextSnapshot: { rows: [{ id: "project-perch-md", status: "sent_raw" }, { id: "project-rule-.perch\\rules\\20-conversation-01.md", status: "sent_compacted" }] } });
    expect(A.perchOutcome(doc, "").events[0].code).toBe("context_length_exceeded");
  });
  test("a bridge that Perch did not load fails closed", () => {
    const doc = run({ status: "completed", assistantText: "hi", contextSnapshot: { rows: [{ id: "tool-schemas", status: "sent_raw", content: "bash readLocalFile" }] } });
    expect(A.perchOutcome(doc, "", fakeBridge("ocx")).events[0].code).toBe("tool_bridge_init_missing");
  });
  test("a failed run reports its own failure, not a missing bridge", () => {
    // Recorded: startup timeout (no ticket) plus deferred MCP schemas; this was misread as tool_bridge_init_missing.
    const [err] = A.perchOutcome(fx("busy-deferred-bridge.json"), "", fakeBridge("opencodex")).events;
    expect(err.code).toBe("perch_cli_unavailable");
  });
  test("usage counts cache reads and writes as input, and adds across attempts", () => {
    expect(A.perchUsage({ inputTokens: 10, outputTokens: 2, cacheReadInputTokens: 5, cacheCreationInputTokens: 500 })).toEqual({ inputTokens: 515, outputTokens: 2, cachedInputTokens: 5, cacheReadInputTokens: 5, cacheCreationInputTokens: 500 });
    expect(A.addUsage({ inputTokens: 1, outputTokens: 1 }, { inputTokens: 2, outputTokens: 3, cachedInputTokens: 1 })).toEqual({ inputTokens: 3, outputTokens: 4, cachedInputTokens: 1 });
    expect(A.addUsage(undefined, { inputTokens: 2, outputTokens: 3 })).toEqual({ inputTokens: 2, outputTokens: 3 });
  });
});

describe("staging and argv", () => {
  test("chunkUtf8 never splits a character or exceeds the byte cap", () => {
    const text = "汉".repeat(50_000) + "x".repeat(10);
    const chunks = A.chunkUtf8(text, 60_000);
    expect(chunks.join("")).toBe(text);
    for (const c of chunks) expect(Buffer.byteLength(c)).toBeLessThanOrEqual(60_000);
  });
  test("invocation runs node directly with the heap flag, and with the preload only when enabled", () => {
    // npm's Windows shim: the bin script sits in node_modules beside it, and node.exe may sit next to it.
    const npmDir = join(FAKE_ROOT, "npm");
    mkdirSync(join(npmDir, "node_modules", "perchai-cli", "bin"), { recursive: true });
    writeFileSync(join(npmDir, "perch.cmd"), "");
    writeFileSync(join(npmDir, "node_modules", "perchai-cli", "bin", "perch"), "");
    const inv = A.perchInvocation(join(npmDir, "perch.cmd"), "win32", true)!;
    expect(inv.file).toBe("node");
    expect(inv.args[0]).toBe("--max-old-space-size=4096");
    expect(inv.args[1]).toMatch(/^--import=file:\/\/\/.*perch-cli\/preload\.mjs$/);
    expect(inv.args[2]).toMatch(/perchai-cli[\\/]bin[\\/]perch$/);
    expect(A.perchInvocation(join(FAKE_ROOT, "perch-missing"), "linux")).toBeUndefined();
    const linked = join(npmDir, "node_modules", "perchai-cli", "bin", "perch");
    expect(A.perchInvocation(linked, "linux", true)?.args[2]).toBe(linked);
    // Off by default: the CLI runs unmodified.
    expect(A.perchInvocation(linked, "linux", false)?.args).toEqual(["--max-old-space-size=4096", linked]);
    expect(A.perchPreloadEnabled({})).toBe(false);
    expect(A.perchPreloadEnabled({ OCX_PERCH_PRELOAD: "true" })).toBe(false);
    expect(A.perchPreloadEnabled({ OCX_PERCH_PRELOAD: "1" })).toBe(true);
    // A version-manager shim is run as is, with the flags in NODE_OPTIONS.
    const shim = A.perchInvocation(FAKE_BIN, "linux", true)!;
    expect([shim.file, shim.args]).toEqual([FAKE_BIN, []]);
    expect(shim.nodeOptions).toMatch(/^--max-old-space-size=4096 --import=file:/);
    const shimEnv = A.buildChildEnv("h", shim);
    expect(shimEnv.NODE_OPTIONS).toBe(shim.nodeOptions);
    expect(shimEnv.VOLTA_HOME).toBe(shim.voltaHome); // the staging HOME would hide volta's toolchain
    expect(A.buildChildEnv("h").VOLTA_HOME).toBeUndefined();
  });
  test("package-manager shims are read for the script they launch instead of assuming npm's layout", () => {
    const dir = join(FAKE_ROOT, "pnpm", "bin");
    const script = join(FAKE_ROOT, "pnpm", "global", "5", "node_modules", "perchai-cli", "bin", "perch");
    mkdirSync(dirname(script), { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(script, "");
    // pnpm's Windows and POSIX cmd-shim templates, npm 11's .cmd tail line, and cmd-shim's absolute form
    writeFileSync(join(dir, "perch.cmd"), `@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" "%~dp0\\..\\global\\5\\node_modules\\perchai-cli\\bin\\perch" %*\r\n) ELSE (\r\n  node "%~dp0\\..\\global\\5\\node_modules\\perchai-cli\\bin\\perch" %*\r\n)\r\n`);
    writeFileSync(join(dir, "perch"), `#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../global/5/node_modules/perchai-cli/bin/perch" "$@"\n`);
    writeFileSync(join(dir, "npm.cmd"), `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\..\\global\\5\\node_modules\\perchai-cli\\bin\\perch" %*\r\n`);
    writeFileSync(join(dir, "abs.cmd"), `@"node" "${script}" %*\r\n`);
    for (const shim of ["perch.cmd", "perch", "npm.cmd", "abs.cmd"]) expect(A.shimScript(join(dir, shim))).toBe(script);
    expect(A.perchInvocation(join(dir, "perch.cmd"), "win32")?.args.at(-1)).toBe(script);
    expect(A.perchInvocation(join(dir, "perch"), "linux", true)).toMatchObject({ file: "node", args: ["--max-old-space-size=4096", expect.stringMatching(/^--import=/), script] });
    writeFileSync(join(dir, "other.cmd"), `node "%~dp0\\node_modules\\my-perchai-cli\\bin\\perch" %*\r\n`);
    expect(A.shimScript(join(dir, "other.cmd"))).toBeUndefined(); // another package's script is not Perch's
    expect(A.shimScript(FAKE_BIN)).toBeUndefined(); // no script named: treated as a native launcher
  });
  test("args: tools pick agents mode, no tools pick ask; roost ids map to tiers; no effort without declared efforts", () => {
    expect(A.buildArgs(parsedWith(), provider, "W", "T", true, "P")).toEqual(["run", "P", "--json", "--mode", "agents", "--cwd", "W", "--thread", "T", "--model", "standard"]);
    expect(A.buildArgs(parsedWith(), provider, "W", "T", false, "P")).toContain("ask");
    const withEfforts = A.buildArgs({ ...parsedWith(), modelId: "roost-standard-max" }, { ...provider, reasoningEfforts: ["low", "high"] }, "W", "T", true, "P");
    expect(withEfforts.slice(-4)).toEqual(["--model", "standard-max", "--effort", "high"]);
  });
  test("cwd comes from the latest Codex environment context and reaches the argv prompt", () => {
    const parsed = parsedWith();
    parsed.context.messages.unshift({ role: "user", content: "<environment_context>\n<cwd>C:\\old</cwd>\n</environment_context>", timestamp: 0 });
    parsed.context.messages.splice(2, 0, { role: "user", content: [{ type: "text", text: "<environment_context><cwd>C:\\repo</cwd></environment_context>" }], timestamp: 1 });
    expect(A.clientWorkingDirectory(parsed)).toBe("C:\\repo");
    expect(A.clientWorkingDirectory(parsedWith())).toBeUndefined();
    const prompt = A.perchTurnPrompt("C:\\repo", true, "Fix it.");
    expect(prompt.startsWith(A.PERCH_TURN_PROMPT)).toBe(true);
    expect(prompt).toContain("C:\\repo");
    expect(prompt).toContain("mcp__opencodex__*");
    expect(prompt).toContain("Do not enter plan mode.");
    expect(prompt.endsWith("Fix it.")).toBe(true);
    expect(A.perchTurnPrompt(undefined, false)).not.toContain("mcp__");
  });
  test("child env isolates HOME, keeps the auth dir, skips the heap re-exec and opens the mirror fd", () => {
    const env = A.buildChildEnv("C:\\stage\\h");
    expect([env.HOME, env.USERPROFILE]).toEqual(["C:\\stage\\h", "C:\\stage\\h"]);
    expect(env.PERCH_CLI_AUTH_DIR).toBe(AUTH_DIR);
    expect(env.OCX_PERCH_CACHE_DIR).toBe(A.perchCacheDir());
    expect([env.PERCH_CLI_HEAP_REEXEC, env.PERCH_LANG, env.OCX_PERCH_STREAM_FD]).toEqual(["1", "en", "3"]);
  });
  test("a tool catalog over Perch's MCP deferral threshold keeps one-line descriptions; the full ones move to PERCH.md", async () => {
    // Codex's exec description is ~50 KB; on the 200K tier Perch would defer every MCP schema.
    const longDoc = `Runs a command.\n${"Detailed usage notes. ".repeat(2_500)}`;
    const parsed = parsedWith({ tools: [{ name: "exec", description: longDoc, parameters: { type: "object", properties: { cmd: { type: "string" } } } }] });
    const bridge = buildCodeBuddyToolBridge(parsed);
    expect(A.fitToolCatalog(bridge, 1_000_000).tools).toBe(bridge.tools);
    const fitted = A.fitToolCatalog(bridge, 200_000);
    expect(fitted.tools[0].description).toBe("Runs a command. (Full description: Client tool reference.)");
    expect(fitted.reference).toContain(`## mcp__opencodex__exec\n${longDoc}`);
    const stage = await A.stagePerchTurn(parsed, provider, bridge);
    try {
      expect(JSON.parse(readFileSync(join(stage.root, "catalog.json"), "utf8"))[0].description).toBe(fitted.tools[0].description);
      const instructions = readdirSync(join(stage.workspace, ".perch", "rules")).filter(f => f.startsWith("10-")).map(f => readFileSync(join(stage.workspace, ".perch", "rules", f), "utf8"));
      expect(readFileSync(join(stage.workspace, ".perch", "PERCH.md"), "utf8") + instructions.join("")).toContain("# Client tool reference");
    } finally {
      await rm(stage.root, { recursive: true, force: true, maxRetries: 10 });
    }
    const huge = { ...bridge, tools: Array.from({ length: 400 }, (_, i) => ({ ...bridge.tools[0], name: `t${i}`, inputSchema: { type: "object", properties: Object.fromEntries(Array.from({ length: 20 }, (_, j) => [`p${j}`, { type: "string", description: "x".repeat(40) }])) } })) };
    expect(() => A.fitToolCatalog(huge, 200_000)).toThrow(A.PerchToolCatalogTooLargeError);
  });
  test("stage writes PERCH.md, ordered rules, catalog and Perch-format mcp.json", async () => {
    const parsed = parsedWith();
    const bridge = buildCodeBuddyToolBridge(parsed);
    const stage = await A.stagePerchTurn(parsed, provider, bridge, ["bash", "readLocalFile"]);
    try {
      const dir = join(stage.workspace, ".perch");
      const perchMd = readFileSync(join(dir, "PERCH.md"), "utf8");
      for (const s of ["OpenCodex client session", "mcp__opencodex__", "called bash, readLocalFile", "- mcp__opencodex__shell: Run a command", "You are Codex.", "Be terse."]) expect(perchMd).toContain(s);
      const rules = readdirSync(join(dir, "rules"));
      expect(rules).toEqual(["20-conversation-01.md"]);
      const convo = readFileSync(join(dir, "rules", rules[0]), "utf8");
      // Perch does not sort rule files (ext4 lists them in hash order), so each one names its place.
      expect(convo.startsWith("[conversation part 01 of 1]\n# Replayed conversation")).toBe(true);
      expect(perchMd).toContain("read the parts of each series in part order");
      expect(convo).toContain("List src.");
      expect(convo).toContain("a.ts\nb.ts");
      expect(convo).not.toContain("Be terse.");
      const mcp = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
      expect(mcp.servers.opencodex.type).toBe("stdio");
      expect(mcp.servers.opencodex.args.at(-1)).toBe(join(stage.root, "catalog.json"));
      // Perch's seeded CourtListener server (npx, ~4 s) stays off in both the workspace and the staging-home config.
      for (const config of [mcp, JSON.parse(readFileSync(join(stage.home, ".perch", "mcp.json"), "utf8"))]) expect(config.servers.courtlistener.type).toBe("disabled");
      expect(stage.root.length).toBeLessThan(80);
    } finally {
      await rm(stage.root, { recursive: true, force: true });
    }
  });
  test("on a large window the replay is capped by the rule files' bytes, using the text's own bytes per character", () => {
    const wide = { ...provider, modelContextWindows: { "roost-standard": 512_000 } };
    const convo = (char: string) => parsedWith({ messages: [...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `${i} ${char.repeat(50_000)}`, timestamp: i })), { role: "user", content: "now", timestamp: 99 }], tools: [] });
    const english = A.projectConversation(convo("a"), wide, undefined, 1_000_000);
    const chinese = A.projectConversation(convo("中"), wide, undefined, 1_000_000);
    for (const text of [english, chinese]) {
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1_000_000);
      expect(Buffer.byteLength(text)).toBeGreaterThan(850_000); // the cut keeps whole messages, not a char-count worst case
      expect(text.endsWith("now")).toBe(true);
    }
    expect(english.length).toBeGreaterThan(chinese.length * 2.5);
    // A large current input is never cut, so the history gives up its bytes too.
    const bigInput = parsedWith({ messages: [...Array.from({ length: 30 }, (_, i) => ({ role: "user", content: `${i} ${"a".repeat(50_000)}`, timestamp: i })), { role: "user", content: `now ${"b".repeat(600_000)}`, timestamp: 99 }], tools: [] });
    const withInput = A.projectConversation(bigInput, wide, undefined, 1_000_000);
    expect(Buffer.byteLength(withInput)).toBeLessThanOrEqual(1_000_000);
    expect(withInput.endsWith("b".repeat(600_000))).toBe(true);
  });
  test("history is capped below the window minus Perch's overhead, and input past 40 rule files fails", async () => {
    const big = parsedWith({ messages: [{ role: "user", content: "y".repeat(150_000), timestamp: 1 }], tools: [] });
    const stage = await A.stagePerchTurn(big, provider, undefined);
    try {
      expect(readdirSync(join(stage.workspace, ".perch", "rules"))).toEqual(["20-conversation-01.md", "20-conversation-02.md", "20-conversation-03.md"]);
      expect(Object.keys(JSON.parse(readFileSync(join(stage.workspace, ".perch", "mcp.json"), "utf8")).servers)).toEqual(["courtlistener"]);
      expect(JSON.parse(readFileSync(join(stage.workspace, ".perch", "skills.json"), "utf8")).disabled).toContain("research");
    } finally {
      await rm(stage.root, { recursive: true, force: true });
    }
    const history = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `${i} ${"h".repeat(30_000)}`, timestamp: i }));
    const capped = A.projectConversation(parsedWith({ messages: [...history, { role: "user", content: "now", timestamp: 99 }], tools: [] }), provider, undefined, 2_000_000);
    expect(capped.length).toBeLessThan(600_000); // 200K window - 60K overhead, not the whole window
    const huge = parsedWith({ messages: [{ role: "user", content: "z".repeat(2_600_000), timestamp: 1 }], tools: [] });
    const stages = () => readdirSync(tmpdir()).filter(name => name.startsWith("ocxp-"));
    const before = stages();
    await expect(A.stagePerchTurn(huge, { ...provider, modelContextWindows: { "roost-standard": 4_000_000 } }, undefined)).rejects.toBeInstanceOf(A.PerchInputTooLargeError);
    expect(stages().filter(name => !before.includes(name))).toEqual([]); // a failed stage leaves nothing behind
  });
});

/** A fake `perch` child: the script writes the mirror lines and stdout, then closes. */
function fakeSpawn(script: (io: { stdout: PassThrough; mirror: PassThrough; close: () => void }, call: number) => void) {
  const calls: string[][] = [];
  const kills: number[] = [];
  const spawnFn = (_file: string, args: string[]) => {
    calls.push(args);
    const child: any = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const mirror = new PassThrough();
    child.stdio = [null, child.stdout, child.stderr, mirror];
    let closed = false;
    const close = () => { if (closed) return; closed = true; child.stdout.end(); mirror.end(); child.stderr.end(); setTimeout(() => child.emit("close", 0), 5); };
    child.kill = () => { kills.push(calls.length); close(); return true; };
    const n = calls.length;
    setTimeout(() => script({ stdout: child.stdout, mirror, close }, n), 5);
    return child;
  };
  return { spawnFn, calls, kills };
}
async function drive(spawnFn: any, opts: { parsed?: any; incoming?: any } = {}) {
  const adapter = A.createPerchCliAdapter(provider, { spawn: spawnFn, which: () => FAKE_BIN, heartbeatMs: 60_000 });
  const events: any[] = [];
  await adapter.runTurn(opts.parsed ?? parsedWith(), { headers: new Headers(), translatorBudget: {} as any, ...opts.incoming }, (e: any) => events.push(e));
  return events.filter(e => e.type !== "heartbeat");
}
const nativeRun = run({ status: "approval_required", events: [{ type: "tool_call_requested", toolName: "bash", toolCallId: "b", input: {} }] });
const bridgeRun = (usage: any) => run({ status: "approval_required", events: [{ type: "model_call_started" }, { type: "tool_call_requested", toolName: "mcp__opencodex__shell", toolCallId: "c1", input: { command: ["ls"] } }], contextSnapshot: { rows: [], turnApiUsage: usage } });

describe("runTurn with a fake CLI", () => {
  test("mirror deltas stream before exit and are not repeated from the final JSON", async () => {
    const { spawnFn } = fakeSpawn(({ stdout, mirror, close }) => {
      mirror.write('{"type":"reasoning_delta","text":"think"}\n{"type":"answer_delta","text":"Hel"}\n{"type":"answer_delta","text":"lo"}\n{"type":"model_call_done","model":"x/y"}\n');
      stdout.write(run({ status: "completed", assistantText: "Hello", events: [{ type: "model_call_started" }, { type: "content_delta", text: "Hello" }] }));
      close();
    });
    const events = await drive(spawnFn, { parsed: parsedWith({ tools: [] }) });
    expect(events.map(e => e.type)).toEqual(["thinking_delta", "text_delta", "text_delta", "done"]);
    expect(events.filter(e => e.type === "text_delta").map(e => e.text).join("")).toBe("Hello");
  });
  test("without the mirror the final JSON still carries the text", async () => {
    const { spawnFn } = fakeSpawn(({ stdout, close }) => { stdout.write(run({ status: "completed", assistantText: "Hello" })); close(); });
    expect((await drive(spawnFn, { parsed: parsedWith({ tools: [] }) })).map(e => e.type === "text_delta" ? e.text : e.type)).toEqual(["Hello", "done"]);
  });
  test("a built-in call is rerun once with a correction, and usage of both attempts is reported", async () => {
    const { spawnFn, calls } = fakeSpawn(({ stdout, close }, n) => {
      stdout.write(n === 1 ? run({ status: "approval_required", events: [{ type: "tool_call_requested", toolName: "bash", toolCallId: "b", input: {} }], contextSnapshot: { rows: [], turnApiUsage: { inputTokens: 100, outputTokens: 1 } } }) : bridgeRun({ inputTokens: 200, outputTokens: 2 }));
      close();
    });
    const events = await drive(spawnFn);
    expect(calls.length).toBe(2);
    expect(calls[1]!.join(" ")).toContain("A previous attempt called bash");
    expect(events.find(e => e.type === "tool_call_start")).toMatchObject({ name: "shell", id: "c1" });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", usage: { inputTokens: 300, outputTokens: 3 } });
  });
  test("a second violation fails closed with undeclared_tool_call", async () => {
    const { spawnFn, calls } = fakeSpawn(({ stdout, close }) => { stdout.write(nativeRun); close(); });
    const events = await drive(spawnFn);
    expect(calls.length).toBe(2);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "undeclared_tool_call" });
  });
  test("a built-in call after streamed output fails instead of appending a second answer", async () => {
    const { spawnFn, calls } = fakeSpawn(({ stdout, mirror, close }) => {
      mirror.write('{"type":"answer_delta","text":"Let me look."}\n');
      stdout.write(nativeRun);
      close();
    });
    const events = await drive(spawnFn);
    expect(calls.length).toBe(1);
    expect(events.map(e => e.type)).toEqual(["text_delta", "error"]);
    expect(events.at(-1)).toMatchObject({ code: "undeclared_tool_call" });
  });
  test("an abort between attempts ends the turn with the first attempt's usage", async () => {
    const controller = new AbortController();
    let producers = 0;
    const sendBudget = {
      beginSpendProducer: () => { if (++producers === 2) controller.abort(); return { close() {} }; },
      reserveDispatch: () => ({ allowed: true, permit: { use: () => true, release() {} } }),
    };
    const { spawnFn, calls } = fakeSpawn(({ stdout, close }) => {
      stdout.write(run({ status: "approval_required", events: [{ type: "tool_call_requested", toolName: "bash", toolCallId: "b", input: {} }], contextSnapshot: { rows: [], turnApiUsage: { inputTokens: 100, outputTokens: 1 } } }));
      close();
    });
    const events = await drive(spawnFn, { incoming: { sendBudget, abortSignal: controller.signal } });
    expect(calls.length).toBe(1);
    expect(events).toMatchObject([{ type: "error", status: 499, code: "turn_aborted", usage: { inputTokens: 100, outputTokens: 1 } }]);
  });
  test("a launch failure reported after spawn returns is a spawn failure", async () => {
    const spawnFn = () => {
      const child: any = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
      child.kill = () => true;
      setTimeout(() => child.emit("error", Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" })), 5);
      return child;
    };
    expect((await drive(spawnFn, { parsed: parsedWith({ tools: [] }) })).at(-1)).toMatchObject({ type: "error", status: 500, code: "cli_spawn_failed" });
  });
  test("a failure after a rerun still reports the usage of every attempt", async () => {
    const { spawnFn } = fakeSpawn(({ stdout, close }) => {
      stdout.write(run({ status: "approval_required", events: [{ type: "tool_call_requested", toolName: "bash", toolCallId: "b", input: {} }], contextSnapshot: { rows: [], turnApiUsage: { inputTokens: 100, outputTokens: 1 } } }));
      close();
    });
    expect((await drive(spawnFn)).at(-1)).toMatchObject({ type: "error", code: "undeclared_tool_call", usage: { inputTokens: 200, outputTokens: 2 } });
  });
  test("mirrored text is tracked per model call, and the final JSON completes a mirror that stopped early", async () => {
    const { spawnFn } = fakeSpawn(({ stdout, mirror, close }) => {
      mirror.write('{"type":"model_call_start"}\n{"type":"answer_delta","text":"Hel"}\n');
      stdout.write(run({ status: "completed", assistantText: "Hello", events: [{ type: "model_call_started" }] }));
      close();
    });
    const events = await drive(spawnFn, { parsed: parsedWith({ tools: [] }) });
    expect(events.filter(e => e.type === "text_delta").map(e => e.text)).toEqual(["Hel", "lo"]);
  });
  test("no budget for the corrective rerun reports the violation and withholds recovery", async () => {
    const { spawnFn, calls } = fakeSpawn(({ stdout, close }) => { stdout.write(nativeRun); close(); });
    const withheld: any[] = [];
    let reserved = 0;
    const sendBudget = { reserveDispatch: () => (++reserved === 1 ? { allowed: true, permit: { use: () => true, release() {} } } : { allowed: false }) };
    const events = await drive(spawnFn, { incoming: { sendBudget, onRecoveryWithheld: (w: any) => withheld.push(w) } });
    expect(calls.length).toBe(1);
    expect(withheld).toEqual([{ reason: "retry-send-budget" }]);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "undeclared_tool_call" });
  });
  test("a run that could not reach Perch's hosted models is retried once as a transient send", async () => {
    const unticketed = run({ status: "failed", runId: "cli-turn-1", events: [{ type: "turn_failed", error: "The model is busy right now." }] });
    const classes: string[] = [];
    const sendBudget = { reserveDispatch: (d: any) => { classes.push(d.sendClass); return { allowed: true, permit: { use: () => true, release() {} } }; } };
    const { spawnFn, calls } = fakeSpawn(({ stdout, close }, n) => { stdout.write(n === 1 ? unticketed : run({ status: "completed", assistantText: "Hi" })); close(); });
    const sends: any[] = [];
    const events = await drive(spawnFn, { parsed: parsedWith({ tools: [] }), incoming: { sendBudget, onPhysicalSend: (send: any) => sends.push(send) } });
    expect(calls.length).toBe(2);
    expect(classes).toEqual(["initial", "transient"]);
    expect(A.createPerchCliAdapter(provider).reportsPhysicalSends).toBe(true);
    expect(sends).toEqual([{ ordinal: 1 }, { ordinal: 2, recovery: "transient-5xx" }]);
    expect(events.map(e => e.type === "text_delta" ? e.text : e.type)).toEqual(["Hi", "done"]);
    // A second failure is reported, and without budget the first one is.
    const twice = fakeSpawn(({ stdout, close }) => { stdout.write(unticketed); close(); });
    expect((await drive(twice.spawnFn, { parsed: parsedWith({ tools: [] }) })).at(-1)).toMatchObject({ type: "error", code: "perch_cli_unavailable" });
    expect(twice.calls.length).toBe(2);
  });
  test("output already streamed is never followed by a retry", async () => {
    const { spawnFn, calls } = fakeSpawn(({ stdout, mirror, close }) => {
      mirror.write('{"type":"answer_delta","text":"partial"}\n');
      stdout.write(run({ status: "failed", runId: "tkt-cli-1", events: [{ type: "turn_failed", errorCode: "provider_transport", error: "socket hang up" }] }));
      close();
    });
    const events = await drive(spawnFn, { parsed: parsedWith({ tools: [] }) });
    expect(calls.length).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "perch_cli_unavailable", retryable: true });
  });
  test("an abort before start spawns nothing; an abort mid-run kills the CLI and reports turn_aborted", async () => {
    const first = fakeSpawn(() => {});
    const aborted = new AbortController();
    aborted.abort();
    expect(await drive(first.spawnFn, { incoming: { abortSignal: aborted.signal } })).toMatchObject([{ type: "error", message: "Perch CLI turn was aborted before start." }]);
    expect(first.calls.length).toBe(0);
    const later = new AbortController();
    const second = fakeSpawn(() => { setTimeout(() => later.abort(), 20); });
    expect(await drive(second.spawnFn, { incoming: { abortSignal: later.signal } })).toMatchObject([{ type: "error", status: 499, code: "turn_aborted" }]);
    expect(second.kills.length).toBe(1);
  });
  test("a CLI that never exits is killed at the timeout and reported as retryable", async () => {
    const { spawnFn, kills } = fakeSpawn(() => {});
    const adapter = A.createPerchCliAdapter(provider, { spawn: spawnFn, which: () => FAKE_BIN, heartbeatMs: 60_000, timeoutMs: 50 });
    const events: any[] = [];
    await adapter.runTurn(parsedWith({ tools: [] }), { headers: new Headers(), translatorBudget: {} as any }, (e: any) => events.push(e));
    expect(kills.length).toBe(1);
    expect(events.at(-1)).toMatchObject({ type: "error", code: "timeout", retryable: true });
  });
});

describe.skipIf(!NODE)("preload under Node", () => {
  test("drops turn uploads locally and mirrors model-call deltas to fd 3 without changing the CLI's stream", async () => {
    const server = createServer((req, res) => {
      if (req.url?.startsWith("/api/perch-terminal/model-call")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(': keepalive\n\ndata: {"type":"reasoning_delta","text":"r"}\n\ndata: {"type":"answer_delta","text":"A"}\n\ndata: {"type":"done","model":"vendor/m-1"}\n\n');
      } else {
        res.writeHead(500).end("upload reached the network");
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const dir = mkdtempSync(join(tmpdir(), "ocxp-test-"));
    const script = join(dir, "client.mjs");
    writeFileSync(script, [
      `const up = await fetch("${base}/api/perch-terminal/cli-turn", { method: "POST", body: "{}" });`,
      `const learn = await fetch("${base}/api/perch-terminal/cli-learning", { method: "POST" });`,
      `const mc = await fetch("${base}/api/perch-terminal/model-call", { method: "POST" });`,
      `const body = await mc.text();`,
      `await new Promise(r => setTimeout(r, 100));`,
      `console.log(JSON.stringify({ up: up.status, upBody: await up.text(), learn: learn.status, sawDone: body.includes('"done"') }));`,
    ].join("\n"));
    const preload = pathToFileURL(repoPath("src", "adapters", "perch-cli", "preload.mjs")).href;
    const child = spawn(NODE!, [`--import=${preload}`, script], { env: { ...process.env, OCX_PERCH_STREAM_FD: "3" }, stdio: ["ignore", "pipe", "pipe", "pipe"] });
    let out = "", mirror = "", err = "";
    child.stdout!.on("data", d => { out += d; });
    child.stderr!.on("data", d => { err += d; });
    (child.stdio[3] as any).on("data", (d: Buffer) => { mirror += d; });
    await new Promise(resolve => child.on("close", resolve));
    server.close();
    await rm(dir, { recursive: true, force: true });
    expect(err).toBe("");
    expect(JSON.parse(out)).toEqual({ up: 200, upBody: '{"ok":true}', learn: 200, sawDone: true });
    expect(mirror.trim().split("\n").map(l => JSON.parse(l))).toEqual([
      { type: "model_call_start" },
      { type: "reasoning_delta", text: "r" },
      { type: "answer_delta", text: "A" },
      { type: "model_call_done", model: "vendor/m-1" },
    ]);
  });
  test("startup lookups are served from token-keyed caches; memories never reach the turn", async () => {
    const hits: Record<string, number> = {};
    const server = createServer((req, res) => {
      const path = req.url!.split("?")[0]!;
      hits[path] = (hits[path] ?? 0) + 1;
      const body = path.endsWith("public-model-default") ? { ok: true, selection: { chatModelId: "m" } }
        : path.endsWith("cli-context") ? { ok: true, session: { userId: "u1" }, permanentMemories: [{ id: "m" }], attachments: [{ id: "a" }] }
        : { ok: true, session: { planCode: "starter" }, usageMeter: null };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as any).port}`;
    const dir = mkdtempSync(join(tmpdir(), "ocxp-test-"));
    const script = join(dir, "client.mjs");
    writeFileSync(script, [
      "const auth = { Authorization: process.argv[2] };",
      `const dm = await (await fetch("${base}/api/perch-terminal/public-model-default")).json();`,
      `const ctx = await (await fetch("${base}/api/perch-terminal/cli-context", { method: "POST", headers: auth, body: "{}" })).json();`,
      `const acct = await (await fetch("${base}/api/perchai/account", { headers: auth })).json();`,
      "console.log(JSON.stringify({ dm, ctx, acct }));",
    ].join("\n"));
    const preload = pathToFileURL(repoPath("src", "adapters", "perch-cli", "preload.mjs")).href;
    const runOnce = async (token: string) => {
      const child = spawn(NODE!, [`--import=${preload}`, script, token], {
        env: { ...process.env, OCX_PERCH_CACHE_DIR: dir, OCX_PERCH_DEFAULT_MODEL_URL: `${base}/api/perch-terminal/public-model-default` },
      });
      let out = "";
      child.stdout!.on("data", d => { out += d; });
      await new Promise(resolve => child.on("close", resolve));
      return JSON.parse(out);
    };
    const count = (suffix: string) => Object.entries(hits).filter(([p]) => p.endsWith(suffix)).reduce((n, [, c]) => n + c, 0);
    const first = await runOnce("Bearer a");
    expect(first.ctx).toEqual({ ok: true, session: { userId: "u1" }, permanentMemories: [], attachments: [] });
    expect(first.acct.session.planCode).toBe("starter");
    expect(first.dm.selection.chatModelId).toBe("m");
    expect([count("public-model-default"), count("cli-context"), count("account")]).toEqual([1, 1, 1]);
    const again = await runOnce("Bearer a");
    expect(again).toEqual(first);
    expect([count("public-model-default"), count("cli-context"), count("account")]).toEqual([1, 1, 1]); // all local
    for (const name of readdirSync(dir).filter(f => f.endsWith(".json"))) expect(readFileSync(join(dir, name), "utf8")).not.toContain("Bearer");
    await runOnce("Bearer b"); // another sign-in reads none of the first one's entries
    expect([count("cli-context"), count("account")]).toEqual([2, 2]);
    // An account entry past 10 min and a default-model entry past 6 h are fetched again.
    for (const [name, ageMs] of [["account.json", 11 * 60_000], ["public-model-default.json", 7 * 3_600_000]] as const) {
      const entry = JSON.parse(readFileSync(join(dir, name), "utf8"));
      writeFileSync(join(dir, name), JSON.stringify({ ...entry, at: Date.now() - ageMs }));
    }
    await runOnce("Bearer b");
    expect([count("public-model-default"), count("account"), count("cli-context")]).toEqual([2, 3, 2]);
    server.close();
    await rm(dir, { recursive: true, force: true });
  });
});
