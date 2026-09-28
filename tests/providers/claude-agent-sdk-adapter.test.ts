import { beforeEach, describe, expect, test } from "bun:test";
import { execFileSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import {
  buildChildEnv,
  CLAUDE_CLI_QUIET_ENV,
  createClaudeAgentSdkAdapter,
  withClaudeLoginHint,
  type ClaudeAgentSdkDeps,
  type ClaudeAgentSdkModule,
  type ClaudeAgentSdkQuery,
} from "../../src/adapters/claude-agent-sdk/adapter";
import {
  buildAgentSdkEffort,
  buildAgentSdkSystemPrompt,
  buildAgentSdkTurnOptions,
} from "../../src/adapters/claude-agent-sdk/sdk-options";
import {
  buildClaudeAgentSdkToolBridge,
  CLAUDE_AGENT_SDK_MCP_SERVER_NAME,
} from "../../src/adapters/claude-agent-sdk/sdk-bridge";
import { baseScopedEnv } from "../../src/adapters/coding-agent/turn";
import { CLAUDE_CLI_PROFILE, clearClaudeCliBinaryCache } from "../../src/adapters/claude-agent-sdk/profiles";
import {
  createHarnessProcessSupervisor,
  HARNESS_CAPACITY_CODE,
  harnessQuarantineSnapshot,
  harnessTeardownMetrics,
  HarnessCapacityError,
  MAX_ACTIVE_HARNESS_TEARDOWNS,
  reapHarnessQuarantine,
  resetHarnessQuarantineForTests,
} from "../../src/adapters/claude-agent-sdk/harness-process";
import { effectiveAdapterContract, getAdapterDefinition } from "../../src/adapters/registry";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../src/types";
import { bridgeToResponsesSSE } from "../../src/bridge";
import { getActiveTurnCount, trackStreamLifetime, tryAdmitTurn } from "../../src/server/lifecycle";
import { createTestTranslatorBudget } from "../helpers/translator-budget";
import type { TranslatorBudget } from "../../src/lib/translator-budget";

// The binary-discovery cache and the harness quarantine are module-level (production seams); reset
// them so a test that reports a missing CLI cannot mask a later test's injected binary, and a case
// that asserts on survivors does not inherit the previous one's.
beforeEach(() => { clearClaudeCliBinaryCache(); resetHarnessQuarantineForTests(); });

interface FakeSdk {
  module: ClaudeAgentSdkModule;
  /** The options object the runner handed the SDK, per turn. */
  options: Record<string, unknown>[];
  /** The prompt frames the runner wrote, per turn (drained from the async iterable). */
  prompts: unknown[][];
  state: { started: number; returned: number; harness?: unknown };
}

/**
 * Fake Agent SDK: replays the given frames as the harness stream, drains the prompt the runner
 * passes, and counts how often a turn was started or ended by `return()`.
 *
 * `park: true` models the capture-only leg: the harness stopped producing frames and is waiting on
 * a tool call nothing will answer, which is exactly the state the runner has to end from its side.
 */
function fakeSdk(frames: readonly unknown[], behavior: { park?: boolean; spawnHarness?: boolean } = {}): FakeSdk {
  const options: Record<string, unknown>[] = [];
  const prompts: unknown[][] = [];
  const state: { started: number; returned: number; harness?: unknown } = { started: 0, returned: 0 };
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const module: ClaudeAgentSdkModule = {
    query: params => {
      state.started += 1;
      options.push(params.options);
      if (behavior.spawnHarness === true) {
        // The SDK's contract: a custom spawner is handed the command the SDK resolved and returns the
        // process object. Calling it here exercises the runner's ownership of that child without a
        // real Claude Code binary on the machine.
        const spawnHarness = params.options.spawnClaudeCodeProcess as (request: unknown) => unknown;
        state.harness = spawnHarness({
          command: "claude",
          args: ["--output-format", "stream-json"],
          env: {},
          signal: new AbortController().signal,
        });
      }
      const collected: unknown[] = [];
      prompts.push(collected);
      const prompt = params.prompt;
      const generator = (async function* () {
        if (typeof prompt !== "string") {
          for await (const frame of prompt) collected.push(frame);
        }
        for (const frame of frames) yield frame as Record<string, never>;
        if (behavior.park) await gate;
      })();
      return {
        [Symbol.asyncIterator]: () => generator,
        return: async (value?: unknown) => {
          state.returned += 1;
          release?.();
          return await generator.return(value);
        },
      } as ClaudeAgentSdkQuery;
    },
  };
  return { module, options, prompts, state };
}

function provider(overrides: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "claude-agent-sdk",
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

function tool(name: string): OcxTool {
  return {
    name,
    description: `Tool ${name}`,
    parameters: { type: "object", properties: { a: { type: "number" } } },
  };
}

function withTools(names: string[], overrides: Partial<OcxParsedRequest> = {}): OcxParsedRequest {
  return parsed({
    context: { messages: [{ role: "user", content: "use a tool", timestamp: 0 }], tools: names.map(tool) },
    ...overrides,
  } as OcxParsedRequest);
}

function incoming(abortSignal?: AbortSignal, translatorBudget = createTestTranslatorBudget()) {
  return {
    headers: new Headers(),
    translatorBudget,
    ...(abortSignal ? { abortSignal } : {}),
  };
}

function initFrame(servers?: unknown[]) {
  return { type: "system", subtype: "init", ...(servers ? { mcp_servers: servers } : {}) };
}

const bridgeConnected = { name: CLAUDE_AGENT_SDK_MCP_SERVER_NAME, status: "connected", source: "sdk" };
const messageStop = { type: "stream_event", event: { type: "message_stop" } };

function textFrame(text: string) {
  return { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } };
}

function resultFrame(usage?: Record<string, number>) {
  return { type: "result", subtype: "success", is_error: false, ...(usage ? { usage } : {}) };
}

function toolCallFrames(id: string, name: string, args = "{}") {
  return [
    { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name } } },
    { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } } },
    { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
  ];
}

async function run(
  adapter: ReturnType<typeof createClaudeAgentSdkAdapter>,
  request: OcxParsedRequest,
  signal?: AbortSignal,
  translatorBudget?: TranslatorBudget,
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(request, incoming(signal, translatorBudget), event => events.push(event));
  return events;
}

/** A push-driven event source, the shape the streaming server hands the bridge. */
function channel<T>() {
  const items: T[] = [];
  let wake: (() => void) | undefined;
  let closed = false;
  const knock = (): void => { const pending = wake; wake = undefined; pending?.(); };
  return {
    push(item: T): void { items.push(item); knock(); },
    close(): void { closed = true; knock(); },
    async *stream(): AsyncGenerator<T> {
      while (true) {
        while (items.length > 0) yield items.shift()!;
        if (closed) return;
        await new Promise<void>(resolve => { wake = resolve; });
      }
    },
  };
}

