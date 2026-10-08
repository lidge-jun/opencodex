import { beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import {
  buildArgs,
  buildChildEnv,
  CLAUDE_CLI_QUIET_ENV,
  createClaudeCliAdapter as createRealClaudeCliAdapter,
  findClaudeCliBinary,
  withClaudeLoginHint,
  type SpawnFn,
} from "../../src/adapters/claude-cli/adapter";
import { CLAUDE_REPLAY_SYSTEM_PROMPT } from "../../src/adapters/claude-cli/stable-replay";
import { baseScopedEnv } from "../../src/adapters/coding-agent/turn";
import { CLAUDE_CLI_PROFILE, clearClaudeCliBinaryCache } from "../../src/adapters/claude-cli/profiles";
import { buildCodeBuddyToolBridge } from "../../src/adapters/codebuddy/tool-bridge";
import { effectiveAdapterContract, getAdapterDefinition } from "../../src/adapters/registry";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// Never run the real usage preflight here: it would read local Claude credentials and the shared quota cache.
const createClaudeCliAdapter: typeof createRealClaudeCliAdapter = (provider, deps = {}) =>
  createRealClaudeCliAdapter(provider, { usageAdmission: async () => ({ state: "available", checkedAt: 0 }), usageRefusal: () => {}, ...deps });

const enc = new TextEncoder();

// The binary-discovery cache is module-level (a production perf seam); reset it so a test that
// reports a missing CLI cannot mask a later test's injected binary.
beforeEach(() => clearClaudeCliBinaryCache());

test("Claude native install is found when a service PATH misses it", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-claude-home-"));
  try {
    const bin = join(home, ".local", "bin");
    mkdirSync(bin, { recursive: true });
    const native = join(bin, "claude.exe");
    writeFileSync(native, "");
    expect(findClaudeCliBinary("claude", () => undefined, home, "win32")).toBe(native);
    expect(findClaudeCliBinary("claude", () => "C:\\on-path\\claude.exe", home, "win32")).toBe("C:\\on-path\\claude.exe");
    expect(findClaudeCliBinary("other", () => undefined, home, "win32")).toBeUndefined();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

interface FakeChild extends EventEmitter {
  stdout: Readable;
  stderr: Readable;
  stdin: Writable;
  killed: boolean;
  exitCode: number | null;
  kill: (signal?: string) => boolean;
  written: string[];
}

function fakeChild(stdout: Uint8Array[], opts: { stderr?: string; exitCode?: number } = {}): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = Readable.from(stdout);
  child.stderr = Readable.from(opts.stderr ? [enc.encode(opts.stderr)] : []);
  child.written = [];
  child.stdin = new Writable({ write(chunk, _enc, cb) { child.written.push(String(chunk)); cb(); } });
  child.killed = false;
  child.exitCode = null;
  child.kill = () => { child.killed = true; return true; };
  setTimeout(() => { child.exitCode = opts.exitCode ?? 0; child.emit("close", opts.exitCode ?? 0); }, 3);
  return child;
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "claude-cli",
    baseUrl: CLAUDE_CLI_PROFILE.canonicalBaseUrl,
    reasoningEfforts: ["low", "medium", "high", "xhigh", "max"],
    ...overrides,
  } as OcxProviderConfig;
}

function parsed(overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return {
    modelId: "claude-sonnet-5",
    stream: true,
    options: {},
    context: { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
    ...overrides,
  } as OcxParsedRequest;
}

function incoming(abortSignal?: AbortSignal) {
  return { headers: new Headers(), translatorBudget: createTestTranslatorBudget(), ...(abortSignal ? { abortSignal } : {}) };
}

async function run(adapter: ReturnType<typeof createClaudeCliAdapter>, p: OcxParsedRequest): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(p, incoming(), e => events.push(e));
  return events;
}

describe("claude-cli is an official-harness provider, not a Messages relay", () => {
  test("the registry row and the adapter agree on the one canonical destination", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "claude-cli");
    expect(entry).toBeDefined();
    expect(entry!.adapter).toBe("claude-cli");
    expect(entry!.baseUrl).toBe(CLAUDE_CLI_PROFILE.canonicalBaseUrl);
    expect(entry!.defaultModel).toBe("claude-sonnet-5");
    expect(entry!.models).toContain(entry!.defaultModel!);
    expect(entry!.modelContextWindows?.[entry!.defaultModel!]).toBeGreaterThan(0);
    // Static roster: a live discovery request against this route answers 404 and is pure noise.
    expect(entry!.liveModels).toBe(false);
    // The CLI parses an image frame, but no headless turn was shown to hand those bytes to the
    // model, so the row publishes text-only models instead of the Messages API rows' image
    // modality: an advertised input the route cannot honour is how a picture gets answered blind.
    expect(entry!.noVisionModels).toEqual(entry!.models ?? []);
    expect(entry!.modelInputModalities).toBeUndefined();
  });

  test("the row is a keyless key provider, not a local runtime, and needs no dashboardPreset flag", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "claude-cli")!;
    // "local" is the Ollama / vLLM / LM Studio classification: the traffic never leaves the machine
    // and there is no credential to classify. This row's turn leaves for api.anthropic.com, and the
    // account surface answers from `authKind` (`classifyAccount` in src/cli/account-api.ts), where
    // "local" claimed there were no credentials at all — for a provider whose whole point is a
    // credential the CLI owns.
    expect(entry.authKind).toBe("key");
    // Keyless is expressed by `keyOptional`, the flag key enforcement already honors
    // (src/server/auth-cors.ts, src/providers/api-key-selection.ts) without pretending a key exists.
    expect(entry.keyOptional).toBe(true);
    // A key row must name where its credential comes from; deriveKeyLoginMap throws without this.
    expect(entry.dashboardUrl).toBeTruthy();
    // They keyed a keyless row into the picker by hand. That is what the flag was for, and key rows
    // are listed already, so it is gone rather than duplicated.
    expect(entry.dashboardPreset).toBeUndefined();
    expect(providerConfigSeed(entry)).toMatchObject({ authMode: "key", keyOptional: true });
    expect(deriveProviderPresets().find(candidate => candidate.id === "claude-cli"))
      .toMatchObject({ auth: "key", keyOptional: true });
  });

  test("the adapter inherits the shared coding-agent contract instead of a second wire", () => {
    expect(getAdapterDefinition("claude-cli")?.contractParent).toBe("codebuddy");
    expect(effectiveAdapterContract("claude-cli").wire).toBe("codebuddy");
  });
});

