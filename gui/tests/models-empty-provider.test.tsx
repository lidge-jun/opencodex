import { afterEach, beforeEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import http2 from "node:http2";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import Models, { EmptyProviderHint } from "../src/pages/Models";
import type { ProviderDiscoverySummary } from "../src/models-groups";
import { gatherRoutedModels } from "../../src/codex/catalog";
import {
  clearModelCache,
  getProviderDiscoveryStatus,
  markProviderDiscoveryFailed,
  type ProviderModelDiscoveryStatus,
} from "../../src/codex/model-cache";
import { handleManagementAPI } from "../../src/server/management-api";

let previousLanguage: unknown;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  previousLanguage = (globalThis.navigator as { language?: unknown } | undefined)?.language;
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: "en-US",
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  Object.defineProperty(globalThis.navigator, "language", {
    configurable: true,
    value: previousLanguage,
  });
});

function renderHint(liveModels: boolean, discovery?: ProviderDiscoverySummary): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <EmptyProviderHint liveModels={liveModels} discovery={discovery} />
    </LanguageProvider>,
  );
}

async function providerDto(
  provider: string,
  adapter: "openai-chat" | "cursor" = "openai-chat",
  liveModels = true,
): Promise<Record<string, unknown>> {
  const requestUrl = new URL("http://127.0.0.1/api/providers");
  const response = await handleManagementAPI(
    new Request(requestUrl),
    requestUrl,
    {
      providers: {
        [provider]: {
          adapter,
          baseUrl: adapter === "cursor" ? "https://api2.cursor.sh" : "https://api.example.test/v1",
          liveModels,
          models: [],
        },
      },
    },
  );
  const providers = await response!.json() as Array<Record<string, unknown>>;
  return providers[0] ?? {};
}

