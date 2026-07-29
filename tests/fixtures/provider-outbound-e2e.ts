import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { saveConfig } from "../../src/config";
import { fetchProviderModels } from "../../src/codex/catalog/provider-fetch";
import { providerOutboundGet } from "../../src/lib/provider-outbound";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest as Request } from "../helpers/management-auth";

const proxyKeys = PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]);

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>(resolve => server.close(() => resolve()));
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

  const outboundResponse = await providerOutboundGet(
    "proxied",
    { baseUrl: "http://proxy-only.invalid/v1", allowPrivateNetwork: false },
    "http://proxy-only.invalid/v1/models",
  );
  const outbound = { status: outboundResponse.status, body: await outboundResponse.text() };

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

  const proxyModels = await fetchProviderModels("proxy-discovery-e2e", {
    baseUrl: "http://proxy-models.invalid/v1",
    adapter: "openai-chat",
    apiKey: "sk-test",
    models: [],
  }, 0);

  for (const key of proxyKeys) delete process.env[key];
  process.env.ALL_PROXY = proxyUrl;
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
  const managementNoProxy = await probe(localConfig, "local");

  for (const key of proxyKeys) delete process.env[key];
  const managementDirect = await probe(localConfig, "local");
  const directModels = await fetchProviderModels("direct-discovery-e2e", {
    baseUrl: `http://127.0.0.1:${providerPort}/v1`,
    adapter: "openai-chat",
    apiKey: "sk-test",
    allowPrivateNetwork: true,
    models: [],
  }, 0);

  console.log(JSON.stringify({
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
  await Promise.all([close(proxy), close(provider)]);
}
