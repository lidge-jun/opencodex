import { beforeEach, describe, expect, test } from "bun:test";
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
import { effectiveAdapterContract, getAdapterDefinition } from "../../src/adapters/registry";
import { PROVIDER_REGISTRY } from "../../src/providers/registry";
import { deriveProviderPresets, providerConfigSeed } from "../../src/providers/derive";
import type { AdapterEvent, OcxParsedRequest, OcxProviderConfig, OcxTool } from "../../src/types";
import { createTestTranslatorBudget } from "../helpers/translator-budget";

// The binary-discovery cache is module-level (a production perf seam); reset it so a test that
// reports a missing CLI cannot mask a later test's injected binary.
beforeEach(() => clearClaudeCliBinaryCache());

interface FakeSdk {
  module: ClaudeAgentSdkModule;
  /** The options object the runner handed the SDK, per turn. */
  options: Record<string, unknown>[];
  /** The prompt frames the runner wrote, per turn (drained from the async iterable). */
  prompts: unknown[][];
  state: { started: number; returned: number };
}

/**
 * Fake Agent SDK: replays the given frames as the harness stream, drains the prompt the runner
 * passes, and counts how often a turn was started or ended by `return()`.
 *
 * `park: true` models the capture-only leg: the harness stopped producing frames and is waiting on
 * a tool call nothing will answer, which is exactly the state the runner has to end from its side.
 */
function fakeSdk(frames: readonly unknown[], behavior: { park?: boolean } = {}): FakeSdk {
  const options: Record<string, unknown>[] = [];
  const prompts: unknown[][] = [];
  const state = { started: 0, returned: 0 };
  let release: (() => void) | undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const module: ClaudeAgentSdkModule = {
    query: params => {
      state.started += 1;
      options.push(params.options);
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

function incoming(abortSignal?: AbortSignal) {
  return {
    headers: new Headers(),
    translatorBudget: createTestTranslatorBudget(),
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
): Promise<AdapterEvent[]> {
  const events: AdapterEvent[] = [];
  await adapter.runTurn!(request, incoming(signal), event => events.push(event));
  return events;
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
