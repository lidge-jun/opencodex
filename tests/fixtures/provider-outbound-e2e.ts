import { mock } from "bun:test";
import * as dns from "node:dns/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import type { OcxConfig } from "../../src/types";

// Exercise real loopback HTTP transport without depending on the host resolver's
// retry policy for intentionally unresolvable names. Keep destination-policy
// real so it still classifies this child-local DNS failure itself.
const proxyHostnames = new Set([
  "proxy-only.invalid",
  "connection-proxy.invalid",
  "proxy-models.invalid",
  "all-proxy-only.invalid",
]);
const dnsLookups: string[] = [];
const unexpectedDnsLookups: string[] = [];
mock.module("node:dns/promises", () => ({
  ...dns,
  lookup: async (hostname: string) => {
    dnsLookups.push(hostname);
    if (!proxyHostnames.has(hostname)) unexpectedDnsLookups.push(hostname);
    throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), {
      code: "ENOTFOUND", syscall: "getaddrinfo", hostname,
    });
  },
}));

// Install the seam before loading production modules that capture lookup.
const { saveConfig } = await import("../../src/config");
const { fetchProviderModels } = await import("../../src/codex/catalog/provider-fetch");
const { providerOutboundGet } = await import("../../src/lib/provider-outbound");
const { handleManagementAPI } = await import("../../src/server/management-api");
const { ManagementRequest: Request } = await import("../helpers/management-auth");

const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

async function probe(config: OcxConfig, name: string): Promise<Record<string, unknown>> {
  saveConfig(config);
  const request = new Request(`http://127.0.0.1/api/providers/test?name=${name}`, { method: "POST" });
  const response = await handleManagementAPI(request, new URL(request.url), config, {});
  if (!response) throw new Error("handler returned no response");
  return await response.json() as Record<string, unknown>;
}

const proxyRequests: string[] = [];
const providerRequests: string[] = [];
const redirectTarget = new URL("http://final.example/v1/models?token=secret#fragment");
redirectTarget.username = "user";
redirectTarget.password = "password";

const proxy = createServer((request, response) => {
  proxyRequests.push(request.url ?? "");
  if (request.url?.startsWith("http://connection-proxy.invalid/")) {
    response.writeHead(302, { location: redirectTarget.toString() });
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(request.url?.startsWith("http://proxy-models.invalid/")
    ? '{"data":[{"id":"proxy-discovered-model"}]}'
    : '{"data":[{"id":"proxied-model"}]}');
});
const provider = createServer((request, response) => {
  providerRequests.push(request.url ?? "");
  response.writeHead(200, { "content-type": "application/json" });
  response.end('{"data":[{"id":"local-model"}]}');
});

try {
  const [proxyPort, providerPort] = await Promise.all([listen(proxy), listen(provider)]);
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  process.env.HTTP_PROXY = proxyUrl;
  process.env.http_proxy = proxyUrl;
  process.env.NO_PROXY = "localhost,127.0.0.1,::1,[::1]";
  process.env.no_proxy = "localhost,127.0.0.1,::1,[::1]";

  console.error("fixture phase: outbound");
  const outboundResponse = await providerOutboundGet(
    "proxied",
    { baseUrl: "http://proxy-only.invalid/v1", allowPrivateNetwork: false },
    "http://proxy-only.invalid/v1/models",
  );
  const outbound = { status: outboundResponse.status, body: await outboundResponse.text() };

  console.error("fixture phase: management proxy");
  const managementProxy = await probe({
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "proxied",
    providers: {
      proxied: {
        adapter: "openai-chat",
        baseUrl: "http://connection-proxy.invalid/v1",
        apiKey: "sk-x",
      },
    },
  } as OcxConfig, "proxied");

  console.error("fixture phase: proxy discovery");
  const proxyModels = await fetchProviderModels("proxy-discovery-e2e", {
    baseUrl: "http://proxy-models.invalid/v1",
    adapter: "openai-chat",
    apiKey: "sk-test",
    models: [],
  }, 0);

  for (const key of proxyKeys) delete process.env[key];
  process.env.ALL_PROXY = proxyUrl;
  console.error("fixture phase: all proxy");
  const allProxyResponse = await providerOutboundGet(
    "all-proxy",
    { baseUrl: "http://all-proxy-only.invalid/v1", allowPrivateNetwork: false },
    "http://all-proxy-only.invalid/v1/models",
  );
  const allProxy = { status: allProxyResponse.status, body: await allProxyResponse.text() };

  const localConfig = {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "local",
    providers: {
      local: {
        adapter: "openai-chat",
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        apiKey: "sk-x",
        allowPrivateNetwork: true,
      },
    },
  } as OcxConfig;
  process.env.NO_PROXY = "localhost,127.0.0.1,::1,[::1]";
  process.env.no_proxy = "localhost,127.0.0.1,::1,[::1]";
  console.error("fixture phase: no proxy");
  const managementNoProxy = await probe(localConfig, "local");

  for (const key of proxyKeys) delete process.env[key];
  console.error("fixture phase: direct");
  const managementDirect = await probe(localConfig, "local");
  const directModels = await fetchProviderModels("direct-discovery-e2e", {
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    adapter: "openai-chat",
    apiKey: "sk-test",
    allowPrivateNetwork: true,
    models: [],
  }, 0);

  if (unexpectedDnsLookups.length > 0) {
    throw new Error(`Unexpected fixture DNS lookups: ${unexpectedDnsLookups.join(", ")}`);
  }

  console.log(JSON.stringify({
    dnsLookups,
    outbound,
    allProxy,
    managementProxy,
    proxyModels: proxyModels.map(model => model.id),
    managementNoProxy,
    managementDirect,
    directModels: directModels.map(model => model.id),
    proxyRequests,
    providerRequests,
  }));
} finally {
  console.error("fixture phase: closing listeners");
  await Promise.all([close(proxy), close(provider)]);
  console.error("fixture phase: closed");
}
