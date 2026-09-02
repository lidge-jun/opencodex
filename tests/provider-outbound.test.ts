import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderOutboundDependencies } from "../src/lib/provider-outbound";
import { PROXY_ENV_KEYS } from "../src/lib/proxy-env";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);
const originalProxyEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));

afterEach(() => {
  for (const key of proxyKeys) {
    const previous = originalProxyEnv[key];
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

function directDependencies(
  response: Response,
  options?: { privateNetwork?: boolean; address?: string },
): {
  dependencies: ProviderOutboundDependencies;
  captured: { address?: string; rejectUnauthorized?: boolean; authorization?: string; body?: string };
} {
  const captured: { address?: string; rejectUnauthorized?: boolean; authorization?: string; body?: string } = {};
  const address = options?.address ?? "93.184.216.34";
  return {
    captured,
    dependencies: {
      resolveAddresses: mock(async () => ({
        hostname: "provider.example",
        addresses: [{ address, family: 4 }],
        privateNetwork: options?.privateNetwork === true,
      })),
      pinnedGet: mock(async (_url, pinned, _signal, requestOptions) => {
        captured.address = pinned.address;
        captured.rejectUnauthorized = requestOptions?.rejectUnauthorized;
        captured.authorization = new Headers(requestOptions?.headers).get("authorization") ?? undefined;
        return response;
      }),
      pinnedPost: mock(async (_url, pinned, body, _signal, requestOptions) => {
        captured.address = pinned.address;
        captured.rejectUnauthorized = requestOptions?.rejectUnauthorized;
        captured.authorization = new Headers(requestOptions?.headers).get("authorization") ?? undefined;
        captured.body = body;
        return response;
      }),
    },
  };
}

describe("provider outbound GET transport", () => {
  test("direct HTTPS connects only to the validated address with TLS verification", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const { providerOutboundGet } = await import("../src/lib/provider-outbound");
    const { dependencies, captured } = directDependencies(new Response('{"data":[]}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const response = await providerOutboundGet(
      "custom",
      { baseUrl: "https://provider.example/v1" },
      "https://provider.example/v1/models",
      { headers: { authorization: "Bearer test-key" } },
      dependencies,
    );

    expect(await response.json()).toEqual({ data: [] });
    expect(captured).toEqual({
      address: "93.184.216.34",
      rejectUnauthorized: true,
      authorization: "Bearer test-key",
    });
  });

  test("private providers behind a configured proxy require an explicit NO_PROXY match", async () => {
    const proxyUrl = "http://127.0.0.1:9";
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.https_proxy = proxyUrl;
    process.env.NO_PROXY = "localhost,127.0.0.1,::1,[::1]";
    process.env.no_proxy = "localhost,127.0.0.1,::1,[::1]";
    const { providerOutboundGet } = await import("../src/lib/provider-outbound");
    const { dependencies, captured } = directDependencies(new Response(null, { status: 200 }), {
      privateNetwork: true,
      address: "192.168.1.50",
    });

    await expect(providerOutboundGet(
      "ollama-lan",
      { baseUrl: "https://ollama.lan:11434/v1", allowPrivateNetwork: true },
      "https://ollama.lan:11434/v1/models",
      {},
      dependencies,
    )).rejects.toThrow(/add ollama\.lan to NO_PROXY/);
    expect(captured.address).toBeUndefined();
  });

  test("Clash fake-IP behind a configured proxy uses hostname CONNECT instead of NO_PROXY (#1748)", async () => {
    const proxyUrl = "http://127.0.0.1:9";
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.https_proxy = proxyUrl;
    process.env.NO_PROXY = "localhost,127.0.0.1,::1,[::1]";
    process.env.no_proxy = "localhost,127.0.0.1,::1,[::1]";
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://www.packyapi.com/v1/models");
      expect(init?.redirect).toBe("manual");
      return new Response('{"data":[{"id":"gpt-5.5"}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    globalThis.fetch = fetchMock;
    try {
      const { providerOutboundGet } = await import("../src/lib/provider-outbound");
      const resolveOptions: { allowBenchmarkAddresses?: boolean }[] = [];
      const { dependencies, captured } = directDependencies(new Response(null, { status: 500 }));
      const innerResolve = dependencies.resolveAddresses!;
      dependencies.resolveAddresses = mock(async (url: string, options?: { allowBenchmarkAddresses?: boolean }) => {
        resolveOptions.push({ allowBenchmarkAddresses: options?.allowBenchmarkAddresses });
        await innerResolve(url, options);
        // What the real resolver returns for a fake-IP-only answer under the
        // outbound benchmark opt-in: accepted, and NOT marked private.
        return {
          hostname: "www.packyapi.com",
          addresses: [{ address: "198.18.56.214", family: 4 }],
          privateNetwork: false,
        };
      }) as ProviderOutboundDependencies["resolveAddresses"];

      const response = await providerOutboundGet(
        "packy",
        { baseUrl: "https://www.packyapi.com/v1" },
        "https://www.packyapi.com/v1/models",
        {},
        dependencies,
      );

      expect(await response.json()).toEqual({ data: [{ id: "gpt-5.5" }] });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(captured.address).toBeUndefined();
      // The wrapper enables the benchmark opt-in only because a proxy is configured.
      expect(resolveOptions).toEqual([{ allowBenchmarkAddresses: true }]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("Clash fake-IP without a configured proxy is not granted the benchmark opt-in (#1748)", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const { providerOutboundGet } = await import("../src/lib/provider-outbound");
    const resolveOptions: { allowBenchmarkAddresses?: boolean }[] = [];
    const { dependencies, captured } = directDependencies(new Response(null, { status: 500 }));
    dependencies.resolveAddresses = mock(async (_url: string, options?: { allowBenchmarkAddresses?: boolean }) => {
      resolveOptions.push({ allowBenchmarkAddresses: options?.allowBenchmarkAddresses });
      // What the real resolver does without the opt-in: benchmark answers reject.
      throw new Error("provider URL hostname www.packyapi.com resolves to benchmark address (198.18.56.214)");
    }) as ProviderOutboundDependencies["resolveAddresses"];

    await expect(providerOutboundGet(
      "packy",
      { baseUrl: "https://www.packyapi.com/v1" },
      "https://www.packyapi.com/v1/models",
      {},
      dependencies,
    )).rejects.toThrow(/benchmark address/);
    expect(captured.address).toBeUndefined();
    expect(resolveOptions).toEqual([{ allowBenchmarkAddresses: false }]);
  });

  test("NO_PROXY-matched hosts do not receive the fake-IP benchmark exception", async () => {
    const proxyUrl = "http://127.0.0.1:9";
    process.env.HTTPS_PROXY = proxyUrl;
    process.env.https_proxy = proxyUrl;
    process.env.NO_PROXY = "www.packyapi.com";
    process.env.no_proxy = "www.packyapi.com";
    const originalFetch = globalThis.fetch;
    const fetchMock = mock(async () => new Response("unexpected", { status: 500 })) as typeof fetch;
    globalThis.fetch = fetchMock;
    try {
      const { providerOutboundGet } = await import("../src/lib/provider-outbound");
      const resolveOptions: { allowBenchmarkAddresses?: boolean }[] = [];
      const { dependencies, captured } = directDependencies(new Response(null, { status: 500 }));
      dependencies.resolveAddresses = mock(async (_url: string, options?: { allowBenchmarkAddresses?: boolean }) => {
        resolveOptions.push({ allowBenchmarkAddresses: options?.allowBenchmarkAddresses });
        throw new Error("provider URL hostname www.packyapi.com resolves to benchmark address (198.18.56.214)");
      }) as ProviderOutboundDependencies["resolveAddresses"];

      await expect(providerOutboundGet(
        "packy",
        { baseUrl: "https://www.packyapi.com/v1" },
        "https://www.packyapi.com/v1/models",
        {},
        dependencies,
      )).rejects.toThrow(/benchmark address/);

      expect(resolveOptions).toEqual([{ allowBenchmarkAddresses: false }]);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(captured.address).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("built-in ollama admits loopback discovery without an explicit allowPrivateNetwork flag (#758)", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const { providerOutboundGet } = await import("../src/lib/provider-outbound");
    let sawAllowPrivate: boolean | undefined;
    const dependencies: ProviderOutboundDependencies = {
      resolveAddresses: mock(async (_url, options) => {
        sawAllowPrivate = typeof options === "object" && options?.allowPrivateNetwork === true;
        return {
          hostname: "127.0.0.1",
          addresses: [{ address: "127.0.0.1", family: 4 }],
          privateNetwork: true,
        };
      }),
      pinnedGet: mock(async () => new Response('{"data":[{"id":"llama"}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      })),
    };

    const response = await providerOutboundGet(
      "ollama",
      { baseUrl: "http://127.0.0.1:11434/v1" },
      "http://127.0.0.1:11434/v1/models",
      {},
      dependencies,
    );
    expect(sawAllowPrivate).toBe(true);
    expect(await response.json()).toEqual({ data: [{ id: "llama" }] });
  });

  test("direct redirects return the same credential-safe final-URL guidance", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const redirectTarget = new URL("https://final.example/v1/models?token=secret#fragment");
    redirectTarget.username = "user";
    redirectTarget.password = "password";
    const { providerOutboundGet, providerRedirectError } = await import("../src/lib/provider-outbound");
    const { dependencies } = directDependencies(new Response(null, {
      status: 302,
      headers: { location: redirectTarget.toString() },
    }));
    const requestUrl = "https://provider.example/v1/models";

    const response = await providerOutboundGet(
      "custom",
      { baseUrl: "https://provider.example/v1" },
      requestUrl,
      {},
      dependencies,
    );
    const error = await providerRedirectError(response, requestUrl);

    expect(error).toContain("returned 302 redirect");
    expect(error).toContain("https://final.example/v1/models");
    expect(error).not.toContain("user:password");
    expect(error).not.toContain("token=secret");
  });

  test("a per-provider fetch override remains the transport injection boundary", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const override = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response('{"data":[{"id":"override-model"}]}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const provider = {
      baseUrl: "https://override.example/v1",
      fetch: override,
    } as { baseUrl: string; fetch: typeof fetch };
    const { providerOutboundGet } = await import("../src/lib/provider-outbound");

    const response = await providerOutboundGet(
      "override",
      provider,
      "https://override.example/v1/models",
    );

    expect(await response.json()).toEqual({ data: [{ id: "override-model" }] });
    expect(override).toHaveBeenCalledTimes(1);
  });

  test("proxy mode reaches one real proxy across outbound, connection-test, and model-discovery paths", async () => {
    const childHome = mkdtempSync(join(tmpdir(), "ocx-provider-proxy-e2e-"));
    const child = Bun.spawn([
      process.execPath,
      "tests/fixtures/provider-outbound-e2e.ts",
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        OPENCODEX_HOME: childHome,
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) {
        throw new Error(`provider outbound fixture exited ${exitCode}: ${stderr.trim()}`);
      }
      const result = JSON.parse(stdout.trim()) as {
        outbound: { status: number; body: string };
        allProxy: { status: number; body: string };
        managementProxy: Record<string, unknown>;
        proxyModels: string[];
        managementNoProxy: Record<string, unknown>;
        managementDirect: Record<string, unknown>;
        directModels: string[];
        proxyRequests: string[];
        providerRequests: string[];
      };

      expect(result.outbound).toEqual({
          status: 200,
          body: '{"data":[{"id":"proxied-model"}]}',
      });
      expect(result.allProxy).toEqual({
        status: 200,
        body: '{"data":[{"id":"proxied-model"}]}',
      });
      expect(result.managementProxy.ok).toBe(false);
      expect(String(result.managementProxy.error)).toContain("returned 302 redirect");
      expect(String(result.managementProxy.error)).toContain("http://final.example/v1/models");
      expect(String(result.managementProxy.error)).not.toContain("user:password");
      expect(String(result.managementProxy.error)).not.toContain("token=secret");
      expect(result.proxyModels).toEqual(["proxy-discovered-model"]);
      expect(result.managementNoProxy).toMatchObject({ ok: true, models: 1 });
      expect(result.managementDirect).toMatchObject({ ok: true, models: 1 });
      expect(result.directModels).toEqual(["local-model"]);
      expect(result.proxyRequests).toEqual([
        "http://proxy-only.invalid/v1/models",
        "http://connection-proxy.invalid/v1/models",
        "http://proxy-models.invalid/v1/models",
        "http://all-proxy-only.invalid/v1/models",
      ]);
      expect(result.providerRequests).toEqual(["/v1/models", "/v1/models", "/v1/models"]);
      expect(stderr).toContain("cannot be pinned locally");
    } finally {
      removeTreeWithRetry(childHome);
    }
  }, 15_000);
});

describe("provider outbound POST transport", () => {
  test("direct HTTPS posts only to the validated address with its credential and body", async () => {
    for (const key of proxyKeys) delete process.env[key];
    const { providerOutboundPost } = await import("../src/lib/provider-outbound");
    const { dependencies, captured } = directDependencies(new Response('{"models":{}}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    const body = JSON.stringify({ project: "test-project" });

    const response = await providerOutboundPost(
      "google-antigravity",
      { baseUrl: "https://provider.example" },
      "https://provider.example/v1internal:fetchAvailableModels",
      { headers: { authorization: "Bearer test-token" }, body },
      dependencies,
    );

    expect(await response.json()).toEqual({ models: {} });
    expect(captured).toEqual({
      address: "93.184.216.34",
      rejectUnauthorized: true,
      authorization: "Bearer test-token",
      body,
    });
  });

  test("blocks an unsafe POST destination before invoking a caller-owned executor", async () => {
    const { providerOutboundPost, ProviderOutboundPolicyError } = await import("../src/lib/provider-outbound");
    let calls = 0;
    const provider = {
      baseUrl: "https://provider.example",
      fetch: (async () => {
        calls += 1;
        return new Response("{}");
      }) as typeof fetch,
    };

    await expect(providerOutboundPost(
      "google-antigravity",
      provider,
      "https://169.254.169.254/v1internal:fetchAvailableModels",
      { headers: { authorization: "Bearer test-token" }, body: '{"project":"test-project"}' },
    )).rejects.toThrow(ProviderOutboundPolicyError);
    expect(calls).toBe(0);
  });

  test("requires HTTPS before invoking a caller-owned executor", async () => {
    const { providerOutboundPost, ProviderOutboundPolicyError } = await import("../src/lib/provider-outbound");
    let calls = 0;
    const provider = {
      baseUrl: "https://provider.example",
      fetch: (async () => {
        calls += 1;
        return new Response("{}");
      }) as typeof fetch,
    };

    await expect(providerOutboundPost(
      "google-antigravity",
      provider,
      "http://93.184.216.34/v1internal:fetchAvailableModels",
      { headers: { authorization: "Bearer test-token" }, body: '{"project":"test-project"}' },
    )).rejects.toThrow(ProviderOutboundPolicyError);
    expect(calls).toBe(0);
  });
});