async function drainStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("claude-agent-sdk is an official-harness provider, not a Messages relay", () => {
  test("the registry row and the adapter agree on the one canonical destination", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "claude-agent-sdk");
    expect(entry).toBeDefined();
    expect(entry!.adapter).toBe("claude-agent-sdk");
    expect(entry!.baseUrl).toBe(CLAUDE_CLI_PROFILE.canonicalBaseUrl);
    expect(entry!.defaultModel).toBe("claude-sonnet-5");
    expect(entry!.models).toContain(entry!.defaultModel!);
    expect(entry!.modelContextWindows?.[entry!.defaultModel!]).toBeGreaterThan(0);
    // Static roster: a live discovery request against this route answers 404 and is pure noise.
    expect(entry!.liveModels).toBe(false);
    // The harness parses an image block, but no headless turn was shown to hand those bytes to the
    // model, so the row publishes text-only models instead of the Messages API rows' image
    // modality: an advertised input the route cannot honour is how a picture gets answered blind.
    expect(entry!.noVisionModels).toEqual(entry!.models ?? []);
    expect(entry!.modelInputModalities).toBeUndefined();
  });

  test("the row is a keyless key provider, not a local runtime, and needs no dashboardPreset flag", () => {
    const entry = PROVIDER_REGISTRY.find(candidate => candidate.id === "claude-agent-sdk")!;
    // "local" is the Ollama / vLLM / LM Studio classification: the traffic never leaves the machine
    // and there is no credential to classify. This row's turn leaves for api.anthropic.com, and the
    // account surface answers from `authKind` (`classifyAccount` in src/cli/account-api.ts), where
    // "local" claimed there were no credentials at all — for a provider whose whole point is a
    // credential the harness owns.
    expect(entry.authKind).toBe("key");
    // Keyless is expressed by `keyOptional`, the flag key enforcement already honors
    // (src/server/auth-cors.ts, src/providers/api-key-selection.ts) without pretending a key exists.
    expect(entry.keyOptional).toBe(true);
    // A key row must name where its credential comes from; deriveKeyLoginMap throws without this.
    expect(entry.dashboardUrl).toBeTruthy();
    expect(entry.dashboardPreset).toBeUndefined();
    expect(providerConfigSeed(entry)).toMatchObject({ authMode: "key", keyOptional: true });
    expect(deriveProviderPresets().find(candidate => candidate.id === "claude-agent-sdk"))
      .toMatchObject({ auth: "key", keyOptional: true });
  });

  test("the adapter inherits the shared coding-agent contract instead of a second wire", () => {
    expect(getAdapterDefinition("claude-agent-sdk")?.contractParent).toBe("codebuddy");
    expect(effectiveAdapterContract("claude-agent-sdk").wire).toBe("codebuddy");
  });
});

describe("claude-agent-sdk options keep the harness in charge and tools with the client", () => {
  test("keeps the harness preset and APPENDS the caller's contract to it", () => {
    const prompt = buildAgentSdkSystemPrompt(
      parsed({ context: { systemPrompt: ["Be terse."], messages: [] } } as OcxParsedRequest),
      false,
    );
    // The 2.65.0 construction replaced this preset; replacing it is what made the turn a puppet
    // rather than the harness. `custom` would be that regression, so pin the shape, not just the text.
    expect(prompt).toEqual({ type: "preset", preset: "claude_code", append: "Be terse." });
  });

  test("a caller with no system prompt still gets the preset, not an empty replacement", () => {
    expect(buildAgentSdkSystemPrompt(parsed(), false)).toEqual({ type: "preset", preset: "claude_code" });
  });

  test("the capture-bridge directive joins the caller's prompt when a catalog is advertised", () => {
    const prompt = buildAgentSdkSystemPrompt(
      parsed({ context: { systemPrompt: ["Be terse."], messages: [] } } as OcxParsedRequest),
      true,
    ) as { append?: string };
    expect(prompt.append?.startsWith("Be terse.")).toBe(true);
    expect(prompt.append).toContain("captures call intent only");
  });

  test("disables built-in tools, settings, session persistence and every permission bypass", () => {
    const options = buildAgentSdkTurnOptions({
      provider: provider(),
      parsed: parsed(),
      env: { HOME: "/Users/operator" },
      cwd: "/tmp/ocx-scratch",
      abortController: new AbortController(),
      onStderr: () => undefined,
    });
    expect(options.tools).toEqual([]);
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.persistSession).toBe(false);
    expect(options.includePartialMessages).toBe(true);
    // Neutral on purpose: the preset reports its working directory and git state to the model.
    expect(options.cwd).toBe("/tmp/ocx-scratch");
    expect(options.model).toBe("claude-sonnet-5");
    expect(options.permissionMode).toBeUndefined();
    expect(options.allowedTools).toBeUndefined();
    expect(options.mcpServers).toBeUndefined();
    // Absent means "the build the SDK ships", which is the version-matched one; the compiled-binary
    // path sets it explicitly (see the preflight test below).
    expect(options.pathToClaudeCodeExecutable).toBeUndefined();
    expect(options.env).toEqual({ HOME: "/Users/operator" });
  });

  test("maps the caller's reasoning effort onto an SDK effort level", () => {
    expect(buildAgentSdkEffort(provider(), parsed({ options: { reasoning: "high" } }))).toBe("high");
  });

  test("drops an effort the SDK does not accept instead of sending it", () => {
    const mapped = provider({ reasoningEffortMap: { high: "minimal" } });
    expect(buildAgentSdkEffort(mapped, parsed({ options: { reasoning: "high" } }))).toBeUndefined();
  });

  test("serves the catalog as an in-process SDK MCP server that allows exactly its tools", async () => {
    const catalog = await buildClaudeAgentSdkToolBridge(withTools(["alpha", "beta"]));
    expect(catalog).toBeDefined();
    const options = buildAgentSdkTurnOptions({
      provider: provider(),
      parsed: withTools(["alpha", "beta"]),
      env: {},
      cwd: "/tmp/ocx-scratch",
      abortController: new AbortController(),
      onStderr: () => undefined,
      toolCatalog: {
        serverName: catalog!.serverName,
        instance: catalog!.instance,
        allowedNames: [...catalog!.emittedNameMap.keys()],
      },
    });
    const servers = options.mcpServers as Record<string, { type: string; name: string; instance: unknown }>;
    expect(Object.keys(servers)).toEqual([CLAUDE_AGENT_SDK_MCP_SERVER_NAME]);
    expect(servers[CLAUDE_AGENT_SDK_MCP_SERVER_NAME]).toMatchObject({
      type: "sdk",
      name: CLAUDE_AGENT_SDK_MCP_SERVER_NAME,
      instance: catalog!.instance,
    });
    expect(options.allowedTools).toEqual([...catalog!.emittedNameMap.keys()]);
    // The advertised schema is the client's own JSON Schema, not a re-derived one.
    expect(catalog!.tools[0]).toMatchObject({
      description: "Tool alpha",
      inputSchema: { type: "object", properties: { a: { type: "number" } } },
    });
  });

  test("a request without tools gets no MCP server at all", async () => {
    expect(await buildClaudeAgentSdkToolBridge(parsed())).toBeUndefined();
  });
});