test("Models page keeps the discovery-failure badge visible with fallback rows", async () => {
  const domGlobals = ["document", "window", "localStorage", "IS_REACT_ACT_ENVIRONMENT"] as const;
  const previousDescriptors = Object.fromEntries(
    domGlobals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  ) as Record<(typeof domGlobals)[number], PropertyDescriptor | undefined>;
  const testWindow = new Window({ url: "http://localhost/" });
  const container = testWindow.document.createElement("div");
  testWindow.document.body.append(container);
  let root: Root | undefined;

  Object.defineProperties(globalThis, {
    document: { configurable: true, value: testWindow.document },
    window: { configurable: true, value: testWindow },
    localStorage: { configurable: true, value: testWindow.localStorage },
    IS_REACT_ACT_ENVIRONMENT: { configurable: true, value: true },
  });
  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.endsWith("/api/models")) {
      return Response.json([{
        provider: "fallback-provider",
        id: "configured-fallback",
        namespaced: "fallback-provider/configured-fallback",
        disabled: false,
      }]);
    }
    if (url.endsWith("/api/providers")) {
      return Response.json([{
        name: "fallback-provider",
        liveModels: true,
        models: ["configured-fallback"],
        discovery: { status: "failed", reason: "http", httpStatus: 401 },
      }]);
    }
    if (url.endsWith("/api/provider-context-caps")) return Response.json({ caps: {} });
    if (url.endsWith("/api/combos")) return Response.json([]);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  try {
    const { createRoot } = await import("react-dom/client");
    await act(async () => {
      root = createRoot(container);
      root.render(
        <LanguageProvider>
          <Models apiBase="http://localhost" />
        </LanguageProvider>,
      );
    });
    await act(async () => {
      await new Promise(resolve => testWindow.setTimeout(resolve, 0));
      await Promise.resolve();
    });

    expect(container.textContent).toContain("fallback-provider/configured-fallback");
    expect(container.querySelector(".badge.badge-amber")?.textContent).toContain("Discovery failed");
    expect(container.textContent).not.toContain("No models were discovered");
  } finally {
    if (root) {
      await act(async () => root?.unmount());
    }
    testWindow.close();
    for (const key of domGlobals) {
      const descriptor = previousDescriptors[key];
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

async function withCursorDiscoveryServer<T>(
  status: number,
  run: (baseUrl: string) => Promise<T>,
): Promise<T> {
  const server = http2.createServer();
  server.on("stream", stream => {
    stream.respond({ ":status": status, "content-type": "application/proto" });
    stream.end();
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") throw new Error("HTTP/2 fixture did not bind a TCP port");
  try {
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("empty live-discovery provider renders endpoint guidance and a settings link", () => {
  const html = renderHint(true, { status: "ok" });
  expect(html).toContain("No models were discovered");
  expect(html).toContain('href="#providers"');
  expect(html).toContain("Open provider settings");
  expect(html).not.toContain("Discovery failed");
});

test("failed HTTP discovery renders an amber status badge and reason", () => {
  const html = renderHint(true, { status: "failed", reason: "http", httpStatus: 401 });
  expect(html).toContain("Discovery failed");
  expect(html).toContain("HTTP 401");
  expect(html).toContain('class="badge badge-amber"');
  expect(html).toContain('role="status"');
  expect(html).toContain('href="#providers"');
});

test("failed discovery renders each server-owned reason without provider detail", () => {
  const cases: Array<[ProviderDiscoverySummary, string]> = [
    [{ status: "failed", reason: "blocked" }, "blocked by the destination policy"],
    [{ status: "failed", reason: "invalid_response" }, "returned an invalid response"],
    [{ status: "failed", reason: "network" }, "due to a network error"],
    [{ status: "failed", reason: "provider" }, "provider reported a model discovery error"],
  ];

  for (const [discovery, reason] of cases) {
    const html = renderHint(true, discovery);
    expect(html).toContain("Discovery failed");
    expect(html).toContain(reason);
    expect(html).toContain("Open provider settings");
  }
});

test("HTTP 401 discovery exposes HTTP status and badge", async () => {
  const provider = "activation-http-401";
  globalThis.fetch = (async () => new Response(null, { status: 401 })) as typeof fetch;

  await gatherRoutedModels({
    providers: {
      [provider]: {
        adapter: "openai-chat",
        baseUrl: "https://93.184.216.34/v1",
        apiKey: "sk-test",
      },
    },
  });

  const discovery = { status: "failed", reason: "http", httpStatus: 401 } as const;
  expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
  expect(await providerDto(provider)).toMatchObject({ discovery });
  const html = renderHint(true, discovery);
  expect(html).toContain("Discovery failed");
  expect(html).toContain("HTTP 401");
  expect(html).toContain('href="#providers"');
});

test("destination-blocked discovery exposes blocked status and badge", async () => {
  const provider = "activation-blocked";
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ data: [] });
  }) as typeof fetch;

  const models = await gatherRoutedModels({
    providers: {
      [provider]: {
        adapter: "openai-chat",
        baseUrl: "http://198.18.0.1/v1",
        apiKey: "sk-test",
        models: ["static-fallback"],
      },
    },
  });

  const discovery = { status: "failed", reason: "blocked" } as const;
  expect(fetchCalls).toBe(0);
  expect(models.map(model => model.id)).toEqual(["static-fallback"]);
  expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
  expect(await providerDto(provider)).toMatchObject({ discovery });
  const html = renderHint(true, discovery);
  expect(html).toContain("Discovery failed");
  expect(html).toContain("blocked by the destination policy");
  expect(html).toContain('href="#providers"');
});

test("invalid JSON or malformed model data exposes invalid-response status and badge", async () => {
  const fixtures = [
    { name: "invalid-json", body: "{not-json" },
    { name: "missing-data", body: JSON.stringify({ models: [] }) },
    { name: "malformed-data", body: JSON.stringify({ data: [{ id: 42 }] }) },
  ];

  for (const fixture of fixtures) {
    const provider = `activation-${fixture.name}`;
    globalThis.fetch = (async () => new Response(fixture.body, {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
    const models = await gatherRoutedModels({
      providers: {
        [provider]: {
          adapter: "openai-chat",
          baseUrl: "https://93.184.216.34/v1",
          apiKey: "sk-test",
          models: ["static-fallback"],
        },
      },
    });

    const discovery = { status: "failed", reason: "invalid_response" } as const;
    expect(models.map(model => model.id)).toEqual(["static-fallback"]);
    expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
    expect(await providerDto(provider)).toMatchObject({ discovery });
    const html = renderHint(true, discovery);
    expect(html).toContain("Discovery failed");
    expect(html).toContain("returned an invalid response");
    clearModelCache(provider);
  }
});

test("network discovery failure exposes sanitized network status and badge", async () => {
  const provider = "activation-network";
  const sentinel = "SENTINEL-PRIVATE-URL-https://secret.invalid/account";
  globalThis.fetch = (async () => {
    throw new TypeError(sentinel);
  }) as typeof fetch;

  await gatherRoutedModels({
    providers: {
      [provider]: {
        adapter: "openai-chat",
        baseUrl: "https://93.184.216.34/v1",
        apiKey: "sk-test",
      },
    },
  });

  const discovery = { status: "failed", reason: "network" } as const;
  expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
  const dto = await providerDto(provider);
  expect(dto).toMatchObject({ discovery });
  const html = renderHint(true, discovery);
  expect(html).toContain("Discovery failed");
  expect(html).toContain("due to a network error");
  expect(JSON.stringify(dto)).not.toContain(sentinel);
  expect(html).not.toContain(sentinel);
});

test("Cursor discovery failure exposes provider status and badge", async () => {
  const provider = "activation-cursor";
  const rawDetail = "HTTP 401";
  const models = await withCursorDiscoveryServer(401, baseUrl => gatherRoutedModels({
    providers: {
      [provider]: {
        adapter: "cursor",
        baseUrl,
        apiKey: "bad-token",
        models: ["auto"],
      },
    },
  }));

  const discovery = { status: "failed", reason: "provider" } as const;
  expect(models.map(model => model.id)).toEqual(["auto"]);
  expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
  const dto = await providerDto(provider, "cursor");
  expect(dto).toMatchObject({ discovery });
  const html = renderHint(true, discovery);
  expect(html).toContain("Discovery failed");
  expect(html).toContain("provider reported a model discovery error");
  expect(JSON.stringify(dto)).not.toContain(rawDetail);
  expect(html).not.toContain(rawDetail);
});

test("successful discovery clears every prior failure reason", async () => {
  const provider = "activation-reset";
  const failures: Array<Extract<ProviderModelDiscoveryStatus, { status: "failed" }>> = [
    { status: "failed", reason: "blocked" },
    { status: "failed", reason: "http", httpStatus: 401 },
    { status: "failed", reason: "invalid_response" },
    { status: "failed", reason: "network" },
    { status: "failed", reason: "provider" },
  ];
  globalThis.fetch = (async () => Response.json({ data: [] })) as typeof fetch;

  for (const { status: _status, ...failure } of failures) {
    markProviderDiscoveryFailed(provider, failure);
    await gatherRoutedModels({
      modelCacheTtlMs: 0,
      providers: {
        [provider]: {
          adapter: "openai-chat",
          baseUrl: "https://93.184.216.34/v1",
          apiKey: "sk-test",
        },
      },
    });

    const discovery = { status: "ok" } as const;
    expect(getProviderDiscoveryStatus(provider)).toEqual(discovery);
    expect(await providerDto(provider)).toMatchObject({ discovery });
    const html = renderHint(true, discovery);
    expect(html).toContain("No models were discovered");
    expect(html).not.toContain("Discovery failed");
  }

  clearModelCache(provider);
  expect(getProviderDiscoveryStatus(provider)).toBeUndefined();
  expect(await providerDto(provider)).not.toHaveProperty("discovery");
});

test("static catalog paths clear stale discovery failures and omit them from the API", async () => {
  for (const adapter of ["openai-chat", "cursor"] as const) {
    const provider = `static-${adapter}`;
    markProviderDiscoveryFailed(provider, { reason: "http", httpStatus: 401 });
    expect(await providerDto(provider, adapter, false)).not.toHaveProperty("discovery");

    const models = await gatherRoutedModels({
      modelCacheTtlMs: 0,
      providers: {
        [provider]: {
          adapter,
          baseUrl: adapter === "cursor" ? "https://api2.cursor.sh" : "https://api.example.test/v1",
          liveModels: false,
          models: ["configured-fallback"],
        },
      },
    });

    expect(models.map(model => model.id)).toEqual(["configured-fallback"]);
    expect(getProviderDiscoveryStatus(provider)).toBeUndefined();
    expect(await providerDto(provider, adapter, false)).not.toHaveProperty("discovery");
  }
});

test("empty static provider explains that live discovery is disabled", () => {
  const html = renderHint(false);
  expect(html).toContain("Live model discovery is off");
  expect(html).toContain('role="status"');
  expect(html).not.toContain("Discovery failed");
});
