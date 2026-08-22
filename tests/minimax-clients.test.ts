import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { join } from "node:path";
import {
  ClientPathError,
  EXPORT_CLIENTS,
  LOOPBACK_API_KEY_PLACEHOLDER,
  OPENCODE_PROVIDER_ID,
  buildClientConfig,
  buildClientConfigText,
  mcodeConfigPath,
  mcodeHomeDir,
  type ExportContext,
  type McodeGeneratedConfig,
} from "../src/clients/config-export";
import {
  buildMmxEnv,
  finishMmxClientCleanup,
  forwardMmxTerminationSignal,
  installMmxTerminationHandlers,
  mcodeOpenCodexBaseUrl,
  mmxCommandPath,
  mmxUnsafeOverride,
  isStandaloneInformationalInvocation,
  startMmxTextBridge,
  usableMinimaxLiveProxy,
} from "../src/cli/minimax";
import type { OcxConfig } from "../src/types";

const CONFIG = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

function context(): ExportContext {
  return {
    baseUrl: "http://127.0.0.1:10100/v1",
    config: CONFIG,
    models: [
      {
        namespaced: "openai/gpt-5.6-sol",
        provider: "openai",
        id: "gpt-5.6-sol",
        contextWindow: 272_000,
        reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultReasoningEffort: "xhigh",
      },
      { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5" },
    ],
  };
}

describe("MiniMax Code client config", () => {
  test("adds only custom_provider.opencodex, syncs model capabilities, and never changes the selected model", () => {
    const document = buildClientConfig("mcode", context()) as McodeGeneratedConfig;
    expect(Object.keys(document)).toEqual(["custom_provider"]);
    expect(document).not.toHaveProperty("defaultModel");
    const provider = document.custom_provider[OPENCODE_PROVIDER_ID]!;
    expect(provider).toEqual({
      name: "OpenCodex",
      kind: "custom",
      enabled: true,
      api: "anthropic-messages",
      options: {
        apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
        baseURL: "http://127.0.0.1:10100",
        authMode: "api-key",
      },
      models: {
        "anthropic/claude-opus-5": {},
        "openai/gpt-5.6-sol": {
          limit: { context: 272_000 },
          thinking: { effortOptions: ["low", "medium", "high", "xhigh", "max", "ultra"] },
        },
      },
    });
    expect(provider.models["openai/gpt-5.6-sol"]?.thinking).not.toHaveProperty("effort");
    expect(provider.models["openai/gpt-5.6-sol"]?.thinking).not.toHaveProperty("defaultEffort");
    expect(EXPORT_CLIENTS.mcode.summarize(document)).toEqual({ modelCount: 2, modelsWithoutLimits: 1 });
  });

  test("omits invalid context windows and empty effort ladders instead of guessing", () => {
    const document = buildClientConfig("mcode", {
      ...context(),
      models: [
        { namespaced: "mock/zero", provider: "mock", id: "zero", contextWindow: 0, reasoningEfforts: [] },
        { namespaced: "mock/nan", provider: "mock", id: "nan", contextWindow: Number.NaN },
      ],
    }) as McodeGeneratedConfig;

    expect(document.custom_provider[OPENCODE_PROVIDER_ID]!.models).toEqual({
      "mock/nan": {},
      "mock/zero": {},
    });
  });

  test("canonicalizes declared effort options and drops unsupported values and Codex's none sentinel", () => {
    const document = buildClientConfig("mcode", {
      ...context(),
      models: [{
        namespaced: "mock/reasoning",
        provider: "mock",
        id: "reasoning",
        reasoningEfforts: ["max", "none", "unsupported", "minimal", "low", "high", "low"],
      }],
    }) as McodeGeneratedConfig;

    expect(document.custom_provider[OPENCODE_PROVIDER_ID]!.models["mock/reasoning"]).toEqual({
      thinking: { effortOptions: ["minimal", "low", "high", "max"] },
    });
  });

  test("omits thinking when none is the only declared effort", () => {
    const document = buildClientConfig("mcode", {
      ...context(),
      models: [{
        namespaced: "mock/no-reasoning",
        provider: "mock",
        id: "no-reasoning",
        reasoningEfforts: ["none"],
      }],
    }) as McodeGeneratedConfig;

    expect(document.custom_provider[OPENCODE_PROVIDER_ID]!.models["mock/no-reasoning"]).toEqual({});
  });

  test("native YAML round-trips and contains no credential-shaped value", () => {
    const built = buildClientConfigText("mcode", context());
    expect(built.format).toBe("yaml");
    expect(Bun.YAML.parse(built.text)).toEqual(built.document as never);
    expect(built.text).not.toContain("sk-");
  });

  test("resolves the public data-dir overrides in MCode precedence order", () => {
    expect(mcodeHomeDir({}, "/home/u")).toBe(join("/home/u", ".minimax"));
    expect(mcodeConfigPath({ MAVIS_DATA_DIR: "/legacy" }, "/home/u")).toBe(join("/legacy", "config.yaml"));
    expect(mcodeConfigPath({ MINIMAX_DATA_DIR: "/current", MAVIS_DATA_DIR: "/legacy" }, "/home/u"))
      .toBe(join("/current", "config.yaml"));
    expect(() => mcodeConfigPath({ MINIMAX_DATA_DIR: "relative" }, "/home/u")).toThrow(ClientPathError);
  });

  test("launcher reads only the managed provider destination", () => {
    const { text } = buildClientConfigText("mcode", context());
    expect(mcodeOpenCodexBaseUrl(text)).toBe("http://127.0.0.1:10100");
    expect(mcodeOpenCodexBaseUrl("not: [valid")).toBeNull();
  });
});

describe("MiniMax CLI wrapper", () => {
  test("keeps the bridge's upstream hop direct when the parent has a proxy", async () => {
    const reservation = createServer();
    const proxyPort = await new Promise<number>((resolve, reject) => {
      reservation.once("error", reject);
      reservation.listen(0, "127.0.0.1", () => {
        const address = reservation.address();
        if (!address || typeof address === "string") reject(new Error("proxy port reservation failed"));
        else resolve(address.port);
      });
    });
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));

    const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/minimax-bridge-direct.ts")], {
      env: {
        ...process.env,
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        ALL_PROXY: `http://127.0.0.1:${proxyPort}`,
        http_proxy: `http://127.0.0.1:${proxyPort}`,
        https_proxy: `http://127.0.0.1:${proxyPort}`,
        all_proxy: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: "",
        no_proxy: "",
        TEST_PROXY_PORT: String(proxyPort),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode, stderr).toBe(0);
    expect(JSON.parse(stdout.trim())).toEqual({
      responseStatus: 200,
      responseText: JSON.stringify({ source: "upstream" }),
      proxyRequests: 0,
      upstreamBody: JSON.stringify({ prompt: "private bridge payload" }),
    });
  });

  test("passes through only standalone help and officially supported version invocations", () => {
    expect(isStandaloneInformationalInvocation(["--help"], "mmx")).toBeTrue();
    expect(isStandaloneInformationalInvocation(["--version"], "mmx")).toBeTrue();
    expect(isStandaloneInformationalInvocation(["-v"], "mmx")).toBeTrue();
    expect(isStandaloneInformationalInvocation(["-V"], "mmx")).toBeFalse();
    expect(isStandaloneInformationalInvocation(["text", "chat", "--message", "-v"], "mmx")).toBeFalse();
    expect(isStandaloneInformationalInvocation(["text", "chat", "--message", "--version"], "mmx")).toBeFalse();
    expect(isStandaloneInformationalInvocation(["--message", "--version"], "mmx")).toBeFalse();
    expect(isStandaloneInformationalInvocation(["--help", "text", "chat"], "mmx")).toBeFalse();
    expect(isStandaloneInformationalInvocation(["-v"], "mcode")).toBeTrue();
    expect(isStandaloneInformationalInvocation(["-V"], "mcode")).toBeTrue();
    expect(isStandaloneInformationalInvocation(["--version", "extra"], "mcode")).toBeFalse();
  });

  test("finds text commands with official global flags before or after the path", () => {
    expect(mmxCommandPath(["--output", "json", "text", "chat", "--message", "hello"]))
      .toEqual(["text", "chat"]);
    expect(mmxCommandPath(["--help=false", "text", "chat"]))
      .toEqual(["text", "chat"]);
    expect(mmxCommandPath(["--yes", "text", "chat", "--message", "hello"]))
      .toEqual(["text", "chat"]);
    expect(mmxCommandPath(["--stream", "text", "chat", "--message", "hello"]))
      .toEqual(["text", "chat"]);
    expect(mmxCommandPath(["text", "repl", "--verbose"])).toEqual(["text", "repl"]);
    expect(mmxCommandPath(["image", "generate", "--prompt", "cat"])).toEqual(["image", "generate"]);
  });

  test("rejects caller-controlled credentials and destinations in both flag forms", () => {
    expect(mmxUnsafeOverride(["text", "chat", "--api-key", "hidden"])).toBe("--api-key");
    expect(mmxUnsafeOverride(["--base-url=https://example.test", "text", "chat"])).toBe("--base-url");
    expect(mmxUnsafeOverride(["--region", "cn", "text", "chat"])).toBe("--region");
    expect(mmxUnsafeOverride(["text", "chat", "--region=cn"])).toBe("--region");
    expect(mmxUnsafeOverride(["text", "chat", "--model", "mock/model"])).toBeNull();
  });

  test("overrides the MMX config and destination only in the child environment", () => {
    const base: Record<string, string> = {
      MMX_CONFIG_DIR: "/real/user/config",
      MINIMAX_BASE_URL: "https://api.minimax.io",
      MINIMAX_API_KEY: "real-user-secret",
      Minimax_Api_Key: "mixed-case-real-user-secret",
      Mmx_Config_Dir: "/mixed-case/user/config",
      Minimax_Base_Url: "https://mixed-case.example.test",
      Minimax_Region: "cn",
      KEEP_ME: "yes",
      HTTP_PROXY: "http://proxy.example.test:8080",
      http_proxy: "http://proxy.example.test:8080",
      Http_Proxy: "http://mixed-case-proxy.example.test:8080",
      HTTPS_PROXY: "http://proxy.example.test:8080",
      https_proxy: "http://proxy.example.test:8080",
      Https_Proxy: "http://mixed-case-proxy.example.test:8080",
      ALL_PROXY: "socks5://proxy.example.test:1080",
      all_proxy: "socks5://proxy.example.test:1080",
      All_Proxy: "socks5://mixed-case-proxy.example.test:1080",
    };
    const env = buildMmxEnv({ port: 10123, hostname: "0.0.0.0" }, "/isolated/config", base);
    expect(env).toMatchObject({
      MMX_CONFIG_DIR: "/isolated/config",
      MINIMAX_BASE_URL: "http://127.0.0.1:10123",
      MINIMAX_REGION: "global",
      KEEP_ME: "yes",
    });
    expect(base.MMX_CONFIG_DIR).toBe("/real/user/config");
    expect(base.MINIMAX_BASE_URL).toBe("https://api.minimax.io");
    for (const key of [
      "HTTP_PROXY", "http_proxy", "Http_Proxy",
      "HTTPS_PROXY", "https_proxy", "Https_Proxy",
      "ALL_PROXY", "all_proxy", "All_Proxy",
      "MINIMAX_API_KEY", "Minimax_Api_Key",
      "Mmx_Config_Dir", "Minimax_Base_Url", "Minimax_Region",
    ]) {
      expect(env[key]).toBeUndefined();
      expect(base[key]).toBeDefined();
    }
    expect(base.MINIMAX_API_KEY).toBe("real-user-secret");
  });

  test("forwards wrapper termination signals only to a live MMX child", () => {
    const forwarded: Array<NodeJS.Signals | number | undefined> = [];
    const child = {
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      kill(signal?: NodeJS.Signals | number) {
        forwarded.push(signal);
        return true;
      },
    };

    expect(forwardMmxTerminationSignal(child, "SIGINT", { platform: "linux" })).toBeTrue();
    expect(forwardMmxTerminationSignal(child, "SIGTERM", { platform: "linux" })).toBeTrue();
    expect(forwarded).toEqual(["SIGINT", "SIGTERM"]);

    child.signalCode = "SIGTERM";
    expect(forwardMmxTerminationSignal(child, "SIGINT", { platform: "linux" })).toBeFalse();
    expect(forwarded).toEqual(["SIGINT", "SIGTERM"]);

    expect(forwardMmxTerminationSignal({
      exitCode: null,
      signalCode: null,
      kill() { throw new Error("already gone"); },
    }, "SIGTERM", { platform: "linux" })).toBeFalse();

    const killedTrees: number[] = [];
    expect(forwardMmxTerminationSignal({
      pid: 4242,
      exitCode: null,
      signalCode: null,
      kill() { throw new Error("must terminate the Windows process tree"); },
    }, "SIGTERM", {
      platform: "win32",
      killWindowsTree: pid => { killedTrees.push(pid); },
    })).toBeTrue();
    expect(killedTrees).toEqual([4242]);
  });

  test("keeps termination handlers installed while coalescing duplicate launcher signals", () => {
    const host = new EventEmitter();
    const events: string[] = [];
    let now = 1_000;
    const child = {
      exitCode: null,
      signalCode: null,
      kill(signal?: NodeJS.Signals | number) {
        events.push(`kill:${String(signal)}`);
        return true;
      },
    };
    const remove = installMmxTerminationHandlers({
      getChild: () => child,
      cleanup: async () => { events.push("cleanup"); },
      host,
      now: () => now,
      terminationDeps: { platform: "linux" },
    });

    host.emit("SIGINT");
    expect(events).toEqual(["kill:SIGINT", "cleanup"]);
    expect(host.listenerCount("SIGINT")).toBe(1);

    now = 1_100;
    host.emit("SIGINT");
    expect(events).toEqual(["kill:SIGINT", "cleanup"]);

    now = 1_600;
    host.emit("SIGTERM");
    expect(events).toEqual(["kill:SIGINT", "cleanup", "kill:SIGTERM", "cleanup"]);

    remove();
    expect(host.listenerCount("SIGINT")).toBe(0);
    expect(host.listenerCount("SIGTERM")).toBe(0);
  });

  test("removes termination handlers only after asynchronous bridge cleanup settles", async () => {
    const events: string[] = [];
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const finishing = finishMmxClientCleanup(async () => {
      events.push("cleanup:start");
      await cleanupGate;
      events.push("cleanup:end");
    }, () => { events.push("handlers:remove"); });

    await Promise.resolve();
    expect(events).toEqual(["cleanup:start"]);
    releaseCleanup();
    await finishing;
    expect(events).toEqual(["cleanup:start", "cleanup:end", "handlers:remove"]);
  });

  test("rejects a non-loopback hostname from stale runtime proxy metadata", () => {
    const remote = {
      pid: 42,
      port: 10100,
      hostname: "192.0.2.10",
      source: "runtime" as const,
    };
    const local = { ...remote, hostname: "127.0.0.1" };
    expect(usableMinimaxLiveProxy(remote)).toBeNull();
    expect(usableMinimaxLiveProxy(local)).toBe(local);
  });

  test("bridges only MMX text paths to the canonical data plane without forwarding credentials", async () => {
    const seen: Array<{
      path: string;
      search: string;
      body: string;
      authorization: string | null;
      dedicated: string | null;
      xApiKey: string | null;
    }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        seen.push({
          path: url.pathname,
          search: url.search,
          body: await req.text(),
          authorization: req.headers.get("authorization"),
          dedicated: req.headers.get("x-opencodex-api-key"),
          xApiKey: req.headers.get("x-api-key"),
        });
        return Response.json({ ok: true });
      },
    });
    const bridge = startMmxTextBridge({ hostname: "127.0.0.1", port: upstream.port });
    try {
      const messages = await fetch(`${bridge.baseUrl}/anthropic/v1/messages?beta=true`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer must-not-forward",
          "x-opencodex-api-key": "must-not-forward",
          "x-api-key": "must-be-replaced",
        },
        body: JSON.stringify({ model: "mock/model", messages: [] }),
      });
      expect(messages.status).toBe(200);
      const count = await fetch(`${bridge.baseUrl}/anthropic/v1/messages/count_tokens`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock/model", messages: [] }),
      });
      expect(count.status).toBe(200);
      expect((await fetch(`${bridge.baseUrl}/anthropic/v1/messages`, { method: "GET" })).status).toBe(404);
      expect((await fetch(`${bridge.baseUrl}/v1/messages`, { method: "POST" })).status).toBe(404);
      expect(seen).toHaveLength(2);
      expect(seen.map(row => [row.path, row.search])).toEqual([
        ["/v1/messages", "?beta=true"],
        ["/v1/messages/count_tokens", ""],
      ]);
      expect(JSON.parse(seen[0]!.body)).toEqual({ model: "mock/model", messages: [] });
      for (const row of seen) {
        expect(row.authorization).toBeNull();
        expect(row.dedicated).toBeNull();
        expect(row.xApiKey).toBe(LOOPBACK_API_KEY_PLACEHOLDER);
      }
    } finally {
      await bridge.stop();
      await upstream.stop(true);
    }
  });

  test("returns 502 when the selected OpenCodex proxy address is unavailable", async () => {
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.json({ reserved: true }),
    });
    const deadPort = reservation.port;
    await reservation.stop(true);
    const bridge = startMmxTextBridge({ hostname: "127.0.0.1", port: deadPort });
    try {
      const response = await fetch(`${bridge.baseUrl}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock/model", messages: [] }),
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        type: "error",
        error: { type: "api_error", message: "OpenCodex proxy unavailable" },
      });
    } finally {
      await bridge.stop();
    }
  });

  test("bounds the wait for response headers from a stalled OpenCodex proxy", async () => {
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch() {
        await Bun.sleep(1_000);
        return Response.json({ tooLate: true });
      },
    });
    const bridge = startMmxTextBridge(
      { hostname: "127.0.0.1", port: upstream.port },
      { headerTimeoutMs: 25 },
    );
    try {
      const response = await fetch(`${bridge.baseUrl}/anthropic/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock/model", messages: [] }),
      });
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({
        type: "error",
        error: { type: "api_error", message: "OpenCodex proxy unavailable" },
      });
    } finally {
      await bridge.stop();
      await upstream.stop(true);
    }
  });
});