describe("claude-agent-sdk child environment carries no credential and no proxy destination", () => {
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

  test("keeps the home directory the harness signs in from, and quiets its own telemetry", () => {
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

  test("carries the account name the harness resolves its keychain sign-in by, and nothing else new", () => {
    // Without USER the harness reports "not logged in" on a signed-in machine: it looks its own
    // keychain entry up by account name. The value is a name, not a credential.
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

describe("claude-agent-sdk runTurn fails closed before the harness starts", () => {
  test("a non-canonical base URL is refused", async () => {
    const sdk = fakeSdk([]);
    const adapter = createClaudeAgentSdkAdapter(
      provider({ baseUrl: "https://evil.example.test" }),
      { loadSdk: async () => sdk.module },
    );
    const events = await run(adapter, parsed());
    expect(sdk.state.started).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", code: "non_canonical_destination", retryable: false });
  });

  test("an image is refused rather than handed to a harness that was never shown to carry it", async () => {
    const sdk = fakeSdk([]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const events = await run(adapter, parsed({
      context: {
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image", imageUrl: "data:image/png;base64,iVBORw0KGgo=" },
          ],
          timestamp: 0,
        }],
      },
    } as OcxParsedRequest));
    // Same refusal the Qoder presets make: a dropped image answers the wrong question confidently,
    // and no headless harness turn was shown to deliver image bytes to the model.
    expect(sdk.state.started).toBe(0);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 400, code: "unsupported_input_modality", retryable: false });
  });

  test("an unusable tool catalog is the client's 400, not a turn that dies inside the loop", async () => {
    const sdk = fakeSdk([]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const tooMany = Array.from({ length: 129 }, (_value, index) => `tool-${index}`);
    const events = await run(adapter, withTools(tooMany));
    expect(sdk.state.started).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", status: 400, code: "tool_catalog_invalid", retryable: false });
  });

  test("a compiled binary drives the Claude Code on PATH, and names the install when it is missing", async () => {
    const sdk = fakeSdk([initFrame(), resultFrame()]);
    const missing = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => sdk.module,
      isStandalone: () => true,
      which: () => undefined,
    });
    const refused = await run(missing, parsed());
    expect(sdk.state.started).toBe(0);
    expect(refused[0]).toMatchObject({ type: "error", code: "cli_not_found", retryable: false });
    expect(String((refused[0] as { message: string }).message)).toContain("npm install -g @anthropic-ai/claude-code");

    const resolved = fakeSdk([initFrame(), resultFrame()]);
    const adapter = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => resolved.module,
      isStandalone: () => true,
      which: () => "/opt/homebrew/bin/claude",
    });
    await run(adapter, parsed());
    expect(resolved.options[0]!.pathToClaudeCodeExecutable).toBe("/opt/homebrew/bin/claude");
  });

  test("an SDK that cannot be loaded is reported as such, not as a provider failure", async () => {
    const adapter = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => { throw new Error("Cannot find module '@anthropic-ai/claude-agent-sdk'"); },
    });
    const events = await run(adapter, parsed());
    expect(events[0]).toMatchObject({ type: "error", status: 500, code: "claude_agent_sdk_unavailable" });
    expect(String((events[0] as { message: string }).message)).toContain("claude-agent-sdk");
  });

  test("an aborted request never starts a turn", async () => {
    const sdk = fakeSdk([]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const events = await run(adapter, parsed(), AbortSignal.abort());
    expect(sdk.state.started).toBe(0);
    expect(events[0]).toMatchObject({ type: "error", message: "Claude Agent SDK turn was aborted before start." });
  });
});

describe("claude-agent-sdk runTurn streams a subscription turn", () => {
  test("runs without any stored API key, because the harness owns the account", async () => {
    const sdk = fakeSdk([
      initFrame(),
      textFrame("Hel"),
      textFrame("lo"),
      { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "think" } } },
      resultFrame({ input_tokens: 7, output_tokens: 2 }),
    ]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const events = await run(adapter, parsed());
    expect(sdk.state.started).toBe(1);
    expect(events.filter(event => event.type === "text_delta").map(event => (event as { text: string }).text).join("")).toBe("Hello");
    expect(events.some(event => event.type === "thinking_delta")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "done", usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } });
    // The replayed conversation travels as the prompt the harness reads, and the turn is ended from
    // this side once the stream is over.
    expect(JSON.stringify(sdk.prompts[0])).toContain("hello");
    expect(sdk.state.returned).toBe(1);
    expect(sdk.options[0]!.env).toMatchObject({ HOME: process.env.HOME! });
  });

  test("runs in a scratch working directory and removes it once the harness is gone", async () => {
    const sdk = fakeSdk([initFrame(), textFrame("ok"), resultFrame({ input_tokens: 1, output_tokens: 1 })]);
    const removed: string[] = [];
    const adapter = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => sdk.module,
      makeScratchDir: async () => "/tmp/ocx-turn-scratch",
      removeScratchDir: async (dir) => { removed.push(dir); },
    });
    await run(adapter, parsed());
    expect(sdk.options[0]!.cwd).toBe("/tmp/ocx-turn-scratch");
    expect(removed).toEqual(["/tmp/ocx-turn-scratch"]);
  });

  test("a scratch directory that cannot be created fails the turn instead of leaking a cwd", async () => {
    const sdk = fakeSdk([]);
    const adapter = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => sdk.module,
      makeScratchDir: async () => { throw new Error("EROFS: read-only file system"); },
    });
    const events = await run(adapter, parsed());
    expect(sdk.state.started).toBe(0);
    expect(events[0]).toMatchObject({
      type: "error",
      status: 500,
      code: "claude_agent_sdk_scratch_unavailable",
      retryable: false,
    });
  });

  test("an unauthenticated harness becomes an actionable sign-in error", async () => {
    // Verbatim shape of a real unauthenticated turn: a terminal `result` frame, no HTTP status.
    const sdk = fakeSdk([{
      type: "result",
      subtype: "success",
      is_error: true,
      result: "Not logged in · Please run /login",
    }]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
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

  test("a stream that ends without a terminal result fails closed, with the harness's stderr", async () => {
    const module: ClaudeAgentSdkModule = {
      query: params => {
        (params.options.stderr as (chunk: string) => void)("harness exploded before any frame");
        const generator = (async function* () { yield initFrame() as Record<string, never>; })();
        return {
          [Symbol.asyncIterator]: () => generator,
          return: async (value?: unknown) => await generator.return(value),
        } as ClaudeAgentSdkQuery;
      },
    };
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => module });
    const events = await run(adapter, parsed());
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "protocol_error", retryable: false });
    expect(String((events.at(-1) as { message: string }).message)).toContain("harness exploded before any frame");
  });

  test("one huge stderr chunk is cut at ingestion, in bytes rather than code units", async () => {
    // 8 KiB of "…" is 24 KiB of UTF-8. Cutting code units only after the join retains the chunk
    // in full and lets the message carry three times the advertised bound, so both the ingestion and the
    // final cut have to be byte-exact.
    const huge = "…".repeat(8 * 1024);
    const module: ClaudeAgentSdkModule = {
      query: params => {
        (params.options.stderr as (chunk: string) => void)(huge);
        const generator = (async function* () { yield initFrame() as Record<string, never>; })();
        return {
          [Symbol.asyncIterator]: () => generator,
          return: async (value?: unknown) => await generator.return(value),
        } as ClaudeAgentSdkQuery;
      },
    };
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => module });
    const events = await run(adapter, parsed());
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "protocol_error", retryable: false });
    const message = String((events.at(-1) as { message: string }).message);
    expect(message).toContain("[truncated by opencodex]");
    expect(Buffer.byteLength(message, "utf8")).toBeLessThanOrEqual(8 * 1024 + 128);
  });

  test("a turn that never produces a frame is bounded by the wall-clock ceiling", async () => {
    const sdk = fakeSdk([], { park: true });
    const adapter = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => sdk.module,
      timeoutMs: 20,
      reapTimeoutMs: 50,
    });
    const events = await run(adapter, parsed());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 504, code: "timeout", retryable: true });
    // The turn ended from this side; the harness does not get to hold the request open.
    expect(sdk.state.returned).toBe(1);
  });

  test("a client disconnect ends a parked turn", async () => {
    const sdk = fakeSdk([initFrame()], { park: true });
    const adapter = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => sdk.module,
      reapTimeoutMs: 50,
    });
    const controller = new AbortController();
    const events: AdapterEvent[] = [];
    const turn = adapter.runTurn!(parsed(), incoming(controller.signal), event => events.push(event));
    setTimeout(() => controller.abort(), 10);
    await turn;
    expect(events.at(-1)).toMatchObject({ type: "error", retryable: false });
    expect(String((events.at(-1) as { message: string }).message)).toContain("aborted");
    expect(sdk.state.returned).toBe(1);
  });
});