describe("claude-cli headless arguments keep tool ownership with the client", () => {
  test("disables built-in tools and every MCP source, and never requests a bypass", () => {
    const args = buildArgs(CLAUDE_CLI_PROFILE, parsed(), provider());
    expect(args[0]).toBe("-p");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--tools") + 1]).toBe(""); // "" = every built-in tool off
    expect(args).toContain("--strict-mcp-config"); // and no MCP server from settings or plugins
    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--allow-dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
    expect(args).toContain("--no-session-persistence");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
  });

  test("loads no user, project or local settings into a proxied turn", () => {
    const args = buildArgs(CLAUDE_CLI_PROFILE, parsed(), provider());
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).not.toContain("--append-system-prompt");
  });

  test("the caller's system prompt REPLACES the harness preset", () => {
    const args = buildArgs(CLAUDE_CLI_PROFILE, parsed({
      context: { systemPrompt: ["Be terse."], messages: [] },
    }), provider(), "/private/system-prompt.txt");
    expect(args[args.indexOf("--system-prompt-file") + 1]).toBe("/private/system-prompt.txt");
    // argv is world-readable through process listing, so the folded prompt is a path, not an argument.
    expect(args).not.toContain("Be terse.");
    expect(args).not.toContain("--system-prompt");
  });

  test("no staged prompt means no flag at all, so runTurn always stages one", () => {
    expect(buildArgs(CLAUDE_CLI_PROFILE, parsed(), provider())).not.toContain("--system-prompt-file");
  });

  test("maps the caller's reasoning effort onto the CLI's --effort", () => {
    const args = buildArgs(CLAUDE_CLI_PROFILE, parsed({ options: { reasoning: "high" } }), provider());
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
  });

  test("passes no --max-turns: the Claude Code CLI has no such flag", () => {
    // CodeBuddy's CLI accepts --max-turns and this family shares its parser; the flag must not be
    // copied across, or every turn dies on an unknown option.
    expect(buildArgs(CLAUDE_CLI_PROFILE, parsed(), provider())).not.toContain("--max-turns");
  });
});

