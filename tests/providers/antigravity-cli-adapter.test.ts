import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  buildAntigravityHooksConfig,
  buildAntigravitySettings,
  buildArgs,
  buildChildEnv,
  createAntigravityCliAdapter,
  type SpawnFn,
} from "../../src/adapters/antigravity-cli/adapter";
import {
  evaluateAntigravityPreToolInput,
  runAntigravityPreToolGuard,
} from "../../src/adapters/antigravity-cli/pretool-guard";
import {
  ANTIGRAVITY_CLI_DEFAULT_MODEL,
  ANTIGRAVITY_CLI_MODELS,
  ANTIGRAVITY_CLI_PROFILE,
  clearAntigravityCliBinaryCache,
  findAntigravityCliBinary,
  resolveAntigravityCliModelSlug,
} from "../../src/adapters/antigravity-cli/profiles";
import {
  ANTIGRAVITY_BRIDGE_AGENT_NAME,
  ANTIGRAVITY_MCP_SERVER_NAME,
  ANTIGRAVITY_MCP_TOOL_PREFIX,
  buildAntigravityAgentMarkdown,
  buildAntigravityCliConversationInput,
  buildAntigravityCliToolBridge,
  classifyAntigravityCliError,
  createAntigravityStreamState,
  extractAntigravityStagedImages,
  mapAntigravityStreamFrame,
  sanitizeAntigravitySystemText,
  stripAntigravityBillingHeader,
  usageFromAntigravityRecord,
} from "../../src/adapters/antigravity-cli/protocol";
import { effectiveAdapterContract, getAdapterDefinition } from "../../src/adapters/registry";
import { SendBudgetExhaustedError } from "../../src/lib/upstream-retry";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { disjointTelemetryTokens } from "../../src/telemetry/aggregate";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

const enc = new TextEncoder();

beforeEach(() => clearAntigravityCliBinaryCache());

interface FakeChild extends EventEmitter {
  pid?: number;
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
  written: string[];
}

function fakeChild(
  lines: string[],
  opts: { stderr?: string; exitCode?: number; emitClose?: boolean; pid?: number } = {},
): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = opts.pid ?? 42424;
  child.stdout = Readable.from(lines.map(line => enc.encode(`${line}\n`)));
  child.stderr = Readable.from(opts.stderr ? [enc.encode(opts.stderr)] : []);
  child.written = [];
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      child.written.push(String(chunk));
      cb();
    },
  });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    if (child.exitCode === null) {
      child.exitCode = opts.exitCode ?? 0;
      queueMicrotask(() => child.emit("close", child.exitCode));
    }
    return true;
  };
  if (opts.emitClose !== false) {
    setTimeout(() => {
      if (child.exitCode === null) {
        child.exitCode = opts.exitCode ?? 0;
        child.emit("close", child.exitCode);
      }
    }, 3);
  }
  return child;
}

/** Realistic tool-bridge child that stays parked on CallTool until killed. */
function parkedFakeChild(lines: string[], pid = 51515): FakeChild {
  const child = new EventEmitter() as FakeChild;
  const stdout = new PassThrough();
  for (const line of lines) stdout.write(`${line}\n`);
  child.pid = pid;
  child.stdout = stdout;
  child.stderr = Readable.from([]);
  child.written = [];
  child.stdin = new Writable({
    write(chunk, _enc, cb) {
      child.written.push(String(chunk));
      cb();
    },
  });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => {
    child.killed = true;
    stdout.end();
    if (child.exitCode === null) {
      child.exitCode = 143;
      queueMicrotask(() => child.emit("close", 143));
    }
    return true;
  };
  return child;
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "antigravity-cli",
    baseUrl: ANTIGRAVITY_CLI_PROFILE.canonicalBaseUrl,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    ...overrides,
  } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "gemini-4-carbon",
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    ...overrides,
  } as OcxParsedRequest;
}

function incoming(abortSignal?: AbortSignal) {
  return {
    headers: new Headers(),
    translatorBudget: createTestTranslatorBudget(),
    ...(abortSignal ? { abortSignal } : {}),
  };
}

async function run(
  adapter: ReturnType<typeof createAntigravityCliAdapter>,
  req: OcxParsedRequest,
  meta = incoming(),
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(req, meta, event => events.push(event));
  return events;
}

const BRIDGED_READ_TOOL = `${ANTIGRAVITY_MCP_TOOL_PREFIX}read_file`;

function toolRequest(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return parsed({
    context: {
      messages: [{ role: "user", content: "Read README.md", timestamp: 0 }],
      tools: [{
        name: "read_file",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      }],
    },
    ...overrides,
  });
}