describe("claude-agent-sdk serves the client's catalog through a capture-only MCP server", () => {
  test("captures a call, renames it to the wire name, and ends the leg with done(tool_use)", async () => {
    const catalog = await buildClaudeAgentSdkToolBridge(withTools(["alpha"]));
    const emitted = [...catalog!.emittedNameMap.keys()][0]!;
    const sdk = fakeSdk([
      initFrame([bridgeConnected]),
      ...toolCallFrames("tu_1", emitted, "{\"a\":1}"),
      messageStop,
    ], { park: true });
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module, reapTimeoutMs: 50 });
    const events = await run(adapter, withTools(["alpha"]));
    expect(events[0]).toMatchObject({ type: "tool_call_start", name: "alpha", id: "tu_1" });
    expect(events[1]).toMatchObject({ type: "tool_call_delta", arguments: "{\"a\":1}" });
    expect(events[2]).toMatchObject({ type: "tool_call_end" });
    // The capture handler never answers, so the harness parks after message_stop: the completed call
    // IS this turn's output, and the client executes it.
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
    expect(sdk.state.returned).toBe(1);
    expect(sdk.options[0]!.allowedTools).toEqual([emitted]);
  });

  test("an init frame that does not report the bridge as connected fails closed", async () => {
    const catalog = await buildClaudeAgentSdkToolBridge(withTools(["alpha"]));
    const emitted = [...catalog!.emittedNameMap.keys()][0]!;
    const sdk = fakeSdk([
      initFrame([{ name: CLAUDE_AGENT_SDK_MCP_SERVER_NAME, status: "failed" }]),
      ...toolCallFrames("tu_1", emitted),
      messageStop,
    ]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const events = await run(adapter, withTools(["alpha"]));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", status: 502, code: "tool_bridge_init_mismatch", retryable: false });
  });

  test("a call before the init handshake fails closed", async () => {
    const catalog = await buildClaudeAgentSdkToolBridge(withTools(["alpha"]));
    const emitted = [...catalog!.emittedNameMap.keys()][0]!;
    const sdk = fakeSdk([
      ...toolCallFrames("tu_1", emitted),
      initFrame([bridgeConnected]),
      messageStop,
    ]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const events = await run(adapter, withTools(["alpha"]));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "tool_bridge_init_missing" });
  });

  test("a call outside the isolated catalog fails closed", async () => {
    const sdk = fakeSdk([
      initFrame([bridgeConnected]),
      ...toolCallFrames("tu_1", `mcp__${CLAUDE_AGENT_SDK_MCP_SERVER_NAME}__not-in-the-catalog`),
      messageStop,
    ]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const events = await run(adapter, withTools(["alpha"]));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "undeclared_tool_call", retryable: false });
  });

  test("more tool calls than the turn cap allows fails closed", async () => {
    const catalog = await buildClaudeAgentSdkToolBridge(withTools(["alpha"]));
    const emitted = [...catalog!.emittedNameMap.keys()][0]!;
    const calls = Array.from({ length: 17 }, (_value, index) => toolCallFrames(`tu_${index}`, emitted));
    const sdk = fakeSdk([initFrame([bridgeConnected]), ...calls.flat(), messageStop]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const events = await run(adapter, withTools(["alpha"]));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "tool_call_limit", retryable: false });
  });

  test("opened tool blocks beyond the turn cap fail closed before any of them closes", async () => {
    // The parser buffers a block until its stop, so a stream that only opens blocks emits no
    // tool_call_start at all. The cap therefore has to be enforced when the block opens: with the
    // emission counted instead, this stream would run on and only fail at message_stop, and for a
    // different reason.
    const catalog = await buildClaudeAgentSdkToolBridge(withTools(["alpha"]));
    const emitted = [...catalog!.emittedNameMap.keys()][0]!;
    const opens = Array.from({ length: 17 }, (_value, index) => ({
      type: "stream_event",
      event: { type: "content_block_start", index, content_block: { type: "tool_use", id: `tu_` + index, name: emitted } },
    }));
    const sdk = fakeSdk([initFrame([bridgeConnected]), ...opens, messageStop]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const events = await run(adapter, withTools(["alpha"]));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "tool_call_limit", retryable: false });
  });

  test("the shared tool-start ceiling fails a turn closed even without a tool bridge", async () => {
    // The parser's own ceiling applies to every turn, bridge or not, and since #6081/#6083 it is
    // enforced before the block is allocated: the refused start never reaches the completeness
    // invariants, so the flag it leaves behind is the only record that a call went missing.
    const opens = Array.from({ length: 17 }, (_value, index) => ({
      type: "stream_event",
      event: { type: "content_block_start", index, content_block: { type: "tool_use", id: "tu_" + index, name: "alpha" } },
    }));
    const sdk = fakeSdk([...opens, messageStop]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const events = await run(adapter, parsed());
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "tool_call_limit", retryable: false });
  });

  test("a retained tool argument past the request budget keeps the budget's own error code", async () => {
    // The parser charges tool identity and argument fragments to the request's translator budget.
    // This adapter owns a capture path, so the charge has to reach it through the parse state, and
    // the budget's verdict has to survive instead of becoming the generic SDK error.
    const catalog = await buildClaudeAgentSdkToolBridge(withTools(["alpha"]));
    const emitted = [...catalog!.emittedNameMap.keys()][0]!;
    const sdk = fakeSdk([
      initFrame([bridgeConnected]),
      ...toolCallFrames("tu_1", emitted, "x".repeat(64)),
      messageStop,
    ]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const budget = createTestTranslatorBudget({ maxCallArgumentBytes: Buffer.byteLength(emitted) + 8 });
    const events = await run(adapter, withTools(["alpha"]), undefined, budget);
    expect(events.at(-1)).toMatchObject({
      type: "error", status: 502, code: "translation_buffer_limit", retryable: false,
    });
  });

  test("a required tool call that never happens must not look like a completion", async () => {
    const sdk = fakeSdk([
      initFrame([bridgeConnected]),
      textFrame("I will not call it."),
      resultFrame({ input_tokens: 3, output_tokens: 4 }),
    ]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const events = await run(adapter, withTools(["alpha"], { options: { toolChoice: "required" } }));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "tool_call_required", retryable: false });
  });

  test("a parallel batch that reuses one block index arrives as two complete calls", async () => {
    // The shared parser buffers tool blocks now (#5945): CodeBuddy reuses one content-block index
    // for a parallel batch, intermediate blocks never receive a stop, and only the last one does.
    // The completeness invariants above read that state, so this pins the pairing they depend on.
    const catalog = await buildClaudeAgentSdkToolBridge(withTools(["alpha", "beta"]));
    const [first, second] = [...catalog!.emittedNameMap.keys()];
    const sdk = fakeSdk([
      initFrame([bridgeConnected]),
      { type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_a", name: first } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"a\":1}" } } },
      { type: "stream_event", event: { type: "content_block_start", index: 2, content_block: { type: "tool_use", id: "tu_b", name: second } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: "{\"b\":2}" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 2 } },
      messageStop,
    ], { park: true });
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module, reapTimeoutMs: 50 });
    const events = await run(adapter, withTools(["alpha", "beta"]));
    expect(events.filter(event => event.type === "tool_call_start").map(event => event.name)).toEqual(["alpha", "beta"]);
    expect(events.filter(event => event.type === "tool_call_delta").map(event => event.arguments)).toEqual(["{\"a\":1}", "{\"b\":2}"]);
    expect(events.filter(event => event.type === "tool_call_end")).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ type: "done", stopReason: "tool_use", endTurn: false });
  });

  test("a result that arrives while a captured call is still open fails closed", async () => {
    const catalog = await buildClaudeAgentSdkToolBridge(withTools(["alpha"]));
    const emitted = [...catalog!.emittedNameMap.keys()][0]!;
    const sdk = fakeSdk([
      initFrame([bridgeConnected]),
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tu_1", name: emitted } } },
      resultFrame({ input_tokens: 1, output_tokens: 1 }),
    ]);
    const adapter = createClaudeAgentSdkAdapter(provider(), { loadSdk: async () => sdk.module });
    const events = await run(adapter, withTools(["alpha"]));
    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "protocol_error", retryable: false });
  });
});

