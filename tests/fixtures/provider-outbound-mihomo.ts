import assert from "node:assert/strict";
import { mock } from "bun:test";
import type { ProviderOutboundDependencies } from "../../src/lib/provider-outbound";
import { PROXY_ENV_KEYS } from "../../src/lib/proxy-env";

// Isolate the DNS module mock from other tests while exercising the real classifier.
let answers: { address: string; family: number }[] = [];
let dnsCalls = 0;
mock.module("node:dns/promises", () => ({ lookup: async () => { dnsCalls++; return answers; } }));
const { providerOutboundGet, providerOutboundPost, ProviderOutboundPolicyError } = await import("../../src/lib/provider-outbound");
const target = "https://opencode.ai/zen/v1/models";
const fake = { address: "fdfe:dcba:9876::1", family: 6 };
const body = '{"project":"mihomo-fixture"}';
let ipv6Pinned = 0;
let proxyBound = 0;
let denied = 0;

for (const method of ["GET", "POST"] as const) {
  async function attempt(
    env: Record<string, string>,
    dns: typeof answers,
    expected: "pinned" | "proxy" | "denied",
    url = target,
    proof: "canonical" | "missing" | "noncanonical" = "canonical",
  ) {
    for (const key of PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()])) delete process.env[key];
    Object.assign(process.env, env);
    answers = dns;
    dnsCalls = 0;
    let pinnedCalls = 0;
    let fetchCalls = 0;
    const originalFetch = globalThis.fetch;
    const capture: NonNullable<ProviderOutboundDependencies["pinnedGet"]> = async (requestUrl, address, _signal, options) => {
      pinnedCalls++;
      assert.equal(expected, "pinned");
      assert.equal(requestUrl, target);
      assert.deepEqual(address, fake);
      assert.equal(options?.rejectUnauthorized, true);
      assert.equal(new Headers(options?.headers).get("authorization"), "Bearer mihomo-fixture");
      return new Response("pinned");
    };
    const dependencies: ProviderOutboundDependencies = {
      ...(proof !== "missing" ? { isCanonicalUrl: (name: string, value: string) => proof === "canonical" && name === "opencode-go" && value === url } : {}),
      pinnedGet: capture,
      pinnedPost: async (requestUrl, address, requestBody, signal, options) => {
        assert.equal(method, "POST");
        assert.equal(requestBody, body);
        return capture(requestUrl, address, signal, options);
      },
    };
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit & { proxy?: string }) => {
      fetchCalls++;
      assert.equal(expected, "proxy");
      assert.equal(String(input), target);
      assert.equal(init?.proxy, "http://127.0.0.1:7897");
      assert.equal(init?.redirect, "manual");
      assert.equal(init?.method, method);
      if (method === "POST") assert.equal(init?.body, body);
      return new Response("proxy");
    }, { preconnect: originalFetch.preconnect });
    try {
      const provider = { baseUrl: "https://opencode.ai/zen/v1" };
      const init = { headers: { authorization: "Bearer mihomo-fixture" } };
      const request = method === "GET"
        ? providerOutboundGet("opencode-go", provider, url, init, dependencies)
        : providerOutboundPost("opencode-go", provider, url, { ...init, body }, dependencies);
      if (expected === "denied") {
        await assert.rejects(request, ProviderOutboundPolicyError);
        assert.equal(pinnedCalls, 0);
        assert.equal(fetchCalls, 0);
        denied++;
      } else {
        assert.equal(await (await request).text(), expected);
        assert.equal(pinnedCalls, expected === "pinned" ? 1 : 0);
        assert.equal(fetchCalls, expected === "proxy" ? 1 : 0);
        if (expected === "pinned") ipv6Pinned++;
        else proxyBound++;
      }
      assert.equal(dnsCalls, url.startsWith("https://[") ? 0 : 1, "hostname requests must use the isolated DNS mock");
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  // TUN handles the validated IPv6 address even if unrelated proxy variables exist.
  const directEnvs: Record<string, string>[] = [{}, { HTTP_PROXY: "http://127.0.0.1:7897" }, { ALL_PROXY: "socks5://127.0.0.1:7891" }];
  for (const env of directEnvs) {
    await attempt(env, [fake], "pinned");
  }
  await attempt({ HTTPS_PROXY: "http://127.0.0.1:7897" }, [fake], "proxy");

  for (const noProxy of ["opencode.ai", ".opencode.ai", "*"]) {
    const noProxyEnvs: Record<string, string>[] = [{ NO_PROXY: noProxy }, { NO_PROXY: noProxy, HTTPS_PROXY: "http://127.0.0.1:7897" }];
    for (const env of noProxyEnvs) {
      await attempt(env, [fake], "denied");
    }
  }
  for (const address of ["127.0.0.1", "10.0.0.5", "169.254.169.254", "169.254.1.2", "::1", "fd00::1", "fe80::1", "::", "fdfe:dcba:9877::1"]) {
    const unsafe = { address, family: address.includes(":") ? 6 : 4 };
    await attempt({}, [fake, unsafe], "denied");
    await attempt({}, [unsafe, fake], "denied");
  }
  await attempt({}, [fake], "denied", target, "missing");
  await attempt({}, [fake], "denied", "https://custom.example/v1/models", "noncanonical");
  // Even an erroneous canonical proof cannot admit a literal fake IP.
  await attempt({}, [fake], "denied", "https://[fdfe:dcba:9876::1]/v1/models");
}

console.log("MIHOMO_RESULT=" + JSON.stringify({ ipv6Pinned, proxyBound, denied }));
