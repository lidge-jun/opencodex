import { afterEach, describe, expect, test } from "bun:test";
import { createCommandCodeAdapter } from "../src/adapters/command-code";
import { loginCommandCode, parseCommandCodeCallback, shouldImportLocalCommandCodeAuth } from "../src/oauth/command-code";
import { buildModelsRequest, OAUTH_PROVIDERS } from "../src/oauth";
import {
  commandCodeReasoningEfforts,
  refreshCommandCodeReasoningEfforts,
  resetCommandCodeReasoningEffortsForTest,
} from "../src/providers/command-code-efforts";
import { PROVIDER_REGISTRY } from "../src/providers/registry";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";
import { createTestTranslatorBudget } from "./helpers/translator-budget";

const provider: OcxProviderConfig = {
  adapter: "command-code",
  baseUrl: "https://api.commandcode.ai",
  authMode: "oauth",
  apiKey: "secret-command-key",
  defaultMaxOutputTokens: 64_000,
};

function parsed(modelId = "deepseek/deepseek-v4-flash"): OcxParsedRequest {
  return {
    modelId,
    stream: true,
    context: {
      systemPrompt: ["system"],
      messages: [{ role: "user", content: "hello", timestamp: 1 }],
      tools: [{ name: "lookup", description: "lookup", parameters: { type: "object" } }],
    },
    options: { reasoning: "high", maxOutputTokens: 100 },
  };
}

async function builtRequest(...args: Parameters<ReturnType<typeof createCommandCodeAdapter>["buildRequest"]>) {
  return createCommandCodeAdapter(provider).buildRequest(...args);
}

afterEach(() => resetCommandCodeReasoningEffortsForTest());