describe("claude-cli child environment carries no credential and no proxy destination", () => {
  test("an inherited ANTHROPIC_* variable cannot point the harness back at this proxy", () => {
    const previous = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
    process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:10100";
    process.env.ANTHROPIC_API_KEY = "inherited-key";
    try {
      const env = buildChildEnv(CLAUDE_CLI_PROFILE, "");
      expect(Object.keys(env).filter(name => name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_OAUTH"))).toEqual([]);
      expect(JSON.stringify(env)).not.toContain("inherited-key");
      expect(JSON.stringify(env)).not.toContain("127.0.0.1:10100");
    } finally {
      if (previous.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = previous.base;
      if (previous.key === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previous.key;
    }
  });

  test("keeps the home directory the CLI signs in from, and quiets its own telemetry", () => {
    const env = buildChildEnv(CLAUDE_CLI_PROFILE, "");
    // The inherited HOME is the property the provider exists for and the one an operator must know
    // about: the sign-in belongs to the user this proxy runs as, so every request served through
    // this row — by any client of the proxy — spends that same Claude account.
    expect(env.HOME).toBe(process.env.HOME);
    expect(env.DISABLE_AUTOUPDATER).toBe("1");
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
  });

  test("a key configured on the row is never handed to the harness", () => {
    // `keyOptional` makes the row keyless without making it key-*blind*: an operator who saved an
    // API key in the dashboard or with `ocx provider add --api-key` must not silently believe it
    // bills the turn. Nothing layers a credential onto the child environment.
    const env = buildChildEnv(CLAUDE_CLI_PROFILE, "sk-ant-row-key");
    expect(JSON.stringify(env)).not.toContain("sk-ant-row-key");
    expect(Object.keys(env).filter(name => name.startsWith("ANTHROPIC_") || name.startsWith("CLAUDE_CODE_OAUTH"))).toEqual([]);
  });

  test("carries the account name the CLI resolves its keychain sign-in by, and nothing else new", () => {
    // Without USER the CLI reports "not logged in" on a signed-in machine: it looks its own keychain
    // entry up by account name. The value is a name, not a credential — no token is added here.
    const previous = process.env.USER;
    process.env.USER = "ocx-probe-user";
    try {
      const env = buildChildEnv(CLAUDE_CLI_PROFILE, "");
      expect(env.USER).toBe("ocx-probe-user");
      // Derived from the two owners rather than restated, so a new quiet flag cannot silently
      // become the third thing this environment carries.
      expect(Object.keys(env).sort()).toEqual(
        [...new Set([...Object.keys(baseScopedEnv()), ...Object.keys(CLAUDE_CLI_QUIET_ENV), "USER"])].sort(),
      );
    } finally {
      if (previous === undefined) delete process.env.USER;
      else process.env.USER = previous;
    }
  });

  test("adds no USER key when the parent has none", () => {
    const previous = process.env.USER;
    delete process.env.USER;
    try {
      expect("USER" in buildChildEnv(CLAUDE_CLI_PROFILE, "")).toBe(false);
    } finally {
      if (previous !== undefined) process.env.USER = previous;
    }
  });
});

describe("claude-cli runTurn fails closed before any spawn", () => {
  test("a non-canonical base URL is refused", async () => {
    let spawned = 0;
    const spawn: SpawnFn = () => { spawned++; return fakeChild([]) as unknown as ChildProcess; };
    const adapter = createClaudeCliAdapter(provider({ baseUrl: "https://evil.example.test" }), { spawn, which: () => "/usr/bin/claude" });
    const events = await run(adapter, parsed());
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "non_canonical_destination", retryable: false });
  });

  test("a missing CLI is a clear pre-flight error naming the install command", async () => {
    let spawned = 0;
    const adapter = createClaudeCliAdapter(provider(), { spawn: () => { spawned++; return fakeChild([]) as unknown as ChildProcess; }, which: () => undefined });
    const events = await run(adapter, parsed());
    expect(spawned).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "cli_not_found", retryable: false });
    expect(String((events[0] as { message: string }).message)).toContain("npm install -g @anthropic-ai/claude-code");
  });

  test("an image is refused rather than handed to a harness that was never shown to carry it", async () => {
    let spawned = 0;
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => { spawned++; return fakeChild([]) as unknown as ChildProcess; },
      which: () => "/opt/homebrew/bin/claude",
    });
    const events = await run(adapter, parsed({
      context: { messages: [{ role: "user", content: [{ type: "text", text: "what is this?" }, { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgo=" }], timestamp: 0 }] },
    }));
    // Same refusal the Qoder presets make: a dropped image answers the wrong question confidently,
    // and no headless Claude Code turn was shown to deliver image bytes to the model.
    expect(spawned).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 400, code: "unsupported_input_modality", retryable: false });
  });
});

describe("claude-cli stages the folded prompt out of argv", () => {
  test("keeps caller instructions out of argv and removes the private prompt file", async () => {
    const secret = "private-system-instruction";
    let promptFile = "";
    let promptText = "";
    let capturedArgs: string[] = [];
    let promptMode = 0;
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/opt/homebrew/bin/claude",
      spawn: (_command, args) => {
        capturedArgs = [...args];
        promptFile = args[args.indexOf("--system-prompt-file") + 1] ?? "";
        promptText = readFileSync(promptFile, "utf8");
        promptMode = statSync(promptFile).mode & 0o777;
        return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });
    const events = await run(adapter, parsed({ context: { systemPrompt: [secret], messages: [] } }));
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(capturedArgs).not.toContain(secret);
    expect(capturedArgs).toContain("--system-prompt-file");
    expect(promptText).toBe(secret + "\n\n" + CLAUDE_REPLAY_SYSTEM_PROMPT);
    if (process.platform !== "win32") expect(promptMode).toBe(0o600);
    expect(promptFile).not.toBe("");
    expect(existsSync(promptFile)).toBe(false);
  });

  test("no caller prompt leaves only fixed replay instructions, replacing the harness preset", async () => {
    let promptFile = "";
    let promptText = "";
    let capturedArgs: string[] = [];
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/opt/homebrew/bin/claude",
      spawn: (_command, args) => {
        capturedArgs = [...args];
        promptFile = args[args.indexOf("--system-prompt-file") + 1] ?? "";
        promptText = readFileSync(promptFile, "utf8");
        return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });
    const events = await run(adapter, parsed());
    expect(events.some(event => event.type === "error")).toBe(false);
    expect(capturedArgs).toContain("--system-prompt-file");
    expect(promptText).toBe(CLAUDE_REPLAY_SYSTEM_PROMPT);
    expect(promptFile).not.toBe("");
    expect(existsSync(promptFile)).toBe(false);
  });
});

