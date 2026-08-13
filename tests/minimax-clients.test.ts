import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  ClientPathError,
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
      { namespaced: "openai/gpt-5.6-sol", provider: "openai", id: "gpt-5.6-sol" },
      { namespaced: "anthropic/claude-opus-5", provider: "anthropic", id: "claude-opus-5" },
    ],
  };
}

describe("MiniMax Code client config", () => {
  test("adds only custom_provider.opencodex and never changes the selected model", () => {
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
        "openai/gpt-5.6-sol": {},
      },
    });
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
      KEEP_ME: "yes",
      HTTP_PROXY: "http://proxy.example.test:8080",
      http_proxy: "http://proxy.example.test:8080",
      HTTPS_PROXY: "http://proxy.example.test:8080",
      https_proxy: "http://proxy.example.test:8080",
      ALL_PROXY: "socks5://proxy.example.test:1080",
      all_proxy: "socks5://proxy.example.test:1080",
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
    for (const key of ["HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]) {
      expect(env[key]).toBeUndefined();
      expect(base[key]).toContain("proxy.example.test");
    }
    expect(env.MINIMAX_API_KEY).toBeUndefined();
    expect(base.MINIMAX_API_KEY).toBe("real-user-secret");
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