describe("Command Code provider", () => {
  test("registry and OAuth surfaces stay in parity", () => {
    const registry = PROVIDER_REGISTRY.find(row => row.id === "command-code");
    expect(registry).toMatchObject({
      adapter: "command-code",
      authKind: "oauth",
      defaultModel: "deepseek/deepseek-v4-flash",
      liveModels: true,
      modelDiscovery: {
        url: "https://api.commandcode.ai/provider/v1/models",
        maxResponseBytes: 262_144,
        maxModels: 256,
      },
    });
    expect(registry?.models).toBeUndefined();
    expect(registry?.modelReasoningEfforts).toMatchObject({
      "deepseek/deepseek-v4-flash": ["high", "max"],
      "zai-org/GLM-5.2": ["high", "max"],
    });
    expect(OAUTH_PROVIDERS["command-code"]?.providerConfig).toMatchObject({
      adapter: "command-code",
      baseUrl: "https://api.commandcode.ai",
      authMode: "oauth",
    });
  });

  test("API-key preset shares the official reasoning-facts table with the OAuth entry", () => {
    const oauth = PROVIDER_REGISTRY.find(row => row.id === "command-code");
    const apiKey = PROVIDER_REGISTRY.find(row => row.id === "commandcode");
    expect(apiKey).toMatchObject({
      adapter: "openai-chat",
      authKind: "key",
      baseUrl: "https://api.commandcode.ai/provider/v1",
      liveModels: true,
    });
    // Without this the API-key preset never advertises a reasoning picker, and the
    // router's known-ids decode source misses the native slash ids — the Codex-facing
    // slug `commandcode/deepseek-deepseek-v4-pro` is then sent upstream verbatim and
    // rejected with `unsupported_model`.
    expect(apiKey?.modelReasoningEfforts).toEqual(oauth?.modelReasoningEfforts);
    expect(apiKey?.modelReasoningEfforts).toMatchObject({
      "deepseek/deepseek-v4-pro": ["high", "max"],
      "zai-org/GLM-5": ["high", "max"],
      "zai-org/GLM-5.1": ["high", "max"],
      "zai-org/GLM-5.2-Fast": ["high", "max"],
      "zai-org/GLM-5.3": ["low", "high", "max"],
    });
  });

  /*
   * #2883. `z-ai/glm-5.3-flash` is a live-discovered route whose id shares
   * neither the vendor prefix nor the model of `zai-org/GLM-5.3`, so no
   * `modelRecordValue` relaxation reaches it — only an explicit row does. Both
   * presets must carry it, because the picker is empty on whichever one the
   * user configured, and the two entries are separately constructed.
   */
  test("the live GLM-5.3-Flash route carries its own effort ladder on both presets", () => {
    const oauth = PROVIDER_REGISTRY.find(row => row.id === "command-code");
    const apiKey = PROVIDER_REGISTRY.find(row => row.id === "commandcode");
    for (const [label, entry] of [["oauth", oauth], ["api-key", apiKey]] as const) {
      expect(entry?.modelReasoningEfforts?.["z-ai/glm-5.3-flash"], `${label} preset ladder`)
        .toEqual(["low", "high", "max"]);
    }
    // Distinct rows for distinct upstream models: GLM-5.3 and GLM-5.3-Flash happen to
    // share a ladder today, but neither may be derived from the other.
    expect(commandCodeReasoningEfforts("z-ai/glm-5.3-flash")).toEqual(["low", "high", "max"]);
    expect(commandCodeReasoningEfforts("zai-org/GLM-5.3")).toEqual(["low", "high", "max"]);
    // The reported id arrives lowercase from live discovery; a caller may still fold case.
    expect(commandCodeReasoningEfforts("Z-AI/GLM-5.3-Flash")).toEqual(["low", "high", "max"]);
    // Nothing widened into a substring match: a sibling that upstream does not list
    // must stay unknown rather than inheriting the Flash ladder.
    expect(commandCodeReasoningEfforts("z-ai/glm-5.3-flash-vision")).toBeUndefined();
  });

  test("OAuth and API-key presets share only verified image capabilities", () => {
    const oauth = PROVIDER_REGISTRY.find(row => row.id === "command-code");
    const apiKey = PROVIDER_REGISTRY.find(row => row.id === "commandcode");
    const verifiedImageModels = [
      "deepseek/deepseek-v4-flash-vision-exp",
      "gpt-5.6-luna",
      "gpt-5.6-sol",
      "MiniMaxAI/MiniMax-M3",
      "moonshotai/Kimi-K3",
      "meta/muse-spark-1.3",
      "meta/muse-spark-1.3-contributor",
      "meta/muse-spark-1.2",
      "meta/muse-spark-1.2-contributor",
    ];
    const verifiedTextOnlyModels = [
      "deepseek/deepseek-v4-flash",
      "deepseek/deepseek-v4-pro",
      "zai-org/GLM-5.2",
      "zai-org/GLM-5.3",
      "xai/grok-4.6",
    ];

    expect(apiKey?.modelInputModalities).toEqual(oauth?.modelInputModalities);
    for (const preset of [oauth, apiKey]) {
      for (const id of verifiedImageModels) {
        expect(preset?.modelInputModalities?.[id]).toEqual(["text", "image"]);
      }
      for (const id of verifiedTextOnlyModels) {
        expect(preset?.modelInputModalities?.[id]).toBeUndefined();
      }
    }
  });

  test("validates callback shape and state without exposing the key", () => {
    const secret = "super-secret-callback-key";
    const parsedCallback = parseCommandCodeCallback({ apiKey: secret, state: "state", userId: "u", userName: "name", keyName: "cli" }, "state");
    expect(parsedCallback).toMatchObject({ userId: "u" });
    let thrown = "";
    try {
      parseCommandCodeCallback({ apiKey: secret, state: "wrong", userId: "u", userName: "name", keyName: "cli" }, "state");
    } catch (error) { thrown = String(error); }
    expect(thrown).toContain("state mismatch");
    expect(thrown).not.toContain(secret);
  });

  test("rejects an already-aborted login before it creates a callback server", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before login"));
    await expect(loginCommandCode({ signal: controller.signal }, { importLocal: "off" })).rejects.toThrow("cancelled before login");
  });

  test("accepts a manually pasted API key when the browser callback cannot reach the loopback server", async () => {
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const href = String(input);
      calls.push(href);
      if (href.includes("whoami")) return new Response(JSON.stringify({ ok: true, user: { id: "u-1", userName: "tester" } }), { status: 200 });
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof globalThis.fetch;
    try {
      const credentials = await loginCommandCode({
        onAuth: () => {},
        onProgress: () => {},
        onManualCodeInput: async () => "sk-pasted-key",
        signal: controller.signal,
      }, { importLocal: "off" });
      expect(credentials).toMatchObject({ access: "sk-pasted-key", source: "oauth", accountId: "u-1" });
      expect(calls.some(href => href.includes("whoami"))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejects a pasted API key whose whoami identity is incomplete", async () => {
    const controller = new AbortController();
    const originalFetch = globalThis.fetch;
    let whoamiCalls = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const href = String(input);
      if (href.includes("whoami")) {
        whoamiCalls += 1;
        return new Response(JSON.stringify({ ok: true, user: { id: "", userName: "" } }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${href}`);
    }) as typeof globalThis.fetch;
    try {
      // With an incomplete identity, the manual loop keeps re-prompting; abort to stop it.
      const login = loginCommandCode({
        onAuth: () => {},
        onProgress: () => {},
        onManualCodeInput: async () => "sk-incomplete-key",
        signal: controller.signal,
      }, { importLocal: "off" });
      controller.abort(new Error("cancelled"));
      await expect(login).rejects.toThrow("cancelled");
      expect(whoamiCalls).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("uses live account discovery and only imports local CLI auth for the first account", () => {
    const request = buildModelsRequest(provider, "secret-command-key", "command-code");
    expect(request).toEqual({
      url: "https://api.commandcode.ai/provider/v1/models",
      headers: { Authorization: "Bearer secret-command-key" },
    });
    expect(shouldImportLocalCommandCodeAuth()).toBe(true);
    expect(shouldImportLocalCommandCodeAuth({ importLocal: "off" })).toBe(false);
  });

  test("builds the proprietary generate request with an officially supported effort and bearer auth", async () => {
    const built = await builtRequest(parsed());
    const body = JSON.parse(built.body);
    expect(built.url).toBe("https://api.commandcode.ai/alpha/generate");
    expect(built.headers.Authorization).toBe("Bearer secret-command-key");
    expect(body.params).toMatchObject({ model: "deepseek/deepseek-v4-flash", reasoning_effort: "high", max_tokens: 100, stream: true });
    expect(body.params.tools[0]).toMatchObject({ name: "lookup" });
    expect(built.body).not.toContain("secret-command-key");
  });

  test("passes every canonical Command Code id through unchanged", async () => {
    const built = await builtRequest(parsed("xai/grok-4.5"));
    expect(JSON.parse(built.body).params.model).toBe("xai/grok-4.5");
  });

  test("carries tool-result images in a follow-up user message instead of dropping them", async () => {
    const image = "data:image/png;base64,AAAA";
    const built = await builtRequest({
      ...parsed(),
      context: {
        ...parsed().context,
        messages: [{
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "view_image", arguments: {} }],
          timestamp: 1,
        }, {
          role: "toolResult",
          toolCallId: "call_1",
          toolName: "view_image",
          content: [{ type: "text", text: "screenshot:" }, { type: "image", imageUrl: image }],
          isError: false,
          timestamp: 2,
        }],
      },
    });
    const body = JSON.parse(built.body);
    expect(body.params.messages).toEqual([
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1", toolName: "view_image", input: {} }] },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", toolName: "view_image", output: { type: "text", value: "screenshot:[image]" } }] },
      { role: "user", content: [{ type: "image", image, mediaType: "image/png" }] },
    ]);
  });

  test("synthesizes an error result for every assistant tool call that never received a result", async () => {
    const built = await builtRequest({
      ...parsed(),
      context: {
        ...parsed().context,
        messages: [
          { role: "user", content: "run tools", timestamp: 1 },
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call_1", name: "lookup", arguments: { q: "a" } },
              { type: "toolCall", id: "call_2", name: "lookup", arguments: { q: "b" } },
            ],
            timestamp: 2,
          },
          { role: "toolResult", toolCallId: "call_1", toolName: "lookup", content: "one", isError: false, timestamp: 3 },
          { role: "user", content: "continue", timestamp: 4 },
        ],
      },
    });
    const body = JSON.parse(built.body);
    const wire = body.params.messages;
    expect(wire[0]).toEqual({ role: "user", content: [{ type: "text", text: "run tools" }] });
    expect(wire[1]).toMatchObject({ role: "assistant", content: [{ type: "tool-call", toolCallId: "call_1" }, { type: "tool-call", toolCallId: "call_2" }] });
    expect(wire[2]).toMatchObject({ role: "tool", content: [{ type: "tool-result", toolCallId: "call_1", output: { type: "text", value: "one" } }] });
    // call_2 never received a result: the adapter must close it with an explicit error result
    // BEFORE the next user message, or the upstream rejects the unpaired call (#1383).
    expect(wire[3]).toMatchObject({
      role: "tool",
      content: [{ type: "tool-result", toolCallId: "call_2", toolName: "lookup", output: { type: "error-text" } }],
    });
    expect(wire[4]).toEqual({ role: "user", content: [{ type: "text", text: "continue" }] });
  });

  test("keeps tool results contiguous before buffered image carriers", async () => {
    const image = "data:image/png;base64,AAAA";
    const built = await builtRequest({
      ...parsed(),
      context: {
        ...parsed().context,
        messages: [
          {
            role: "assistant",
            content: [
              { type: "toolCall", id: "call_1", name: "view_image", arguments: {} },
              { type: "toolCall", id: "call_2", name: "lookup", arguments: { q: "b" } },
            ],
            timestamp: 1,
          },
          { role: "toolResult", toolCallId: "call_1", toolName: "view_image", content: [{ type: "text", text: "shot" }, { type: "image", imageUrl: image }], isError: false, timestamp: 2 },
          { role: "toolResult", toolCallId: "call_2", toolName: "lookup", content: "two", isError: false, timestamp: 3 },
        ],
      },
    });
    const body = JSON.parse(built.body);
    const wire = body.params.messages;
    // Both tool results must precede the user image carrier so the assistant turn's tool
    // results stay contiguous on the wire (#1383 / CodeRabbit adjacency finding).
    expect(wire[1]).toMatchObject({ role: "tool", content: [{ type: "tool-result", toolCallId: "call_1" }] });
    expect(wire[2]).toMatchObject({ role: "tool", content: [{ type: "tool-result", toolCallId: "call_2" }] });
    expect(wire[3]).toEqual({ role: "user", content: [{ type: "image", image, mediaType: "image/png" }] });
  });

  test("degrades an orphan tool result without a declared call to a text carrier", async () => {
    const built = await builtRequest({
      ...parsed(),
      context: {
        ...parsed().context,
        messages: [
          { role: "user", content: "go", timestamp: 1 },
          { role: "toolResult", toolCallId: "call_orphan", toolName: "lookup", content: "outcome", isError: false, timestamp: 2 },
        ],
      },
    });
    const body = JSON.parse(built.body);
    const wire = body.params.messages;
    // The upstream rejects a standalone `tool` message whose call was never declared by an
    // assistant turn; the outcome must ride a user text carrier instead (#1383).
    expect(wire[1]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: expect.stringContaining("[tool result without adjacent tool call: lookup (call_orphan)]") }],
    });
  });

  test("keeps the generate config to bounded workspace and git metadata", async () => {
    const built = await builtRequest(parsed());
    const body = JSON.parse(built.body);
    expect(body.config).toHaveProperty("isGitRepo");
    expect(body.config).toHaveProperty("currentBranch");
    expect(body.config).toHaveProperty("mainBranch");
    expect(body.config).toHaveProperty("gitStatus");
    expect(body.config).toHaveProperty("recentCommits");
    expect(Array.isArray(body.config.recentCommits)).toBe(true);
    expect(body.config.recentCommits.length).toBeLessThanOrEqual(8);
    expect(body.config.recentCommits.every((entry: string) => entry.length <= 512)).toBe(true);
    expect(body.config.gitStatus.length).toBeLessThanOrEqual(2048);
    expect(body.config.structure).toBeInstanceOf(Array);
    expect(typeof body.config.workingDir).toBe("string");
    expect(built.headers["x-project-slug"]?.length ?? 0).toBeLessThanOrEqual(64);
    // This test runs inside a git worktree, so the real (non-fallback) metadata path
    // must populate the repo/branch instead of returning the empty fallback.
    expect(body.config.isGitRepo).toBe(true);
    expect(body.config.currentBranch).not.toBe("");
  });

  test("does not advertise an unverified effort for models absent from the official table", async () => {
    const built = await builtRequest(parsed("moonshotai/Kimi-K3"));
    expect(JSON.parse(built.body).params).not.toHaveProperty("reasoning_effort");
  });

  test("advertises reasoning efforts for muse spark and rejects ultra at the wire", async () => {
    // Muse Spark: CLI prints "has no adjustable reasoning effort", but upstream
    // /alpha/generate accepts low..max (verified 2026-08-13: contributor
    // variant all 200, ultra 400). The proxy previously stripped the field;
    // this covers the actual forwarding behavior.
    expect(commandCodeReasoningEfforts("meta/muse-spark-1.2-contributor")).toEqual(
      ["low", "medium", "high", "xhigh", "max"],
    );
    // 1.3 shipped as the same-shaped successor and carries the identical ladder.
    expect(commandCodeReasoningEfforts("meta/muse-spark-1.3-contributor")).toEqual(
      ["low", "medium", "high", "xhigh", "max"],
    );
    expect(commandCodeReasoningEfforts("meta/muse-spark-1.3")).toEqual(
      ["low", "medium", "high", "xhigh", "max"],
    );
    expect(commandCodeReasoningEfforts("meta/muse-spark-1.2")).toEqual(
      ["low", "medium", "high", "xhigh", "max"],
    );
    expect(commandCodeReasoningEfforts("meta/muse-spark-1.1")).toEqual(
      ["low", "medium", "high", "xhigh", "max"],
    );
    // Case-insensitive lookup (keyFor lowercases).
    expect(commandCodeReasoningEfforts("Meta/Muse-Spark-1.2-Contributor")).toEqual(
      ["low", "medium", "high", "xhigh", "max"],
    );
    for (const effort of ["low", "medium", "high", "max"] as const) {
      const withEffort = await builtRequest({
        ...parsed("meta/muse-spark-1.2-contributor"),
        options: { reasoning: effort, maxOutputTokens: 100 },
      });
      expect(JSON.parse(withEffort.body).params.reasoning_effort).toBe(effort);
    }
    // xhigh is a distinct wire value for muse spark (upstream accepts it) and
    // must not be collapsed to max — only deepseek/glm need that aliasing.
    const xhigh = await builtRequest({
      ...parsed("meta/muse-spark-1.2-contributor"),
      options: { reasoning: "xhigh", maxOutputTokens: 100 },
    });
    expect(JSON.parse(xhigh.body).params.reasoning_effort).toBe("xhigh");
    // ultra is not advertised for muse spark and upstream rejects it (400).
    // The adapter must strip it before request construction.
    const ultra = await builtRequest({
      ...parsed("meta/muse-spark-1.2-contributor"),
      options: { reasoning: "ultra", maxOutputTokens: 100 },
    });
    expect(JSON.parse(ultra.body).params).not.toHaveProperty("reasoning_effort");
    // Deepseek/glm still alias xhigh/ultra→max per their official profiles.
    const deepseekUltra = await builtRequest({
      ...parsed("deepseek/deepseek-v4-flash"),
      options: { reasoning: "ultra", maxOutputTokens: 100 },
    });
    expect(JSON.parse(deepseekUltra.body).params.reasoning_effort).toBe("max");
    const deepseekXhigh = await builtRequest({
      ...parsed("deepseek/deepseek-v4-flash"),
      options: { reasoning: "xhigh", maxOutputTokens: 100 },
    });
    expect(JSON.parse(deepseekXhigh.body).params.reasoning_effort).toBe("max");
  });

  test("maps ultra and xhigh to the max wire effort and honors legacy alias ids", async () => {
    const ultra = await builtRequest({ ...parsed(), options: { reasoning: "ultra", maxOutputTokens: 100 } });
    expect(JSON.parse(ultra.body).params.reasoning_effort).toBe("max");
    const xhigh = await builtRequest({ ...parsed(), options: { reasoning: "xhigh", maxOutputTokens: 100 } });
    expect(JSON.parse(xhigh.body).params.reasoning_effort).toBe("max");
    // Legacy compatibility id resolves to the canonical effort table before the lookup.
    const legacy = await builtRequest({ ...parsed(), modelId: "deepseek-v4-flash" });
    expect(JSON.parse(legacy.body).params.reasoning_effort).toBe("high");
  });

  test("treats prototype property names as literal model ids", async () => {
    for (const modelId of ["__proto__", "constructor", "toString"]) {
      const built = await builtRequest(parsed(modelId));
      const params = JSON.parse(built.body).params;
      expect(params.model).toBe(modelId);
      expect(params).not.toHaveProperty("reasoning_effort");
    }
  });

  test("filters tool declarations when tool_choice disables tools", async () => {
    const built = await builtRequest({ ...parsed(), options: { toolChoice: "none" } });
    expect(JSON.parse(built.body).params.tools).toEqual([]);
  });

  test("matches a forced namespaced tool choice by dot or unique bare alias", async () => {
    const namespacedParsed = {
      ...parsed(),
      context: {
        ...parsed().context,
        tools: [{ name: "exec_command", namespace: "functions", description: "exec", parameters: { type: "object" } }],
      },
      options: { toolChoice: { name: "functions.exec_command" } },
    };
    const built = await builtRequest(namespacedParsed);
    const tools = JSON.parse(built.body).params.tools;
    expect(tools).toEqual([{ name: "functions__exec_command", description: "exec", input_schema: { type: "object" } }]);

    const bareBuilt = await builtRequest({
      ...namespacedParsed,
      options: { toolChoice: { name: "exec_command" } },
    });
    expect(JSON.parse(bareBuilt.body).params.tools).toEqual(tools);
  });

  test("refreshes a stale official effort record only after a reasoning rejection and retries without it", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      requests.push({ url: href, body: typeof init?.body === "string" ? init.body : undefined });
      if (href.includes("commandcode.ai/models/")) {
        return new Response("Reasoning efforts high are supported; no other reasoning settings.");
      }
      return requests.filter(request => request.url.endsWith("/alpha/generate")).length === 1
        ? new Response(JSON.stringify({ error: "unsupported reasoning_effort" }), { status: 400 })
        : new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const adapter = createCommandCodeAdapter({ ...provider, fetch } as OcxProviderConfig);
    const request = await adapter.buildRequest({ ...parsed(), options: { reasoning: "max" } });
    const response = await adapter.fetchResponse!(request);
    expect(response.ok).toBe(true);
    expect(commandCodeReasoningEfforts("deepseek/deepseek-v4-flash")).toEqual(["high"]);
    const generated = requests.filter(request => request.url.endsWith("/alpha/generate"));
    expect(JSON.parse(generated[1]!.body!).params).not.toHaveProperty("reasoning_effort");
  });

  // Pins the profileUrl of each id added for #2647 — nothing more.
  //
  // Be clear about what this does NOT prove: the stubbed response below returns
  // prose that commandcode.ai never actually emits, so a green run here is not
  // evidence that a real profile page can be parsed. It cannot: the live pages
  // carry no "Reasoning efforts ... are supported;" text at all (measured 0 for
  // every row in the table on 2026-08-27), so the refresh path returns undefined
  // in production. See the provenance note in command-code-efforts.ts.
  //
  // What it does catch is a typo'd or drifted profileUrl, which is worth pinning
  // on its own: the URL is the only handle a future parser fix would have.
  test("resolves the #2647 effort profiles to their canonical public URLs", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response("Reasoning efforts high are supported; no other reasoning settings.");
    }) as typeof globalThis.fetch;

    await refreshCommandCodeReasoningEfforts("gpt-5.6-luna", fetch);
    await refreshCommandCodeReasoningEfforts("google/gemini-3.7-flash", fetch);
    await refreshCommandCodeReasoningEfforts("deepseek/deepseek-v4-flash-vision-exp", fetch);

    expect(urls).toEqual([
      "https://commandcode.ai/models/gpt-5-6-luna",
      "https://commandcode.ai/models/gemini-3-7-flash",
      "https://commandcode.ai/models/deepseek-v4-flash-vision-exp",
    ]);
  });

  // Pins the CURRENT, BROKEN state of the profile-refresh path so nobody re-derives
  // the false justification that a wrong ladder self-corrects.
  //
  // commandcode.ai serves these profiles as a React flight payload. The ladder key
  // is present but its array is empty in the delivered bytes
  // (`reasoningEfforts\",[]` — measured on 2026-08-27 for gpt-5.6-luna, glm-5-3 and
  // deepseek-v4-pro alike), and there is no "Reasoning efforts ... are supported;"
  // prose anywhere on the page. So parsedProfileEfforts finds nothing and the row
  // is never replaced.
  //
  // When someone teaches the parser to read a real payload, this test SHOULD fail.
  // That failure is the signal to delete it and update the provenance note in
  // command-code-efforts.ts, which currently tells the reader this net does not work.
  test("a real profile page shape yields no efforts, so the row is not self-correcting", async () => {
    const flightPayload = 'self.__next_f.push([1,"...\\"reasoningEfforts\\",[],\\"inputCost\\",0,\\"minPlanName\\",\\"Go\\"..."])';
    const fetch = (async () => new Response(flightPayload)) as typeof globalThis.fetch;

    const refreshed = await refreshCommandCodeReasoningEfforts("gpt-5.6-luna", fetch);

    expect(refreshed).toBeUndefined();
    // And the table value survives untouched, which is the safe half of the failure.
    expect(commandCodeReasoningEfforts("gpt-5.6-luna")).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("omits effort when the caller did not choose one", async () => {
    const built = await builtRequest({ ...parsed("claude-haiku-4-5"), options: { maxOutputTokens: 100 } });
    expect(JSON.parse(built.body).params).not.toHaveProperty("reasoning_effort");
  });

  test("parses NDJSON text, reasoning, tools, usage, and finish", async () => {
    const response = new Response([
      JSON.stringify({ type: "reasoning-delta", text: "think" }),
      JSON.stringify({ type: "text-delta", text: "hello" }),
      JSON.stringify({ type: "tool-call", toolCallId: "call_1", toolName: "lookup", input: { q: "x" } }),
      JSON.stringify({ type: "finish", rawFinishReason: "tool_use", totalUsage: { inputTokens: 10, outputTokens: 4, inputTokenDetails: { cacheReadTokens: 6, cacheWriteTokens: 2 } } }),
    ].join("\n"));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "thinking_delta", thinking: "think" },
      { type: "text_delta", text: "hello" },
      { type: "tool_call_start", id: "call_1", name: "lookup" },
      { type: "tool_call_delta", arguments: '{"q":"x"}' },
      { type: "tool_call_end" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 6, cacheReadInputTokens: 6, cacheCreationInputTokens: 2 }, stopReason: "tool_use" },
    ]);
  });

  test("yields an error event for upstream error events", async () => {
    const response = new Response(JSON.stringify({ type: "error", error: { message: "upstream boom" } }));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "error", message: "upstream boom", status: 502 },
      { type: "done", usage: undefined, stopReason: undefined },
    ]);
  });

  test("classifies a missing-tool-result upstream error distinctly", async () => {
    const response = new Response(JSON.stringify({
      type: "error",
      error: { message: "Provider stream error: Tool result is missing for tool call call_01_x." },
    }));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "error", message: "Provider stream error: Tool result is missing for tool call call_01_x.", status: 502, errorType: "upstream_error", code: "missing_tool_result" },
      { type: "done", usage: undefined, stopReason: undefined },
    ]);
  });

  test("classifies the underscored missing-tool-result variant distinctly", async () => {
    const response = new Response(JSON.stringify({
      type: "error",
      error: { message: "Provider stream error: tool_result is missing for call_02_y." },
    }));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "error", message: "Provider stream error: tool_result is missing for call_02_y.", status: 502, errorType: "upstream_error", code: "missing_tool_result" },
      { type: "done", usage: undefined, stopReason: undefined },
    ]);
  });

  test("emits a fallback done when the stream ends without a finish event", async () => {
    const response = new Response(JSON.stringify({ type: "text-delta", text: "partial" }));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "partial" },
      { type: "done", usage: undefined, stopReason: undefined },
    ]);
  });

  test("strips SSE data: framing if the gateway ever switches stream shapes", async () => {
    const response = new Response([
      "data: " + JSON.stringify({ type: "text-delta", text: "a" }),
      "data: " + JSON.stringify({ type: "text-delta", text: "b" }),
      "data: [DONE]",
    ].join("\n"));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
      { type: "done", usage: undefined, stopReason: undefined },
    ]);
  });

  test("treats finish-step as a terminal event and emits only one done", async () => {
    const response = new Response([
      JSON.stringify({ type: "text-delta", text: "hi" }),
      JSON.stringify({ type: "finish-step", finishReason: "stop", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }),
      JSON.stringify({ type: "finish", rawFinishReason: "stop", totalUsage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 } }),
    ].join("\n"));
    const events = [];
    for await (const event of createCommandCodeAdapter(provider).parseStream(response, createTestTranslatorBudget())) events.push(event);
    expect(events).toEqual([
      { type: "text_delta", text: "hi" },
      { type: "done", usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 }, stopReason: "stop" },
    ]);
  });

  test("always requests streaming upstream so non-stream clients still get NDJSON", async () => {
    const built = await builtRequest({ ...parsed(), stream: false });
    expect(JSON.parse(built.body).params.stream).toBe(true);
  });
});