describe("claude-cli runTurn streams a subscription turn", () => {
  test("runs without any stored API key, because the CLI owns the account", async () => {
    let spawned = 0;
    const stdout = [
      enc.encode('{"type":"system","subtype":"init"}\n'),
      enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}}\n'),
      enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}}\n'),
      enc.encode('{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"think"}}}\n'),
      enc.encode('{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":7,"output_tokens":2}}\n'),
    ];
    const child = fakeChild(stdout);
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => { spawned++; return child as unknown as ChildProcess; },
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });

    const events = await run(adapter, parsed());
    expect(spawned).toBe(1);
    expect(events.filter(e => e.type === "text_delta").map(e => (e as { text: string }).text).join("")).toBe("Hello");
    expect(events.some(e => e.type === "thinking_delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } });
    expect(child.written.join("")).toContain('"text":"USER:\\nhello"');
  });

  test("an unauthenticated CLI becomes an actionable sign-in error", async () => {
    // Verbatim shape of a real 2.1.270 turn: exit code 1, `is_error` result, no HTTP status.
    const stdout = [enc.encode(`${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
    })}\n`)];
    const adapter = createClaudeCliAdapter(provider(), {
      spawn: () => fakeChild(stdout, { exitCode: 1 }) as unknown as ChildProcess,
      which: () => "/opt/homebrew/bin/claude",
      killGraceMs: 20,
    });

    const events = await run(adapter, parsed());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 401, code: "claude_cli_not_logged_in", retryable: false });
    expect(String((events[0] as { message: string }).message)).toContain("claude");
  });

  test("the sign-in hint leaves every other error untouched", () => {
    const events: AdapterEvent[] = [];
    const hinted = withClaudeLoginHint(event => events.push(event));
    hinted({ type: "error", message: "upstream exploded", status: 502, code: "upstream_error" });
    hinted({ type: "error", message: "rate limited", status: 429, code: "rate_limit_exceeded" });
    hinted({ type: "text_delta", text: "hi" });
    expect(events).toEqual([
      { type: "error", message: "upstream exploded", status: 502, code: "upstream_error" },
      { type: "error", message: "rate limited", status: 429, code: "rate_limit_exceeded" },
      { type: "text_delta", text: "hi" },
    ]);
  });
});