describe("antigravity-cli registry and model ladder", () => {
  test("publishes only gemini-4-carbon, gemini-4-argon, and gemini-4-hydrogen as a keyless CLI provider", () => {
    const entry = PROVIDER_REGISTRY.find(row => row.id === "antigravity-cli");
    expect(entry).toBeDefined();
    expect(entry?.adapter).toBe("antigravity-cli");
    expect(entry?.authKind).toBe("key");
    expect(entry?.keyOptional).toBe(true);
    expect(entry?.liveModels).toBe(false);
    expect(entry?.defaultModel).toBe(ANTIGRAVITY_CLI_DEFAULT_MODEL);
    expect(entry?.models).toEqual(["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"]);
    expect(entry?.noVisionModels).toBeUndefined();
    expect(entry?.modelInputModalities).toEqual({
      "gemini-4-carbon": ["text", "image"],
      "gemini-4-argon": ["text", "image"],
      "gemini-4-hydrogen": ["text", "image"],
    });
    expect(entry?.modelReasoningEfforts).toEqual({
      "gemini-4-carbon": ["low", "medium", "high"],
      "gemini-4-argon": ["low", "medium", "high"],
      "gemini-4-hydrogen": ["low", "medium", "high", "xhigh"],
    });
    expect(entry?.modelDefaultReasoningEfforts).toEqual({
      "gemini-4-carbon": "medium",
      "gemini-4-argon": "medium",
      "gemini-4-hydrogen": "high",
    });

    const seed = providerConfigSeed(entry!);
    expect(seed.keyOptional).toBe(true);
    expect(deriveProviderPresets(PROVIDER_REGISTRY).some(preset => preset.id === "antigravity-cli")).toBe(true);
    expect(getAdapterDefinition("antigravity-cli")?.contractParent).toBe("codebuddy");
    expect(effectiveAdapterContract("antigravity-cli").wire).toBe("codebuddy");
  });

  test("resolves exact CLI --model slugs across Carbon, Argon, and Hydrogen effort ladders and rejects other models", () => {
    const prov = provider();
    expect(ANTIGRAVITY_CLI_MODELS).toEqual(["gemini-4-carbon", "gemini-4-argon", "gemini-4-hydrogen"]);

    // Carbon: default medium, clamps xhigh/max -> high and none/minimal -> low
    expect(resolveAntigravityCliModelSlug("gemini-4-carbon", prov)).toBe("gemini-4-carbon-medium");
    expect(resolveAntigravityCliModelSlug("gemini-4-carbon", prov, "none")).toBe("gemini-4-carbon-low");
    expect(resolveAntigravityCliModelSlug("gemini-4-carbon", prov, "minimal")).toBe("gemini-4-carbon-low");
    expect(resolveAntigravityCliModelSlug("gemini-4-carbon", prov, "low")).toBe("gemini-4-carbon-low");
    expect(resolveAntigravityCliModelSlug("gemini-4-carbon", prov, "medium")).toBe("gemini-4-carbon-medium");
    expect(resolveAntigravityCliModelSlug("gemini-4-carbon", prov, "high")).toBe("gemini-4-carbon-high");
    expect(resolveAntigravityCliModelSlug("gemini-4-carbon", prov, "xhigh")).toBe("gemini-4-carbon-high");
    expect(resolveAntigravityCliModelSlug("gemini-4-carbon-high", prov)).toBeUndefined();
    expect(resolveAntigravityCliModelSlug("gemini-4-carbon-xhigh", prov)).toBeUndefined();
    expect(resolveAntigravityCliModelSlug("gemini-4-hydrogen-xhigh", prov)).toBeUndefined();

    // Argon: default medium, prototype-pollution-safe custom effort map
    expect(resolveAntigravityCliModelSlug("gemini-4-argon", prov)).toBe("gemini-4-argon-medium");
    expect(resolveAntigravityCliModelSlug("gemini-4-argon", prov, "low")).toBe("gemini-4-argon-low");
    expect(resolveAntigravityCliModelSlug("gemini-4-argon", prov, "high")).toBe("gemini-4-argon-high");
    expect(
      resolveAntigravityCliModelSlug(
        "gemini-4-argon",
        provider({ modelReasoningEffortMap: { "gemini-4-argon": { high: "toString" } } }),
        "high",
      ),
    ).toBe("gemini-4-argon-medium");

    // Hydrogen: default high, supports xhigh
    expect(resolveAntigravityCliModelSlug("gemini-4-hydrogen", prov)).toBe("gemini-4-hydrogen-high");
    expect(resolveAntigravityCliModelSlug("gemini-4-hydrogen", prov, "low")).toBe("gemini-4-hydrogen-low");
    expect(resolveAntigravityCliModelSlug("gemini-4-hydrogen", prov, "medium")).toBe("gemini-4-hydrogen-medium");
    expect(resolveAntigravityCliModelSlug("gemini-4-hydrogen", prov, "high")).toBe("gemini-4-hydrogen-high");
    expect(resolveAntigravityCliModelSlug("gemini-4-hydrogen", prov, "xhigh")).toBe("gemini-4-hydrogen-xhigh");
    expect(resolveAntigravityCliModelSlug("gemini-4-hydrogen", prov, "max")).toBe("gemini-4-hydrogen-xhigh");

    // Non-permitted models fail closed
    for (const forbidden of ["gemini-3.8-flash", "gemini-3.7-flash", "claude-sonnet-5-5", "__proto__", "toString"]) {
      expect(resolveAntigravityCliModelSlug(forbidden, prov)).toBeUndefined();
    }
  });

  test("discovers agy on PATH first, then Windows LocalAppData and POSIX ~/.local/bin", () => {
    expect(findAntigravityCliBinary("agy", () => "/usr/local/bin/agy", "/home/u", "linux")).toBe("/usr/local/bin/agy");
    expect(
      findAntigravityCliBinary(
        "agy",
        () => undefined,
        "C:\\fake-home",
        "win32",
        "C:\\fake-home\\AppData\\Local",
        path => path === "C:\\fake-home\\AppData\\Local\\agy\\bin\\agy.exe",
      ),
    ).toBe("C:\\fake-home\\AppData\\Local\\agy\\bin\\agy.exe");
    expect(
      findAntigravityCliBinary(
        "agy",
        () => undefined,
        "/opt/fake-home",
        "darwin",
        undefined,
        path => path === "/opt/fake-home/.local/bin/agy",
      ),
    ).toBe("/opt/fake-home/.local/bin/agy");
  });
});