/**
 * The harness process a proxied turn starts, and what the turn does with it.
 *
 * The SDK's cleanup is bounded twice over: `Query.performCleanup` waits 2000 ms for
 * `transport.waitForExit()`, and the transport schedules SIGTERM 2000 ms after close with SIGKILL
 * 5000 ms after that, both timers unref'd. `query.return()` resolving is therefore not evidence that
 * the harness is gone - and a turn that deleted its scratch cwd on that signal would leave the
 * process, its pipes and its working directory behind. These cases pin the turn to the process: a
 * bounded TERM -> grace -> KILL ladder, awaited through the child's real `close`.
 */
interface FakeHarnessChild extends EventEmitter {
  pid: number;
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  killed: boolean;
  exitCode: number | null;
  signalCode: string | null;
  kill: (signal?: string) => boolean;
}

function fakeHarnessChild(options: {
  terminatesOn?: "SIGTERM" | "SIGKILL" | "never";
  stderr?: string;
  /** A launcher/descendant inherited the harness's stdio: the process ends, `close` never arrives. */
  exitWithoutClose?: boolean;
  /** The runtime refuses the signal: `kill()` reports that nothing was delivered. */
  refuseSignals?: boolean;
  /** Runs when the child ends, so a test can pin the order of the teardown. */
  onEnd?: () => void;
} = {}) {
  const terminatesOn = options.terminatesOn ?? "SIGKILL";
  const child = new EventEmitter() as FakeHarnessChild;
  child.pid = 4711;
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.stdout = new Readable({ read() { /* the harness's stdout belongs to the SDK, not the test */ } });
  child.stderr = new Readable({ read() { /* data is emitted directly below */ } });
  child.killed = false;
  child.exitCode = null;
  child.signalCode = null;
  const signals: string[] = [];
  let closed = false;
  let ended = false;
  child.kill = (signal?: string) => {
    signals.push(signal ?? "SIGTERM");
    if (options.refuseSignals === true) return false;
    // A stuck harness shrugs off SIGTERM; only the signal it does not survive ends it, and even then
    // the process reports that end asynchronously through `close`, which is what the turn must await.
    if (terminatesOn !== "never" && signal === terminatesOn && !ended) {
      ended = true;
      child.killed = true;
      const ending = signal ?? "SIGTERM";
      setTimeout(() => {
        if (options.stderr !== undefined) child.stderr.emit("data", Buffer.from(options.stderr));
        child.exitCode = 0;
        child.signalCode = ending;
        child.emit("exit", null, ending);
        if (options.exitWithoutClose !== true) {
          closed = true;
          child.emit("close", null, ending);
        }
        options.onEnd?.();
      }, 3);
    }
    return true;
  };
  return { child, signals, closed: () => closed };
}

describe("claude-agent-sdk owns the harness process it starts", () => {
  test("a TERM-resistant harness is killed and awaited before the scratch cwd goes", async () => {
    const harness = fakeHarnessChild();
    const removed: string[] = [];
    let closedAtRemoval: boolean | undefined;
    const sdk = fakeSdk([initFrame(), textFrame("ok"), resultFrame()], { spawnHarness: true });
    const adapter = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => sdk.module,
      spawnHarnessProcess: () => harness.child as unknown as ChildProcess,
      // A unit test never signals a real process group.
      killHarnessProcessTree: () => false,
      killGraceMs: 20,
      reapTimeoutMs: 200,
      makeScratchDir: async () => "/tmp/ocx-owned-harness",
      removeScratchDir: async dir => {
        closedAtRemoval = harness.closed();
        removed.push(dir);
      },
    });

    const events = await run(adapter, parsed());

    // The SDK is handed the hook, so the turn owns the process instead of reading the SDK's clock.
    expect(typeof sdk.options[0]!.spawnClaudeCodeProcess).toBe("function");
    // The turn still completes: the ladder is teardown, not another failure path.
    expect(events.at(-1)).toMatchObject({ type: "done" });
    // TERM first, KILL only once the grace window passed with the process still alive.
    expect(harness.signals).toEqual(["SIGTERM", "SIGKILL"]);
    // The cwd is released on evidence: `query.return()` had already resolved while this child was
    // still running, which is exactly the state the SDK leaves behind.
    expect(removed).toEqual(["/tmp/ocx-owned-harness"]);
    expect(closedAtRemoval).toBe(true);
  });

  test("the harness's stderr still reaches the turn through the owned pipe", async () => {
    // The SDK's local spawn - the one the hook replaces - was the only thing that read the child's
    // stderr and handed it to `Options.stderr`. Owning the process means owning that pipe as well, or
    // a harness that dies reports nothing about why.
    const harness = fakeHarnessChild({ terminatesOn: "SIGTERM", stderr: "harness exploded before any frame" });
    const sdk = fakeSdk([initFrame()], { spawnHarness: true });
    const adapter = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => sdk.module,
      spawnHarnessProcess: () => harness.child as unknown as ChildProcess,
      // A unit test never signals a real process group.
      killHarnessProcessTree: () => false,
      killGraceMs: 20,
      reapTimeoutMs: 200,
      makeScratchDir: async () => "/tmp/ocx-owned-harness-stderr",
      removeScratchDir: async () => undefined,
    });

    const events = await run(adapter, parsed());

    expect(events.at(-1)).toMatchObject({ type: "error", status: 502, code: "protocol_error", retryable: false });
    expect(String((events.at(-1) as { message: string }).message)).toContain("harness exploded before any frame");
  });
});