describe("claude-cli returns tool calls to the external client", () => {
  test("restores an exact wire alias after tool history without granting CLI permissions", async () => {
    const request = parsed({ context: {
      messages: [
        { role: "user", content: "Run the next command", timestamp: 0 },
        { role: "assistant", content: [{ type: "toolCall", id: "prior", name: "bash", arguments: { command: "echo prior" } }], timestamp: 1 },
        { role: "toolResult", toolCallId: "prior", toolName: "bash", content: "prior", isError: false, timestamp: 2 },
      ],
      tools: [{ name: "bash", description: "Pi shell", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }],
    } });
    const original = JSON.stringify(request);
    const frames = [
      { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] },
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "next", name: "bash" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"command":"echo next"}' } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "message_stop" } },
    ];
    const child = fakeChild(frames.map(frame => enc.encode(JSON.stringify(frame) + "\n")));
    let seenArgs: readonly string[] = [];
    let prompt = "";
    const adapter = createClaudeCliAdapter(provider(), { which: () => "/usr/bin/claude", spawn: (_file, args) => {
      seenArgs = args;
      prompt = readFileSync(args[args.indexOf("--system-prompt-file") + 1]!, "utf8");
      return child as unknown as ChildProcess;
    }, killGraceMs: 20 });
    const events = await run(adapter, request);
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "bash", id: "next" });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use" });
    expect(seenArgs[seenArgs.indexOf("--allowedTools") + 1]).toBe("mcp__opencodex__bash");
    expect(seenArgs[seenArgs.indexOf("--tools") + 1]).toBe("");
    expect(prompt).toContain('"bash":"mcp__opencodex__bash"');
    expect(child.written.join("")).toContain("[Tool call: mcp__opencodex__bash");
    expect(child.written.join("")).not.toContain("[Tool call: bash");
    expect(JSON.stringify(request)).toBe(original);
  });

  test.each(["Bash", "unknown_tool", "mcp__opencodex__unknown_tool", "write"])(
    "rejects the undeclared or filtered-out name %s", async name => {
      const request = parsed({ options: { toolChoice: { type: "function", name: "read" } }, context: {
        messages: [{ role: "user", content: "Read only", timestamp: 0 }],
        tools: ["read", "write"].map(name => ({ name, description: `Pi ${name}`, parameters: { type: "object" } })),
      } });
      const frames = [
        { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] },
        { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "unlisted", name } } },
        { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } } },
        { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
        { type: "stream_event", event: { type: "message_stop" } },
      ];
      const adapter = createClaudeCliAdapter(provider(), { which: () => "/usr/bin/claude", spawn: () => fakeChild(
        frames.map(frame => enc.encode(JSON.stringify(frame) + "\n")),
      ) as unknown as ChildProcess, killGraceMs: 20 });
      const events = await run(adapter, request);
      expect(events[0]).toMatchObject({ type: "error", code: "undeclared_tool_call" });
      expect(events.some(event => event.type === "tool_call_start" || event.type === "done")).toBe(false);
    },
  );

  test("captures an advertised tool without executing it in the CLI", async () => {
    const request = parsed({
      context: {
        messages: [{ role: "user", content: "Read the fixture", timestamp: 0 }],
        tools: [{ name: "read_file", description: "Read a file", parameters: {
          type: "object", properties: { path: { type: "string" } }, required: ["path"],
        } }],
      },
    });
    const cliName = [...buildCodeBuddyToolBridge(request).emittedNameMap.keys()][0]!;
    const frames = [
      { type: "system", subtype: "init", mcp_servers: [{ name: "opencodex", status: "connected" }] },
      { type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", id: "tu_1", name: cliName } } },
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: '{"path":"fixture.txt"}' } } },
      { type: "stream_event", event: { type: "content_block_stop" } },
      { type: "stream_event", event: { type: "message_stop" } },
    ];
    let seenArgs: readonly string[] = [];
    let prompt = "";
    const child = fakeChild(frames.map(frame => enc.encode(JSON.stringify(frame) + "\n")));
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/usr/bin/claude",
      spawn: (_command, args) => {
        seenArgs = args;
        prompt = readFileSync(args[args.indexOf("--system-prompt-file") + 1]!, "utf8");
        return child as unknown as ChildProcess;
      },
      killGraceMs: 20,
    });
    const events = await run(adapter, request);
    expect(seenArgs[seenArgs.indexOf("--tools") + 1]).toBe("");
    expect(seenArgs).toContain("--strict-mcp-config");
    expect(seenArgs[seenArgs.indexOf("--allowedTools") + 1]).toBe(cliName);
    expect(seenArgs).toContain("--mcp-config");
    expect(seenArgs).not.toContain("--dangerously-skip-permissions");
    expect(prompt).toContain("external client performs approval and execution");
    expect(events.map(event => event.type)).toEqual([
      "tool_call_start", "tool_call_delta", "tool_call_end", "done",
    ]);
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "read_file" });
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    expect(child.killed).toBe(true);
  });

  test("tool_choice none does not expose the MCP catalog", async () => {
    let seenArgs: readonly string[] = [];
    const request = parsed({
      options: { toolChoice: "none" },
      context: {
        messages: [{ role: "user", content: "Answer only", timestamp: 0 }],
        tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object" } }],
      },
    });
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/usr/bin/claude",
      spawn: (_command, args) => {
        seenArgs = args;
        return fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]) as unknown as ChildProcess;
      },
    });
    const events = await run(adapter, request);
    expect(seenArgs).not.toContain("--mcp-config");
    expect(seenArgs).not.toContain("--allowedTools");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });

  test("the next turn receives the client's executed tool result", async () => {
    const child = fakeChild([enc.encode('{"type":"result","subtype":"success"}\n')]);
    const request = parsed({
      context: {
        messages: [
          { role: "user", content: "Read the fixture", timestamp: 0 },
          { role: "assistant", content: [{ type: "toolCall", id: "tu_1", name: "read_file", arguments: { path: "fixture.txt" } }], timestamp: 1 },
          { role: "toolResult", toolCallId: "tu_1", toolName: "read_file", content: "fixture says 42", isError: false, timestamp: 2 },
        ],
      },
    });
    const adapter = createClaudeCliAdapter(provider(), {
      which: () => "/usr/bin/claude",
      spawn: () => child as unknown as ChildProcess,
    });
    const events = await run(adapter, request);
    expect(child.written.join("")).toContain("fixture says 42");
    expect(child.written.join("")).toContain("tu_1");
    expect(events.at(-1)).toMatchObject({ type: "done" });
  });
});