describe("antigravity-cli PreToolUse guard and staging isolation", () => {
  test("PreToolUse guard allows only exact isolated MCP catalog tools or staged .ocx-images/* reads and fails closed on internal errors", async () => {
    expect(evaluateAntigravityPreToolInput('{"toolCall":{"name":"view_file"}}', new Set())).toEqual({
      decision: "deny",
      reason: "Tools are disabled for this turn.",
    });

    const allowed = new Set([BRIDGED_READ_TOOL]);
    expect(evaluateAntigravityPreToolInput(JSON.stringify({ toolCall: { name: BRIDGED_READ_TOOL } }), allowed)).toEqual({
      decision: "allow",
    });
    for (const blocked of ["view_file", "run_command", "call_mcp_tool", "mcp_fastctx_run", "read_file"]) {
      const verdict = evaluateAntigravityPreToolInput(JSON.stringify({ toolCall: { name: blocked } }), allowed);
      expect(verdict.decision).toBe("deny");
      expect(verdict.reason ?? "").not.toMatch(/opencodex/i);
    }
    expect(evaluateAntigravityPreToolInput("{not-json", allowed).decision).toBe("deny");

    const dir = mkdtempSync(join(tmpdir(), "ocx-agy-guard-test-"));
    try {
      const imagesDir = join(dir, ".ocx-images");
      mkdirSync(imagesDir, { recursive: true });
      const stagedImg = join(imagesDir, "img-0.png");
      writeFileSync(stagedImg, Buffer.from([137, 80, 78, 71]));

      const allowFile = join(dir, "allowed.json");
      writeFileSync(allowFile, JSON.stringify({
        tools: [BRIDGED_READ_TOOL],
        imagePaths: [stagedImg],
        turnDir: dir,
      }));

      // Exact staged image read with `agy` runtime metadata (`toolSummary` / `toolAction`) is permitted
      const outAllow: string[] = [];
      await runAntigravityPreToolGuard(
        allowFile,
        Readable.from([JSON.stringify({
          toolCall: {
            name: "read_file",
            args: { Path: stagedImg, toolSummary: "Inspect image", toolAction: "Inspecting image" },
          },
        })]),
        text => outAllow.push(text),
      );
      expect(JSON.parse(outAllow.join(""))).toEqual({ decision: "allow" });

      // Line-slicing args (`StartLine`), dual-path escape (`Path` staged + `AbsolutePath` settings.json), non-staged workspace files, and traversals fail closed
      for (const badArgs of [
        { Path: stagedImg, StartLine: 1 },
        { Path: stagedImg, ContentOffset: 0 },
        { Path: stagedImg, AbsolutePath: join(dir, "settings.json") },
        { Path: join(dir, "settings.json"), AbsolutePath: stagedImg },
        { Path: join(dir, "settings.json") },
        { Path: join(dir, ".ocx-images", "..", "allowed.json") },
        { Path: stagedImg, UnexpectedKey: true },
      ]) {
        const outDeny: string[] = [];
        await runAntigravityPreToolGuard(
          allowFile,
          Readable.from([JSON.stringify({ toolCall: { name: "read_file", args: badArgs } })]),
          text => outDeny.push(text),
        );
        expect(JSON.parse(outDeny.join("")).decision).toBe("deny");
      }

      // Internal stream failure inside guard still exits 0 and emits fail-closed deny JSON
      const outInternalErr: string[] = [];
      const brokenStdin = {
        async *[Symbol.asyncIterator](): AsyncGenerator<string> {
          yield '{"toolCall":';
          throw new Error("simulated stdin read crash");
        },
      };
      const exitCode = await runAntigravityPreToolGuard(allowFile, brokenStdin, text => outInternalErr.push(text));
      expect(exitCode).toBe(0);
      expect(JSON.parse(outInternalErr.join(""))).toEqual({
        decision: "deny",
        reason: "PreToolUse guard internal error.",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("settings, custom agent frontmatter, hooks, scoped env, auth classifier, and third-party identity sanitizer satisfy isolation invariants", () => {
    const noToolSettings = buildAntigravitySettings("/tmp/turn-0");
    expect((noToolSettings.permissions as { deny: string[] }).deny).toContain("mcp(*)");
    expect((noToolSettings.permissions as { deny: string[] }).deny).toContain("read_file(*)");

    const imageSettings = buildAntigravitySettings("/tmp/turn-img", undefined, true);
    expect((imageSettings.permissions as { allow: string[] }).allow).toEqual(["read_file(.ocx-images/*)"]);
    expect((imageSettings.permissions as { deny: string[] }).deny).toEqual(
      expect.arrayContaining([
        "read_file(settings.json)",
        "read_file(allowed-tools.json)",
        "read_file(catalog.json)",
        "read_file(captured-calls.jsonl)",
        "read_file(.agents/*)",
        "mcp(*)",
      ]),
    );

    const bridgeStub = {
      serverName: ANTIGRAVITY_MCP_SERVER_NAME,
      tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
      emittedNameMap: new Map([[BRIDGED_READ_TOOL, "read_file"]]),
      maxTurnToolCalls: 16,
      requireToolCall: false,
    };
    const settings = buildAntigravitySettings("/tmp/turn-1", bridgeStub);
    expect(settings.trustedWorkspaces).toEqual(["/tmp/turn-1"]);
    expect(settings.toolPermission).toBe("request-review");
    expect(Object.keys(settings.permissions as Record<string, unknown>).sort()).toEqual(["allow", "deny"]);
    expect((settings.permissions as { allow: string[] }).allow).toEqual([`mcp(${ANTIGRAVITY_MCP_SERVER_NAME}/*)`]);
    expect((settings.permissions as { deny: string[] }).deny).not.toContain("mcp(*)");

    const agentMd = buildAntigravityAgentMarkdown(
      parsed({
        options: {
          textFormat: {
            type: "json_schema",
            name: "ans",
            schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
          },
        },
      }),
      {
        toolBridge: bridgeStub,
        hasStagedImages: true,
        mcpServer: { command: "/bin/bun", args: ["/app/mcp-server.ts", "/tmp/catalog.json"] },
      },
    );
    expect(agentMd).toContain(`name: ${ANTIGRAVITY_BRIDGE_AGENT_NAME}`);
    expect(agentMd).toContain("description: Isolated stateless turn bridge");
    expect(agentMd).not.toMatch(/opencodex/i);
    expect(agentMd).toContain("mainAgent: true");
    expect(agentMd).toContain("subagent: false");
    expect(agentMd).toContain("inheritCustomizations: true");
    expect(agentMd).toContain("inheritMcp: false");
    expect(agentMd).toContain('tools: ["view_file"]');
    expect(agentMd).toContain(`mcpServers:\n  - name: "${ANTIGRAVITY_MCP_SERVER_NAME}"`);
    expect(agentMd).toContain("eager: true");
    expect(agentMd).toContain("[Final response format]");
    expect(agentMd).toContain('"required":["ok"]');

    const winHooks = buildAntigravityHooksConfig("win32", false) as {
      "ocx-pretool-guard": { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
    };
    expect(winHooks["ocx-pretool-guard"].PreToolUse[0]?.hooks[0]?.command).toBe('if 1==1 "%OCX_AGY_EXEC%" "%OCX_AGY_GUARD%" "%OCX_AGY_ALLOWED%"');
    const winStandaloneHooks = buildAntigravityHooksConfig("win32", true) as typeof winHooks;
    expect(winStandaloneHooks["ocx-pretool-guard"].PreToolUse[0]?.hooks[0]?.command).toBe('if 1==1 "%OCX_AGY_EXEC%" __antigravity-hook "%OCX_AGY_ALLOWED%"');
    const posixHooks = buildAntigravityHooksConfig("linux", true) as typeof winHooks;
    expect(posixHooks["ocx-pretool-guard"].PreToolUse[0]?.hooks[0]?.command).toBe('"$OCX_AGY_EXEC" __antigravity-hook "$OCX_AGY_ALLOWED"');

    const prevAnthropic = process.env.ANTHROPIC_BASE_URL;
    const prevProxy = process.env.HTTPS_PROXY;
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9999";
    process.env.HTTPS_PROXY = "http://evil.invalid:8080";
    try {
      const env = buildChildEnv({
        execPath: "/bin/bun",
        guardPath: "/app/pretool-guard.ts",
        allowedToolsPath: "/tmp/allowed.json",
      });
      expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.HTTPS_PROXY).toBeUndefined();
      expect(env.OCX_AGY_EXEC).toBe("/bin/bun");
      expect(env.OCX_AGY_ALLOWED).toBe("/tmp/allowed.json");
    } finally {
      if (prevAnthropic === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = prevAnthropic;
      if (prevProxy === undefined) delete process.env.HTTPS_PROXY;
      else process.env.HTTPS_PROXY = prevProxy;
    }

    // #2899 & third-party SDK/subagent identity sanitization across \n\n, single \n, \r\n, and inline sentences
    expect(
      stripAntigravityBillingHeader(
        "x-anthropic-billing-header: cc_version=2.1.88\n\nYou are a Claude agent, built on Anthropic's Claude Agent SDK.\n\nKeep this",
      ),
    ).toBe("Keep this");
    expect(
      sanitizeAntigravitySystemText(
        "x-anthropic-billing-header: cc_version=2.1.220;\r\n<!-- generated-by: opencodex -->\r\n<!-- ocx-route: antigravity-cli/gemini-4-carbon -->\r\nYou are a Claude agent, built on Anthropic's Claude Agent SDK.\nYou are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK. The exact model ID is ocx-claude-antigravity-cli--gemini-4-carbon[1m].\nSubagent role: inspect C:\\Users\\scy\\Documents\\Codex\\repo and align with Claude Code rules.",
        "gemini-4-carbon",
      ),
    ).toBe(
      "The exact model ID is gemini-4-carbon.\nSubagent role: inspect C:\\Users\\scy\\Documents\\Codex\\repo and align with Claude Code rules.",
    );

    // Codex CLI, NEUTRAL_IDENTITY_LINE, inherited parent subagent identity (#5217), and OpenCode CLI preambles
    const repairedCodex = sanitizeAntigravitySystemText(
      "You are a coding agent powered by the gpt-5.4. If asked which model you are, identify as gpt-5.4. Do not claim to be GPT-5 or made by OpenAI.\nFollow repo conventions.",
      "gemini-4-hydrogen",
    );
    expect(repairedCodex).toContain("powered by the gemini-4-hydrogen");
    expect(repairedCodex).not.toMatch(/gpt-5|openai/i);
    expect(
      sanitizeAntigravitySystemText(
        "You are opencode, an interactive CLI tool that helps users with software engineering tasks. Use the instructions below.",
        "gemini-4-argon",
      ),
    ).toBe("You are a coding agent that helps users with software engineering tasks. Use the instructions below.");

    // Real `ocx claude` (`agents-inject.ts`) subagent body & Agent/Task tool description sanitization
    const ocxSubagentBody = [
      "<!-- generated-by: opencodex -->",
      "<!-- ocx-route: ocx-claude-antigravity-cli--gemini-4-carbon[1m] -->",
      "<!-- ocx-effort: high -->",
      "",
      "You are a delegated worker running on `ocx-claude-antigravity-cli--gemini-4-carbon[1m]` through the local opencodex proxy.",
      "IDENTITY: your ACTUAL underlying model is `ocx-claude-antigravity-cli--gemini-4-carbon[1m]` — the opencodex proxy routes this",
      "session there regardless of what model name the Claude Code harness displays or claims.",
      "If asked which model you are, answer with the id above; do not guess a Claude model name.",
      "",
      "Complete the dispatched task directly and report results concisely. This file is",
      "auto-generated by opencodex (`ocx claude`) from the featured subagent roster —",
      "manual edits will be overwritten; remove the model from the roster to drop it.",
    ].join("\n");
    const sanitizedSubagent = sanitizeAntigravitySystemText(ocxSubagentBody, "gemini-4-carbon");
    expect(sanitizedSubagent).not.toMatch(/opencodex|ocx-claude-|ocx claude|ocx-route/i);
    expect(sanitizedSubagent).toContain("You are a delegated worker running on `gemini-4-carbon`.");
    expect(sanitizedSubagent).toContain(
      "IDENTITY: your ACTUAL underlying model is `gemini-4-carbon` — routed to this session regardless of the displayed harness model name.",
    );
    expect(sanitizedSubagent).toContain("Complete the dispatched task directly and report results concisely.");

    // Preserve legitimate user task prompts mentioning "Claude Agent SDK", mid-prompt header examples, and `--` model IDs
    expect(
      sanitizeAntigravitySystemText(
        "You are reviewing a TypeScript service that wraps the Claude Agent SDK.\nHeader docs:\nx-anthropic-billing-header: <example>\nModel alias: ocx-claude-myprov--foo--fast[1m].",
        "gemini-4-carbon",
      ),
    ).toBe(
      "You are reviewing a TypeScript service that wraps the Claude Agent SDK.\nHeader docs:\nx-anthropic-billing-header: <example>\nModel alias: foo--fast.",
    );

    // Linear-time O(N) guard against adversarial unpunctuated inputs
    const t0 = performance.now();
    const advOut = sanitizeAntigravitySystemText(
      `${"You are ".repeat(20_000)}ocx-claude-${"-".repeat(40_000)}!`,
      "gemini-4-carbon",
    );
    expect(advOut.length).toBeGreaterThan(100_000);
    expect(performance.now() - t0).toBeLessThan(500);

    // Sanitize `agents-inject.ts` proxy prose & gateway aliases inside `Agent`/`Task` tool descriptions
    const bridge = buildAntigravityCliToolBridge({
      modelId: "gemini-4-carbon",
      context: {
        messages: [{ role: "user", content: "delegate" }],
        tools: [
          {
            name: "Agent",
            description:
              'Available agents: - ocx-gemini: Delegate work to gemini-4-carbon (antigravity-cli) via opencodex routing. NOTE: this agent\'s real model is pinned by the opencodex proxy. - ocx-self: Self-clone: delegate to your default main model (ocx-claude-antigravity-cli--gemini-4-carbon[1m]).',
            parameters: { type: "object", properties: { prompt: { type: "string" } } },
          },
        ],
      },
      options: {},
      clientFormat: "claude",
      _rawBody: {},
    });
    expect(bridge?.tools[0]?.description).not.toMatch(/opencodex|ocx-claude-/i);
    expect(bridge?.tools[0]?.description).toContain("pinned by configuration");
    expect(bridge?.tools[0]?.description).toContain("(gemini-4-carbon)");

    // Word-bounded auth classification: "signing" and "designing" must not trigger false 401s
    expect(classifyAntigravityCliError("TLS signing certificate verification failed").status).toBe(502);
    expect(classifyAntigravityCliError("Error while designing schema layout").status).toBe(502);
    expect(classifyAntigravityCliError("Sign-in required to continue").status).toBe(401);
    expect(classifyAntigravityCliError("User is not signed in").status).toBe(401);

    // Usage mapping handles both inclusive (`total = input + output`) and disjoint (`total = input + output + thinking`) frames
    const inclusive = usageFromAntigravityRecord({ input_tokens: 5987, output_tokens: 181, thinking_tokens: 152, cache_read_tokens: 0, total_tokens: 6168 });
    expect(inclusive).toEqual({ inputTokens: 5987, outputTokens: 181, reasoningOutputTokens: 152, totalTokens: 6168 });
    expect(disjointTelemetryTokens(inclusive)).toEqual({ inputTokens: 5987, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 29, reasoningTokens: 152 });

    const disjoint = usageFromAntigravityRecord({ input_tokens: 100, output_tokens: 25, thinking_tokens: 80, cache_read_tokens: 0, total_tokens: 205 });
    expect(disjoint).toEqual({ inputTokens: 100, outputTokens: 105, reasoningOutputTokens: 80, totalTokens: 205 });
    expect(disjointTelemetryTokens(disjoint)).toEqual({ inputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 25, reasoningTokens: 80 });

    // Disjoint uncached rawInput >= cacheRead still adds cacheRead unconditionally (`baseInput = rawInput + cacheRead`)
    const disjointCacheGe = usageFromAntigravityRecord({ input_tokens: 2216, cache_read_tokens: 1934, output_tokens: 53, total_tokens: 2269 });
    expect(disjointCacheGe).toEqual({
      inputTokens: 4150,
      outputTokens: 53,
      totalTokens: 4203,
      cachedInputTokens: 1934,
      cacheReadInputTokens: 1934,
    });
    expect(disjointTelemetryTokens(disjointCacheGe)).toEqual({
      inputTokens: 2216,
      cacheReadTokens: 1934,
      cacheWriteTokens: 0,
      outputTokens: 53,
      reasoningTokens: 0,
    });
  });
});

const ONE_BY_ONE_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

describe("antigravity-cli runTurn execution, tool capture, and fail-closed guards", () => {
  test("fails closed before spawning on non-canonical baseUrl, disallowed model, missing CLI, or unsupported media", async () => {
    let spawned = 0;
    const neverSpawn: SpawnFn = () => {
      spawned++;
      throw new Error("must not spawn");
    };

    const badUrlEvents = await run(
      createAntigravityCliAdapter(provider({ baseUrl: "https://evil.invalid" }), { which: () => "/bin/agy", spawn: neverSpawn }),
      parsed(),
    );
    expect(badUrlEvents).toEqual([expect.objectContaining({ type: "error", status: 400, code: "non_canonical_destination" })]);

    const badModelEvents = await run(
      createAntigravityCliAdapter(provider(), { which: () => "/bin/agy", spawn: neverSpawn }),
      parsed({ modelId: "gemini-3.8-flash" }),
    );
    expect(badModelEvents).toEqual([expect.objectContaining({ type: "error", status: 400, code: "model_not_found" })]);

    for (const badImageUrl of [
      "https://fixture.invalid/a.png",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
      "data:image/png;base64,not-valid-base64!!!",
    ]) {
      const imageEvents = await run(
        createAntigravityCliAdapter(provider(), { which: () => "/bin/agy", spawn: neverSpawn }),
        parsed({
          context: {
            messages: [{
              role: "user",
              content: [{ type: "image", imageUrl: badImageUrl }],
              timestamp: 0,
            }],
          },
        }),
      );
      expect(imageEvents).toEqual([expect.objectContaining({ type: "error", status: 400, code: "unsupported_input_modality" })]);
    }

    const devImageEvents = await run(
      createAntigravityCliAdapter(provider(), { which: () => "/bin/agy", spawn: neverSpawn }),
      parsed({
        context: {
          messages: [{
            role: "developer",
            content: [{ type: "image", imageUrl: ONE_BY_ONE_PNG_DATA_URL }],
            timestamp: 0,
          }],
        },
      }),
    );
    expect(devImageEvents).toEqual([expect.objectContaining({ type: "error", status: 400, code: "unsupported_input_modality" })]);

    const missingCliEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => undefined,
        spawn: neverSpawn,
      }),
      parsed(),
    );
    expect(missingCliEvents).toEqual([expect.objectContaining({ type: "error", status: 500, code: "cli_not_found" })]);
    expect(spawned).toBe(0);
  });

  test("stages --agent ocx_bridge workspace, streams deltas without duplicating result.response, and cleans up turnDir and UUID brainDir", async () => {
    const tempBrainRoot = mkdtempSync(join(tmpdir(), "ocx-agy-brain-test-"));
    const convUuid = "11111111-2222-3333-4444-555555555555";
    const convBrainDir = join(tempBrainRoot, convUuid);
    const sentinelDir = join(tempBrainRoot, "keep-sentinel");
    mkdirSync(convBrainDir, { recursive: true });
    mkdirSync(sentinelDir, { recursive: true });
    writeFileSync(join(convBrainDir, "transcript.jsonl"), "{}");
    writeFileSync(join(sentinelDir, "keep.txt"), "ok");

    let capturedCwd = "";
    let capturedArgs: readonly string[] = [];
    let stagedAgentMd = "";
    let stagedSettings: Record<string, unknown> | undefined;

    try {
      const adapter = createAntigravityCliAdapter(provider(), {
        which: () => "/usr/local/bin/agy",
        platform: "linux",
        brainDir: tempBrainRoot,
        spawn: (_cmd, args, options) => {
          capturedArgs = args;
          capturedCwd = String(options.cwd ?? "");
          stagedAgentMd = readFileSync(
            join(capturedCwd, ".agents", "agents", ANTIGRAVITY_BRIDGE_AGENT_NAME, "agent.md"),
            "utf8",
          );
          stagedSettings = JSON.parse(readFileSync(join(capturedCwd, "settings.json"), "utf8"));
          return fakeChild([
            JSON.stringify({
              event: "init",
              conversation_id: convUuid,
              init: { agent: ANTIGRAVITY_BRIDGE_AGENT_NAME, model: "Gemini 4 Hydrogen (XHigh)" },
            }),
            JSON.stringify({
              event: "step_update",
              step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", thinking_delta: "plan...", text_delta: "Hello " },
            }),
            JSON.stringify({
              event: "step_update",
              step_update: {
                step_index: 1,
                state: "DONE",
                step_type: "agent_response",
                text_delta: "world!",
                usage: { input_tokens: 90, output_tokens: 18, thinking_tokens: 10, cache_read_tokens: 30, total_tokens: 108 },
              },
            }),
            JSON.stringify({
              event: "result",
              result: {
                status: "SUCCESS",
                response: "Hello world!",
                usage: { input_tokens: 90, output_tokens: 18, thinking_tokens: 10, cache_read_tokens: 30, total_tokens: 108 },
              },
            }),
          ]) as unknown as ChildProcess;
        },
      });

      const events = await run(
        adapter,
        parsed({
          modelId: "gemini-4-hydrogen",
          options: { reasoning: "xhigh" },
          context: {
            systemPrompt: ["x-anthropic-billing-header: cc_version=2.1.88\nYou are concise."],
            messages: [{ role: "user", content: "Greet me", timestamp: 0 }],
          },
        }),
      );

      expect(buildArgs("gemini-4-hydrogen-xhigh", "/tmp/s.json")).toEqual(
        expect.arrayContaining(["--print=", "--agent", ANTIGRAVITY_BRIDGE_AGENT_NAME]),
      );
      expect(capturedArgs).toContain("--print=");
      expect(capturedArgs).toContain("--agent");
      expect(capturedArgs).toContain(ANTIGRAVITY_BRIDGE_AGENT_NAME);
      expect(capturedArgs).toContain("gemini-4-hydrogen-xhigh");
      expect(stagedAgentMd).toContain("inheritMcp: false");
      expect(stagedAgentMd).toContain("tools: []");
      expect(stagedAgentMd).toContain("You are concise.");
      expect(stagedAgentMd).not.toContain("x-anthropic-billing-header");
      expect(stagedSettings?.trustedWorkspaces).toEqual([capturedCwd]);
      expect(existsSync(capturedCwd)).toBe(false);
      expect(existsSync(convBrainDir)).toBe(false);
      expect(existsSync(sentinelDir)).toBe(true);

      // Path-traversal `conversation_id` must never be passed to `rm`
      const traversalAdapter = createAntigravityCliAdapter(provider(), {
        which: () => "/usr/local/bin/agy",
        platform: "linux",
        brainDir: join(tempBrainRoot, "nested"),
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", conversation_id: "../keep-sentinel", init: {} }),
          JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "ok" } }),
        ]) as unknown as ChildProcess,
      });
      await run(traversalAdapter, parsed());
      expect(existsSync(sentinelDir)).toBe(true);

      expect(events).toEqual([
        { type: "thinking_delta", thinking: "plan..." },
        { type: "text_delta", text: "Hello " },
        { type: "text_delta", text: "world!" },
        {
          type: "done",
          stopReason: "stop",
          usage: {
            inputTokens: 120,
            outputTokens: 18,
            totalTokens: 138,
            cachedInputTokens: 30,
            cacheReadInputTokens: 30,
            reasoningOutputTokens: 10,
          },
        },
      ]);
    } finally {
      rmSync(tempBrainRoot, { recursive: true, force: true });
    }
  });

  test("stages inline base64 images, suppresses internal .ocx-images read_file steps, and self-corrects after PreToolUse denials", async () => {
    let stagedImgExists = false;
    let capturedStdin = "";
    let childRef: FakeChild | undefined;

    const adapter = createAntigravityCliAdapter(provider(), {
      which: () => "/usr/local/bin/agy",
      toolBatchCoalesceMs: 10,
      undeclaredToolGraceMs: 250,
      spawn: (_cmd, _args, options) => {
        const cwd = String(options.cwd ?? "");
        const imgPath = join(cwd, ".ocx-images", "img-0.png");
        stagedImgExists = existsSync(imgPath);
        childRef = parkedFakeChild([
          JSON.stringify({
            event: "init",
            init: { agent: ANTIGRAVITY_BRIDGE_AGENT_NAME, tools: ["view_file", "call_mcp_tool"], permission_mode: "request-review" },
          }),
          // 1. Internal staged-image hydration (`read_file` on `.ocx-images/img-0.png`) is silently consumed
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: "read_file",
              tool_info: { name: "read_file", parameters: { Path: imgPath } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "DONE",
              step_type: "tool",
              tool_name: "read_file",
              tool_info: { name: "read_file", parameters: { Path: imgPath } },
            },
          }),
          // 2. Model probes blocked `run_command`; PreToolUse denies it so model can self-correct!
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 2,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: { name: "run_command", parameters: { CommandLine: "ls" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 2,
              state: "ERROR",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: {
                name: "run_command",
                parameters: { CommandLine: "ls" },
                error: { message: "tool call denied by pre-tool hook: Only the isolated OpenCodex turn tool catalog is permitted" },
              },
            },
          }),
          // 3. Model self-corrects to the isolated MCP tool `mcp_ocx_turn_bridge_read_file`
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 3,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
            },
          }),
        ]);
        const origKill = childRef.kill;
        childRef.kill = () => {
          capturedStdin = childRef!.written.join("");
          return origKill();
        };
        return childRef as unknown as ChildProcess;
      },
    });

    const events = await run(
      adapter,
      parsed({
        context: {
          messages: [{
            role: "user",
            content: [
              { type: "text", text: "Inspect screenshot then read README.md" },
              { type: "image", imageUrl: ONE_BY_ONE_PNG_DATA_URL },
            ],
            timestamp: 0,
          }],
          tools: [{
            name: "read_file",
            description: "Client read_file",
            parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
          }],
        },
      }),
    );

    const parsedStdin = JSON.parse(capturedStdin.trim()) as { message: { content: Array<{ text: string }> } };
    expect(stagedImgExists).toBe(true);
    expect(parsedStdin.message.content[0]?.text.replace(/\\/g, "/")).toContain(".ocx-images/img-0.png");
    expect(events).toEqual([
      expect.objectContaining({ type: "tool_call_start", name: "read_file" }),
      { type: "tool_call_delta", arguments: '{"path":"README.md"}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ]);
  });

  test("coalesces parallel sibling MCP tool calls, deduplicates repeated step_index updates, preserves usage, and reaps Windows process trees", async () => {
    const killedPids: number[] = [];
    let childRef: FakeChild | undefined;
    const secondTool = `${ANTIGRAVITY_MCP_TOOL_PREFIX}list_files`;

    const adapter = createAntigravityCliAdapter(provider(), {
      which: () => "C:\\fake-home\\AppData\\Local\\agy\\bin\\agy.exe",
      platform: "win32",
      toolBatchCoalesceMs: 10,
      killWindowsProcessTree: pid => {
        killedPids.push(pid);
        childRef?.kill();
      },
      spawn: () => {
        childRef = parkedFakeChild([
          JSON.stringify({
            event: "init",
            init: { tools: ["view_file", "call_mcp_tool"], permission_mode: "request-review" },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "DONE",
              step_type: "agent_response",
              usage: { input_tokens: 400, output_tokens: 40, thinking_tokens: 15, cache_read_tokens: 100 },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 2,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
            },
          }),
          // Duplicate ACTIVE update on step_index 2 must not emit a second tool call
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 2,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 3,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: secondTool,
              tool_info: { name: secondTool, parameters: { dir: "src" } },
            },
          }),
        ], 77889);
        return childRef as unknown as ChildProcess;
      },
    });

    const events = await run(
      adapter,
      parsed({
        modelId: "gemini-4-carbon",
        options: { reasoning: "high" },
        context: {
          messages: [{ role: "user", content: "Inspect README and src", timestamp: 0 }],
          tools: [
            {
              name: "read_file",
              description: "Read file",
              parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
            },
            {
              name: "list_files",
              description: "List directory",
              parameters: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"] },
            },
          ],
        },
      }),
    );

    const starts = events.filter(e => e.type === "tool_call_start");
    expect(starts).toHaveLength(2);
    expect(starts.map(s => s.type === "tool_call_start" ? s.name : "")).toEqual(["read_file", "list_files"]);
    expect(killedPids).toEqual([77889]);
    expect(events.at(-1)).toEqual({
      type: "done",
      stopReason: "tool_use",
      endTurn: false,
      usage: {
        inputTokens: 500,
        outputTokens: 40,
        totalTokens: 540,
        cachedInputTokens: 100,
        cacheReadInputTokens: 100,
        reasoningOutputTokens: 15,
      },
    });
  });

  test("fails closed on unblocked undeclared tool calls, missing/mismatched init, always-proceed mode, required-tool violations, CANCELED status, crashed tool turns, and unauthenticated sessions", async () => {
    // 1a. Undeclared built-in tool call hanging in ACTIVE beyond grace window fails closed even when client has same-named `view_file` tool
    const undeclaredEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        undeclaredToolGraceMs: 15,
        spawn: () => parkedFakeChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool", "view_file"], permission_mode: "request-review" } }),
          JSON.stringify({
            event: "step_update",
            step_update: { step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: {} } },
          }),
        ]) as unknown as ChildProcess,
      }),
      parsed({
        context: {
          messages: [{ role: "user", content: "read", timestamp: 0 }],
          tools: [{ name: "view_file", description: "client view_file", parameters: { type: "object", properties: {} } }],
        },
      }),
    );
    expect(undeclaredEvents).toEqual([expect.objectContaining({ type: "error", status: 502, code: "undeclared_tool_call" })]);

    // 1b. Undeclared tool completing (`DONE`) or failing with non-hook OS error (`EACCES`) fails closed immediately
    for (const unblockedStep of [
      { step_index: 1, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: {} } },
      { step_index: 1, state: "ERROR", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", error: { message: "EACCES: permission denied" } } },
    ]) {
      const immediateUndeclared = await run(
        createAntigravityCliAdapter(provider(), {
          which: () => "/bin/agy",
          platform: "linux",
          spawn: () => parkedFakeChild([
            JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"] } }),
            JSON.stringify({ event: "step_update", step_update: unblockedStep }),
          ]) as unknown as ChildProcess,
        }),
        toolRequest(),
      );
      expect(immediateUndeclared).toEqual([expect.objectContaining({ type: "error", status: 502, code: "undeclared_tool_call" })]);
    }

    // 2. Init missing MCP dispatch capability, wrong agent profile, or running in always-proceed mode
    const mismatchEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => parkedFakeChild([
          JSON.stringify({ event: "init", init: { tools: ["view_file"] } }),
        ]) as unknown as ChildProcess,
      }),
      toolRequest(),
    );
    expect(mismatchEvents).toEqual([expect.objectContaining({ type: "error", status: 502, code: "tool_bridge_init_mismatch" })]);

    const wrongAgentEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { agent: "default", tools: ["call_mcp_tool"] } }),
        ]) as unknown as ChildProcess,
      }),
      parsed(),
    );
    expect(wrongAgentEvents).toEqual([expect.objectContaining({ type: "error", status: 502, code: "tool_bridge_init_mismatch" })]);

    const alwaysProceedEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"], permission_mode: "always-proceed" } }),
        ]) as unknown as ChildProcess,
      }),
      parsed(),
    );
    expect(alwaysProceedEvents).toEqual([expect.objectContaining({ type: "error", status: 502, code: "tool_bridge_init_mismatch" })]);

    // 3. tool_choice: required answered with text-only result
    const requiredEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"] } }),
          JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "I skipped the tool." } }),
        ]) as unknown as ChildProcess,
      }),
      toolRequest({ options: { toolChoice: "required" } }),
    );
    expect(requiredEvents).toEqual([expect.objectContaining({ type: "error", status: 502, code: "tool_call_required" })]);

    // 4. Child crashes (exit 1) or isolated MCP tool step errors before capture parks
    const crashedToolEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        toolBatchCoalesceMs: 50,
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { tools: [BRIDGED_READ_TOOL] } }),
          JSON.stringify({
            event: "step_update",
            step_update: { step_index: 1, state: "ACTIVE", step_type: "tool", tool_name: BRIDGED_READ_TOOL, tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "a" } } },
          }),
        ], { exitCode: 1, stderr: "panic: broken pipe" }) as unknown as ChildProcess,
      }),
      toolRequest(),
    );
    expect(crashedToolEvents.at(-1)).toEqual(expect.objectContaining({ type: "error", status: 502, code: "process_exit_error" }));

    const erroredToolStepEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"] } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ERROR",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "a" }, error: { message: "calling tools/call: EOF" } },
            },
          }),
        ]) as unknown as ChildProcess,
      }),
      toolRequest(),
    );
    expect(erroredToolStepEvents).toEqual([expect.objectContaining({ type: "error", status: 502, code: "protocol_error" })]);

    // 5. Non-SUCCESS statuses (`CANCELED`) and transient transport EOFs
    const canceledEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => fakeChild([
          JSON.stringify({ event: "result", result: { status: "CANCELED", response: "" } }),
        ]) as unknown as ChildProcess,
      }),
      parsed(),
    );
    expect(canceledEvents).toEqual([expect.objectContaining({ type: "error", status: 502, retryable: false })]);

    const eofEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => fakeChild([
          JSON.stringify({ event: "result", result: { status: "ERROR", error: "Post \"https://daily-cloudcode-pa.googleapis.com/v1internal:loadCodeAssist\": EOF" } }),
        ]) as unknown as ChildProcess,
      }),
      parsed(),
    );
    expect(eofEvents).toEqual([expect.objectContaining({ type: "error", status: 502, retryable: true })]);

    // 6. Unauthenticated CLI surfaces actionable `agy` login hint; non-zero stderr preserves 429/400/retryable-502
    const unauthEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => fakeChild([
          JSON.stringify({ event: "result", result: { status: "ERROR", error: "Not logged in: please sign in first" } }),
        ]) as unknown as ChildProcess,
      }),
      parsed(),
    );
    expect(unauthEvents).toEqual([
      expect.objectContaining({
        type: "error",
        status: 401,
        code: "antigravity_cli_not_logged_in",
        message: expect.stringContaining("Run `agy` once and sign in"),
      }),
    ]);

    const stderrRateLimitEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => fakeChild([], { exitCode: 1, stderr: "rpc error: code = ResourceExhausted desc = 429 RESOURCE_EXHAUSTED" }) as unknown as ChildProcess,
      }),
      parsed(),
    );
    expect(stderrRateLimitEvents).toEqual([
      expect.objectContaining({ type: "error", status: 429, code: "rate_limit_exceeded", retryable: true }),
    ]);

    const stderrTransientExitEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => fakeChild([], { exitCode: 1, stderr: "read tcp: ECONNRESET" }) as unknown as ChildProcess,
      }),
      parsed(),
    );
    expect(stderrTransientExitEvents).toEqual([
      expect.objectContaining({ type: "error", status: 502, code: "upstream_error", retryable: true }),
    ]);
  });

  test("enforces sendBudget admission before spawning", async () => {
    let spawned = 0;
    const adapter = createAntigravityCliAdapter(provider(), {
      which: () => "/bin/agy",
      spawn: () => {
        spawned++;
        throw new Error("must not spawn");
      },
    });
    await expect(
      adapter.runTurn!(
        parsed(),
        {
          headers: new Headers(),
          translatorBudget: createTestTranslatorBudget(),
          sendBudget: {
            reserveDispatch: () => ({ allowed: false, reason: "exhausted" } as any),
          } as any,
        },
        () => {},
      ),
    ).rejects.toThrow(SendBudgetExhaustedError);
    expect(spawned).toBe(0);
  });

  test("re-arms coalesce after co-occurring PreToolUse denial, fails closed on EOF with pending undeclared tools, and rejects multiline stderr spoofing", async () => {
    // 1. Valid MCP tool parked first, followed by ACTIVE -> PreToolUse-denied undeclared tool: re-arms coalesce in <50ms
    const startedAt = Date.now();
    const coOccurringEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        toolBatchCoalesceMs: 10,
        undeclaredToolGraceMs: 250,
        timeoutMs: 1_000,
        spawn: () => parkedFakeChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"] } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: BRIDGED_READ_TOOL,
              tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 2,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: { name: "run_command", parameters: { CommandLine: "ls" } },
            },
          }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 2,
              state: "ERROR",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: {
                name: "run_command",
                error: { message: "tool call denied by pre-tool hook: Only the declared turn tool catalog is permitted" },
              },
            },
          }),
        ]) as unknown as ChildProcess,
      }),
      toolRequest(),
    );
    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(coOccurringEvents).toEqual([
      expect.objectContaining({ type: "tool_call_start", name: "read_file" }),
      { type: "tool_call_delta", arguments: '{"path":"README.md"}' },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ]);

    // 1b. Late Windows hook cold-start denials arriving AFTER `toolBatchCoalesceMs` (and serialized across multiple undeclared tools past one `undeclaredToolGraceMs` slice) re-arm coalesce instead of hanging until 504
    const lateDenialEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        toolBatchCoalesceMs: 20,
        undeclaredToolGraceMs: 90,
        timeoutMs: 600,
        spawn: () => {
          const child = parkedFakeChild([
            JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool", "view_file", "list_dir"] } }),
            JSON.stringify({
              event: "step_update",
              step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: BRIDGED_READ_TOOL, tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: "README.md" } } },
            }),
            JSON.stringify({
              event: "step_update",
              step_update: { step_index: 3, state: "ACTIVE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "x" } } },
            }),
            JSON.stringify({
              event: "step_update",
              step_update: { step_index: 4, state: "ACTIVE", step_type: "tool", tool_name: "list_dir", tool_info: { name: "list_dir", parameters: { DirectoryPath: "." } } },
            }),
          ]);
          const stream = child.stdout as PassThrough;
          setTimeout(() => {
            if (!child.killed) {
              stream.write(`${JSON.stringify({
                event: "step_update",
                step_update: { step_index: 3, state: "ERROR", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", error: { message: "tool call denied by pre-tool hook: nope" } } },
              })}\n`);
            }
          }, 55);
          setTimeout(() => {
            if (!child.killed) {
              stream.write(`${JSON.stringify({
                event: "step_update",
                step_update: { step_index: 4, state: "ERROR", step_type: "tool", tool_name: "list_dir", tool_info: { name: "list_dir", error: { message: "tool call denied by pre-tool hook: nope" } } },
              })}\n`);
            }
          }, 115);
          return child as unknown as ChildProcess;
        },
      }),
      toolRequest(),
    );
    expect(lateDenialEvents.at(-1)).toEqual({ type: "done", stopReason: "tool_use", endTurn: false });

    // 1c. Live MCP `captured-calls.jsonl` substitutes untruncated >512-char arguments when `agy` step_update truncates at 512 chars + `…`
    const fullScript = `const token = "${"A".repeat(1200)}";\ntext(token);\n`;
    const truncatedPreview = `${fullScript.slice(0, 512)}…`;
    const untruncatedEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        toolBatchCoalesceMs: 15,
        undeclaredToolGraceMs: 300,
        spawn: (_cmd, _args, opts) => {
          const captureFile = join(String(opts.cwd), "captured-calls.jsonl");
          writeFileSync(captureFile, "", { mode: 0o600 });
          setTimeout(() => {
            writeFileSync(captureFile, `${JSON.stringify({ name: "read_file", arguments: { path: fullScript } })}\n`);
          }, 45);
          return parkedFakeChild([
            JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"] } }),
            JSON.stringify({
              event: "step_update",
              step_update: { step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: BRIDGED_READ_TOOL, tool_info: { name: BRIDGED_READ_TOOL, parameters: { path: truncatedPreview } } },
            }),
          ]) as unknown as ChildProcess;
        },
      }),
      toolRequest(),
    );
    expect(untruncatedEvents).toEqual([
      expect.objectContaining({ type: "tool_call_start", name: "read_file" }),
      { type: "tool_call_delta", arguments: JSON.stringify({ path: fullScript }) },
      { type: "tool_call_end" },
      { type: "done", stopReason: "tool_use", endTurn: false },
    ]);

    // 2. Stream EOF while an undeclared tool is still ACTIVE fails closed (`retryable: false`), never retryable `missing_result`
    const eofPendingEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => fakeChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"] } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ACTIVE",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: { name: "run_command", parameters: { CommandLine: "whoami" } },
            },
          }),
        ]) as unknown as ChildProcess,
      }),
      toolRequest(),
    );
    expect(eofPendingEvents).toEqual([
      expect.objectContaining({ type: "error", status: 502, code: "undeclared_tool_call", retryable: false }),
    ]);

    // 3. Multiline command stderr mentioning "non-interactive mode" on line 2 must NOT match anchored hook-denial pattern
    const spoofedDenialEvents = await run(
      createAntigravityCliAdapter(provider(), {
        which: () => "/bin/agy",
        platform: "linux",
        spawn: () => parkedFakeChild([
          JSON.stringify({ event: "init", init: { tools: ["call_mcp_tool"] } }),
          JSON.stringify({
            event: "step_update",
            step_update: {
              step_index: 1,
              state: "ERROR",
              step_type: "tool",
              tool_name: "run_command",
              tool_info: {
                name: "run_command",
                error: { message: "git fetch failed\ntool prompt denied in non-interactive mode" },
              },
            },
          }),
        ]) as unknown as ChildProcess,
      }),
      toolRequest(),
    );
    expect(spoofedDenialEvents).toEqual([
      expect.objectContaining({ type: "error", status: 502, code: "undeclared_tool_call", retryable: false }),
    ]);
  });

  test("preserves byte-identical historical image blocks across turns, stages sliding 16-image history window, and separates multi-step text without duplicating prefixes", () => {
    // 1. Historical blocks 0..N-1 remain byte-identical across turns despite distinct per-turn workspace directories
    const turn1Req = parsed({
      context: {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "Check screenshot" },
            { type: "image", imageUrl: ONE_BY_ONE_PNG_DATA_URL },
          ],
          timestamp: 0,
        }],
      },
    });
    const turn2Req = parsed({
      context: {
        messages: [
          ...turn1Req.context.messages,
          { role: "assistant", content: [{ type: "text", text: "Looks good." }], timestamp: 1 },
          { role: "user", content: "What color is the border?", timestamp: 2 },
        ],
      },
    });
    const turn1Input = JSON.parse(buildAntigravityCliConversationInput(turn1Req, {
      stagedImages: [{ index: 0, relativePath: ".ocx-images/img-0.png", absolutePath: "/tmp/turn-aaa/.ocx-images/img-0.png" }],
    })[0]!) as { message: { content: Array<{ text: string }> } };
    const turn2Input = JSON.parse(buildAntigravityCliConversationInput(turn2Req, {
      stagedImages: [{ index: 0, relativePath: ".ocx-images/img-0.png", absolutePath: "/tmp/turn-bbb/.ocx-images/img-0.png" }],
    })[0]!) as { message: { content: Array<{ text: string }> } };
    expect(turn1Input.message.content[0]?.text).toBe("USER:\nCheck screenshot\n[Attached image: .ocx-images/img-0.png]");
    expect(turn2Input.message.content[0]?.text).toBe(turn1Input.message.content[0]?.text);
    expect(turn2Input.message.content.at(-1)?.text).toContain("/tmp/turn-bbb/.ocx-images/img-0.png");

    // 2. 18 screenshots across historical turns stage newest 16; 17 screenshots in active turn fail closed
    const historyMessages: OcxParsedRequest["context"]["messages"] = [];
    for (let i = 0; i < 18; i++) {
      historyMessages.push({
        role: "user",
        content: [{ type: "image", imageUrl: ONE_BY_ONE_PNG_DATA_URL }],
        timestamp: i * 2,
      });
      if (i < 17) {
        historyMessages.push({
          role: "assistant",
          content: [{ type: "text", text: `ack ${i}` }],
          timestamp: i * 2 + 1,
        });
      }
    }
    const sliding = extractAntigravityStagedImages(parsed({ context: { messages: historyMessages } }));
    expect(sliding.error).toBeUndefined();
    expect(sliding.images).toHaveLength(16);
    expect(sliding.images?.[0]?.index).toBe(2);
    expect(sliding.images?.at(-1)?.index).toBe(17);

    const activeBurst = extractAntigravityStagedImages(parsed({
      context: {
        messages: [{
          role: "user",
          content: Array.from({ length: 17 }, () => ({ type: "image" as const, imageUrl: ONE_BY_ONE_PNG_DATA_URL })),
          timestamp: 0,
        }],
      },
    }));
    expect(activeBurst.error).toContain("at most 16 attached images");

    // 3. Multi-step `agent_response` -> `view_file` -> unstreamed `result.response` inserts `\n\n` and strips any repeated Step 1 prefix; `suppressStepSeparator` omits `\n\n`
    const stateProse = createAntigravityStreamState(undefined, {
      stagedImagePaths: new Set(["/tmp/t/.ocx-images/img-0.png"]),
      turnDir: "/tmp/t",
      platform: "linux",
    });
    const proseEvents = [
      ...mapAntigravityStreamFrame(
        { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "Inspecting image." } },
        stateProse,
      ),
      ...mapAntigravityStreamFrame(
        { event: "step_update", step_update: { step_index: 2, state: "ERROR", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "/tmp/t/.ocx-images/img-0.png" } } } },
        stateProse,
      ),
      ...mapAntigravityStreamFrame(
        { event: "result", result: { status: "SUCCESS", response: "Inspecting image.Final answer." } },
        stateProse,
      ),
    ];
    expect(proseEvents).toEqual([
      { type: "text_delta", text: "Inspecting image." },
      { type: "text_delta", text: "\n\nFinal answer." },
      { type: "done", stopReason: "stop" },
    ]);

    const stateJson = createAntigravityStreamState(undefined, {
      stagedImagePaths: new Set(["/tmp/t/.ocx-images/img-0.png"]),
      turnDir: "/tmp/t",
      platform: "linux",
      suppressStepSeparator: true,
    });
    const jsonEvents = [
      ...mapAntigravityStreamFrame(
        { event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: '{"a":1,' } },
        stateJson,
      ),
      ...mapAntigravityStreamFrame(
        { event: "step_update", step_update: { step_index: 2, state: "DONE", step_type: "tool", tool_name: "view_file", tool_info: { name: "view_file", parameters: { AbsolutePath: "/tmp/t/.ocx-images/img-0.png" } } } },
        stateJson,
      ),
      ...mapAntigravityStreamFrame(
        { event: "step_update", step_update: { step_index: 3, state: "DONE", step_type: "agent_response", text_delta: '"b":2}' } },
        stateJson,
      ),
    ];
    expect(jsonEvents).toEqual([
      { type: "text_delta", text: '{"a":1,' },
      { type: "text_delta", text: '"b":2}' },
    ]);
  });
});