/**
 * What the ladder can and cannot establish about the process it owns.
 *
 * `close` is a claim about stdio as much as about the process: a launcher hands its pipes to a
 * descendant, the harness ends, the pipe stays open and `close` is withheld for good. A ladder that
 * watches only `close` then waits out its entire ceiling and reports a clean teardown for a process
 * tree it never confirmed. These cases pin the difference: exit without a drain, a refused signal,
 * and a child that never ends at all.
 */
describe("claude-agent-sdk reports the harness teardown it could not confirm", () => {
  function supervisorFor(
    harness: ReturnType<typeof fakeHarnessChild>,
    options: { killProcessTree?: (signal: NodeJS.Signals, pid: number) => boolean; platform?: NodeJS.Platform } = {},
  ) {
    const supervisor = createHarnessProcessSupervisor({
      onStderr: () => undefined,
      spawn: () => harness.child as unknown as ChildProcess,
      killGraceMs: 10,
      reapTimeoutMs: 20,
      // A unit test never signals a real process group; the platform's tree call is a seam here.
      killProcessTree: options.killProcessTree ?? (() => false),
      ...(options.platform !== undefined ? { platform: options.platform } : {}),
    });
    supervisor.spawn({ command: "claude", args: [], env: {}, signal: new AbortController().signal });
    return supervisor;
  }

  test("an exit with an inherited pipe still gets the tree signal, then the stdio back", async () => {
    const harness = fakeHarnessChild({ terminatesOn: "SIGTERM", exitWithoutClose: true });
    const treeSignals: NodeJS.Signals[] = [];

    const outcome = await supervisorFor(harness, {
      killProcessTree: signal => { treeSignals.push(signal); return true; },
    }).terminate();

    // The direct parent is gone - that much `exit` carries - while `close` never arrives, so the
    // process question is the descendant holding those pipes, and the group is the only handle on it.
    // The KILL pass runs for that child too: skipping it because the parent already exited is what
    // left a TERM-resistant descendant with the cwd still underneath it.
    expect(treeSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(harness.child.exitCode).toBe(0);
    expect(harness.child.stdout.destroyed).toBe(true);
    expect(harness.child.stderr.destroyed).toBe(true);
    expect(outcome).toEqual({
      confirmed: false,
      allExited: true,
      unresolved: [{ pid: 4711, reason: "pipes-held", signalFailed: false }],
      quarantined: 1,
    });
  });

  test("a tree that could not be signalled stays uncertain when the parent exits later in the ladder", async () => {
    // The timing, not the state: TERM reaches no tree because the harness shrugs it off and the tree
    // call is refused while the parent is still alive; the parent exits inside the KILL window, after
    // the direct signal, with a descendant holding the inherited pipes. Reading the tree only at the
    // instant of the signal loses this case - the child is `exited`, nothing recorded the unreached
    // tree, and the verdict would be `pipes-held` with "everything exited" for a tree never touched.
    const harness = fakeHarnessChild({ terminatesOn: "SIGKILL", exitWithoutClose: true });

    const outcome = await supervisorFor(harness, { killProcessTree: () => false }).terminate();

    expect(outcome).toEqual({
      confirmed: false,
      allExited: false,
      unresolved: [{ pid: 4711, reason: "unresolved-tree", signalFailed: false }],
      quarantined: 1,
    });
  });

  test("a tree that cannot be signalled while the parent is gone is an unresolved tree, not a clean exit", async () => {
    // The dead-parent case: `exit` arrived without `close`, so a descendant holds the pipes, and the
    // platform cannot walk a tree from a pid that no longer exists (`taskkill /PID <dead> /T` on
    // Windows). Nothing here can name or signal that descendant, so it is not rounded to "gone" and
    // the working directory it may still be using is not released.
    const harness = fakeHarnessChild({ terminatesOn: "SIGTERM", exitWithoutClose: true });

    const outcome = await supervisorFor(harness, { platform: "win32", killProcessTree: () => false }).terminate();

    expect(outcome).toEqual({
      confirmed: false,
      allExited: false,
      unresolved: [{ pid: 4711, reason: "unresolved-tree", signalFailed: false }],
      quarantined: 1,
    });
    expect(harnessQuarantineSnapshot()).toEqual([{ pid: 4711, reason: "unresolved-tree", ageMs: expect.any(Number) }]);
    // The survivor keeps the bounded cleanup lease, which is the whole point of taking it: the
    // teardown outlives its turn, and it does not do so unaccounted for.
    expect(harnessTeardownMetrics().active).toBe(1);
  });

  test("a quarantined survivor that closes later hands its cleanup lease back", async () => {
    const harness = fakeHarnessChild({ terminatesOn: "never" });

    const outcome = await supervisorFor(harness).terminate();
    expect(outcome.allExited).toBe(false);
    expect(harnessTeardownMetrics().active).toBe(1);

    // The process reports its exit after the turn is over. The next turn's sweep sees it on the
    // handle that was pinned to that process, so the lease comes back with it and nothing is left
    // behind in the account.
    harness.child.emit("exit", 0, "SIGKILL");
    harness.child.emit("close", 0, "SIGKILL");
    expect(reapHarnessQuarantine()).toBe(0);
    expect(harnessQuarantineSnapshot()).toEqual([]);
    expect(harnessTeardownMetrics().active).toBe(0);
  });

  test("the bound refuses the next harness instead of accounting for it afterwards", () => {
    // Capacity is reserved in the spawn hook, so the bound decides whether a process exists at all.
    // Reporting it after the ladder would describe a pile that was allowed to grow.
    const held: ReturnType<typeof fakeHarnessChild>[] = [];
    for (let index = 0; index < MAX_ACTIVE_HARNESS_TEARDOWNS; index += 1) {
      const harness = fakeHarnessChild({ terminatesOn: "never" });
      held.push(harness);
      supervisorFor(harness);
    }
    expect(harnessTeardownMetrics().active).toBe(MAX_ACTIVE_HARNESS_TEARDOWNS);

    const refusedHarness = fakeHarnessChild();
    let refused: unknown;
    try {
      supervisorFor(refusedHarness);
    } catch (err) {
      refused = err;
    }

    expect(refused).toBeInstanceOf(HarnessCapacityError);
    expect((refused as HarnessCapacityError).code).toBe(HARNESS_CAPACITY_CODE);
    expect(String((refused as Error).message)).toContain(`capacity reached (${MAX_ACTIVE_HARNESS_TEARDOWNS}`);
    // Nothing was started for the refused turn, and the accounting did not move.
    expect(refusedHarness.signals).toEqual([]);
    expect(harnessTeardownMetrics().active).toBe(MAX_ACTIVE_HARNESS_TEARDOWNS);
  });

  test("an unobservable survivor keeps its capacity past the age warning", async () => {
    // A process that has not reported `close` has not been shown to be gone. The age bound only says
    // so out loud: the entry and its lease stay, because returning the capacity would put the leak
    // back where it started - this time behind a count that says the harness is free.
    const harness = fakeHarnessChild({ terminatesOn: "never" });
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => { warnings.push(args.map(String).join(" ")); };
    try {
      const outcome = await supervisorFor(harness).terminate();
      expect(outcome.quarantined).toBe(1);

      const muchLater = Date.now() + 10 * 60_000;
      expect(reapHarnessQuarantine(muchLater)).toBe(1);
      expect(harnessQuarantineSnapshot(muchLater)).toMatchObject([{ pid: 4711, reason: "running" }]);
      expect(harnessTeardownMetrics().active).toBe(1);
      expect(warnings.join("\n")).toContain("capacity stays reserved until it reports an exit");

      // Named once, not once per sweep.
      expect(reapHarnessQuarantine(muchLater + 1_000)).toBe(1);
      expect(warnings.filter(line => line.includes("capacity stays reserved"))).toHaveLength(1);
      expect(harnessTeardownMetrics().active).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test.skipIf(process.platform === "win32")(
    "a real descendant whose launcher exits is killed with the group, not abandoned",
    async () => {
      // No EventEmitter and no injected verdict: a real launcher exits immediately and leaves a real
      // descendant holding the inherited pipes, and that descendant ignores SIGTERM. The only thing
      // that can end it is the group KILL - which the previous ladder skipped, because the direct
      // parent had already exited.
      const marker = `ocx-descendant-${Math.random().toString(36).slice(2, 10)}`;
      const descendantAlive = (): boolean => {
        try {
          execFileSync("pgrep", ["-f", marker], { stdio: "pipe" });
          return true;
        } catch {
          return false;
        }
      };
      const supervisor = createHarnessProcessSupervisor({ onStderr: () => undefined, killGraceMs: 200, reapTimeoutMs: 3_000 });
      try {
        supervisor.spawn({
          command: "/bin/sh",
          args: ["-c", `sh -c 'trap "" TERM; while :; do sleep 0.2; done # ${marker}' & exit 0`],
          env: {},
          signal: new AbortController().signal,
        });
        await Bun.sleep(150);
        expect(descendantAlive()).toBe(true);

        const outcome = await supervisor.terminate();

        expect(outcome.confirmed).toBe(true);
        expect(outcome.allExited).toBe(true);
        expect(descendantAlive()).toBe(false);
      } finally {
        try { execFileSync("pkill", ["-f", marker], { stdio: "pipe" }); } catch { /* already gone */ }
      }
    },
  );

  test("a refused signal is reported rather than read as a dead process", async () => {
    const harness = fakeHarnessChild({ terminatesOn: "never", refuseSignals: true });

    const outcome = await supervisorFor(harness).terminate();

    expect(outcome).toEqual({
      confirmed: false,
      allExited: false,
      unresolved: [{ pid: 4711, reason: "running", signalFailed: true }],
      quarantined: 1,
    });
  });

  test("a harness that survives the whole ladder is named as still running", async () => {
    const harness = fakeHarnessChild({ terminatesOn: "never" });

    const outcome = await supervisorFor(harness).terminate();

    expect(harness.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(outcome).toEqual({
      confirmed: false,
      allExited: false,
      unresolved: [{ pid: 4711, reason: "running", signalFailed: false }],
      quarantined: 1,
    });
  });
});

describe("claude-agent-sdk does not answer the client underneath a live harness", () => {
  test("an unresolved teardown keeps the scratch cwd, names it, and withholds the answer", async () => {
    const harness = fakeHarnessChild({ terminatesOn: "never" });
    const removed: string[] = [];
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => { warnings.push(args.map(String).join(" ")); };
    try {
      const sdk = fakeSdk([initFrame(), textFrame("ok"), resultFrame()], { spawnHarness: true });
      const adapter = createClaudeAgentSdkAdapter(provider(), {
        loadSdk: async () => sdk.module,
        spawnHarnessProcess: () => harness.child as unknown as ChildProcess,
        killHarnessProcessTree: () => false,
        killGraceMs: 10,
        reapTimeoutMs: 20,
        makeScratchDir: async () => "/tmp/ocx-unconfirmed-harness",
        removeScratchDir: async dir => { removed.push(dir); },
      });

      const events = await run(adapter, parsed());

      // A completed answer is not this turn's to hand over while a process it started is still
      // alive: the client would read it as the turn's whole outcome, and every repeat of the same
      // state would add another harness nobody is accounting for. The cwd a survivor may still be
      // using stays where it is, and the survivor is named instead of rounded to a clean exit.
      expect(events.some(event => event.type === "done")).toBe(false);
      expect(events.at(-1)).toMatchObject({
        type: "error", status: 502, code: "harness_teardown_unresolved", retryable: false,
      });
      expect(removed).toEqual([]);
      expect(warnings.join("\n")).toContain("leaving /tmp/ocx-unconfirmed-harness in place");
      expect(warnings.join("\n")).toContain("4711:running");
      expect(warnings.join("\n")).toContain("1 quarantined");
      expect(harnessQuarantineSnapshot()).toMatchObject([{ pid: 4711, reason: "running" }]);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("an unreachable tree is named, keeps the cwd, and never becomes a completed turn", async () => {
    // The turn-level shape of the Windows dead-parent case: the harness ended while a descendant kept
    // its pipes, and the tree could not be walked from a pid that is gone.
    const harness = fakeHarnessChild({ terminatesOn: "SIGTERM", exitWithoutClose: true });
    const removed: string[] = [];
    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
      const sdk = fakeSdk([initFrame(), textFrame("ok"), resultFrame()], { spawnHarness: true });
      const adapter = createClaudeAgentSdkAdapter(provider(), {
        loadSdk: async () => sdk.module,
        spawnHarnessProcess: () => harness.child as unknown as ChildProcess,
        killHarnessProcessTree: () => false,
        harnessPlatform: "win32",
        killGraceMs: 10,
        reapTimeoutMs: 20,
        makeScratchDir: async () => "/tmp/ocx-unresolved-tree",
        removeScratchDir: async dir => { removed.push(dir); },
      });

      const events = await run(adapter, parsed());

      expect(events.at(-1)).toMatchObject({ type: "error", code: "harness_teardown_unresolved" });
      expect(removed).toEqual([]);
      expect(harnessQuarantineSnapshot()).toMatchObject([{ pid: 4711, reason: "unresolved-tree" }]);
      expect(harnessTeardownMetrics().active).toBe(1);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("a turn above the bound is refused before a harness exists", async () => {
    // The refusal is the bound doing its job, so it is a first-class turn outcome - not a process
    // that is started and then reported as unaccounted for.
    const held = Array.from({ length: MAX_ACTIVE_HARNESS_TEARDOWNS }, () => {
      const harness = fakeHarnessChild({ terminatesOn: "never" });
      createHarnessProcessSupervisor({
        onStderr: () => undefined,
        spawn: () => harness.child as unknown as ChildProcess,
      }).spawn({ command: "claude", args: [], env: {}, signal: new AbortController().signal });
      return harness;
    });
    expect(held).toHaveLength(MAX_ACTIVE_HARNESS_TEARDOWNS);
    let spawned = 0;
    const released: string[] = [];
    const sdk = fakeSdk([initFrame(), textFrame("ok"), resultFrame()], { spawnHarness: true });
    const adapter = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => sdk.module,
      spawnHarnessProcess: () => { spawned += 1; return fakeHarnessChild().child as unknown as ChildProcess; },
      killHarnessProcessTree: () => false,
      makeScratchDir: async () => "/tmp/ocx-capacity-refused",
      removeScratchDir: async dir => { released.push(dir); },
    });

    const events = await run(adapter, parsed());

    expect(spawned).toBe(0);
    expect(events.some(event => event.type === "done")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "error", status: 503, code: HARNESS_CAPACITY_CODE, retryable: true,
    });
    // The refused turn never owned a harness, so nothing holds its working directory.
    expect(released).toEqual(["/tmp/ocx-capacity-refused"]);
  });

  test("a cancelled turn hands its harness to the cleanup lease, not to nobody", async () => {
    // The client disconnects, and core returns the turn's own admission on that cancel - that slot is
    // the turn's, and the response body it belongs to is gone. The harness is not the turn's. It is
    // still alive here, so the teardown holds a separate bounded lease until the process is confirmed
    // gone, and the turn slot being back does not mean the process is.
    //
    // The turn itself is parked: the fake SDK never ends its stream, so the only thing that can end
    // this turn is the cancellation - and the cancellation has to travel the way it does in the
    // server, from the bridge's cancel through the adapter's own abort signal.
    let turnSlotWhileHarnessAlive: number | undefined;
    let cleanupLeasesWhileHarnessAlive: number | undefined;
    const harness = fakeHarnessChild({ terminatesOn: "SIGKILL" });
    const sdk = fakeSdk([initFrame(), textFrame("ok")], { spawnHarness: true, park: true });
    const adapter = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => sdk.module,
      spawnHarnessProcess: () => harness.child as unknown as ChildProcess,
      // Sampled on the KILL pass: the client's cancel is long past, the harness has shrugged off
      // SIGTERM and is still running, and the next statement is the direct signal that ends it.
      killHarnessProcessTree: signal => {
        if (signal === "SIGKILL") {
          turnSlotWhileHarnessAlive = getActiveTurnCount();
          cleanupLeasesWhileHarnessAlive = harnessTeardownMetrics().active;
        }
        return false;
      },
      killGraceMs: 10,
      reapTimeoutMs: 200,
      makeScratchDir: async () => "/tmp/ocx-cancelled-harness",
      removeScratchDir: async () => undefined,
    });
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    const turnAbort = new AbortController();
    const events = channel<AdapterEvent>();
    const turn = adapter.runTurn!(parsed(), incoming(turnAbort.signal), event => events.push(event))
      .finally(() => events.close());
    const tracked = trackStreamLifetime(
      // The bridge's cancel hook is where the server aborts the turn's upstream; the client's own
      // disconnect reaches it as `reader.cancel()` below.
      bridgeToResponsesSSE(events.stream(), "claude-sonnet-5", undefined, undefined, undefined, () => turnAbort.abort()),
      new AbortController(),
      () => undefined,
      lease!,
    );

    const reader = tracked.getReader();
    await reader.read();
    await reader.cancel();
    await turn;

    // The ladder ran because of the cancellation, not because the harness's frames ran out.
    expect(harness.signals).toEqual(["SIGTERM", "SIGKILL"]);
    // Sampled while the harness was still alive, which is after the client's slot went back.
    expect(turnSlotWhileHarnessAlive).toBe(0);
    expect(cleanupLeasesWhileHarnessAlive).toBe(1);
    // And once the process is confirmed gone, the bounded account is empty again.
    expect(harnessTeardownMetrics().active).toBe(0);
    expect(harnessQuarantineSnapshot()).toEqual([]);
  });

  test("the response body, and the admission it releases, waits for the owned harness", async () => {
    // Deliberately not `await adapter.runTurn()`: the finding is about the streaming lifecycle. The
    // bridge closes the response body on the terminal frame and the body's EOF releases the global
    // turn-admission lease, so what has to hold is the ORDER - the harness reaped and its cwd released
    // before the body ends, never after it.
    const order: string[] = [];
    const harness = fakeHarnessChild({ terminatesOn: "SIGTERM", onEnd: () => order.push("harness-gone") });
    const sdk = fakeSdk([initFrame(), textFrame("ok"), resultFrame()], { spawnHarness: true });
    const adapter = createClaudeAgentSdkAdapter(provider(), {
      loadSdk: async () => sdk.module,
      spawnHarnessProcess: () => harness.child as unknown as ChildProcess,
      killHarnessProcessTree: () => false,
      killGraceMs: 20,
      reapTimeoutMs: 200,
      makeScratchDir: async () => "/tmp/ocx-admission-order",
      removeScratchDir: async () => { order.push("cwd-released"); },
    });
    const lease = tryAdmitTurn();
    expect(lease).not.toBeNull();
    const events = channel<AdapterEvent>();
    const turn = adapter.runTurn!(parsed(), incoming(), event => events.push(event)).finally(() => events.close());
    let harnessClosedAtBodyEnd: boolean | undefined;
    const tracked = trackStreamLifetime(
      bridgeToResponsesSSE(events.stream(), "claude-sonnet-5"),
      new AbortController(),
      () => { harnessClosedAtBodyEnd = harness.closed(); order.push("body-end"); },
      lease!,
    );

    const body = await drainStream(tracked);
    await turn;

    expect(body).toContain("response.completed");
    expect(harnessClosedAtBodyEnd).toBe(true);
    expect(order).toEqual(["harness-gone", "cwd-released", "body-end"]);
    // The lease the body carried is back, which is the moment the next turn may be admitted.
    expect(getActiveTurnCount()).toBe(0);
  });
});
