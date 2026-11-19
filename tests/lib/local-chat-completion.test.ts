import { afterEach, expect, test } from "bun:test";
import { networkInterfaces } from "node:os";
import { consultAdvisor } from "../../src/advisor/consult";
import { postLocalChatCompletion } from "../../src/lib/local-chat-completion";
import { ADVISOR_INTERNAL_CAPABILITY_HEADER } from "../../src/lib/local-internal-call-capability";
import { configuredOutboundFetch, PROXY_ENV_KEYS } from "../../src/lib/proxy-env";
import { parseRequest } from "../../src/responses/parser";
import {
  ADVISOR_ADMISSION_POLICY_HEADER,
  readInternalCallRegistration,
  SIDECAR_ADMISSION_POLICY_HEADER,
  SIDECAR_INTERNAL_CAPABILITY_HEADER,
} from "../../src/server/advisor-admission-scope";
import { describeImageRouted } from "../../src/vision/routed-describe";
import { allowOwnInterfaceAddressesForTest } from "../helpers/network-egress-guard";

let server: ReturnType<typeof Bun.serve> | null = null;

afterEach(async () => {
  await server?.stop(true);
  server = null;
});

const CONFIG = { port: 0, hostname: "127.0.0.1", apiKeys: [] };

function completion(content: string): string {
  return JSON.stringify({ choices: [{ message: { role: "assistant", content } }] });
}

function serve(respond: () => Response): string {
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: respond });
  return `http://127.0.0.1:${server.port}`;
}

function send(baseUrlOverride: string, maxResponseBytes: number) {
  return postLocalChatCompletion({
    config: CONFIG,
    body: { model: "m", messages: [] },
    label: "role sizing",
    logTag: "role-sizing",
    timeoutMs: 5_000,
    maxResponseBytes,
    boundWhileStreaming: true,
    baseUrlOverride,
  });
}

test("returns the completion text when the body fits the byte bound", async () => {
  const base = serve(() => new Response(completion("small")));
  expect(await send(base, 1024)).toEqual({ text: "small" });
});

const nonLoopbackIPv4 = Object.values(networkInterfaces()).flat()
  .find(entry => entry?.family === "IPv4" && !entry.internal)?.address;

test.skipIf(!nonLoopbackIPv4)("capability-bearing self-fetches bypass outbound HTTP proxy on a non-loopback bind", async () => {
  const providerUrl = "http://provider.invalid/v1/models";
  const proxyRequests: string[] = [];
  const proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
    proxyRequests.push(req.url === providerUrl ? "provider" : "unexpected");
    return new Response("proxied provider response");
  } });
  const envKeys = [...PROXY_ENV_KEYS.flatMap(key => [key, key.toLowerCase()]), "OPENCODEX_API_AUTH_TOKEN"];
  const savedEnv = envKeys.map(key => [key, process.env[key]] as const);
  const restoreEgressGuard = allowOwnInterfaceAddressesForTest();
  try {
    for (const key of envKeys) delete process.env[key];
    process.env.HTTP_PROXY = proxy.url.origin;
    process.env.NO_PROXY = "localhost,127.0.0.1,::1,[::1]";
    process.env.OPENCODEX_API_AUTH_TOKEN = "test-self-fetch-key";

    const hostname = nonLoopbackIPv4!;
    server = Bun.serve({ hostname, port: 0, fetch(req) {
      const advisor = req.headers.has(ADVISOR_INTERNAL_CAPABILITY_HEADER);
      const registration = readInternalCallRegistration(
        req.headers.get(advisor ? ADVISOR_ADMISSION_POLICY_HEADER : SIDECAR_ADMISSION_POLICY_HEADER),
        req.headers.get(advisor ? ADVISOR_INTERNAL_CAPABILITY_HEADER : SIDECAR_INTERNAL_CAPABILITY_HEADER),
      );
      if (!registration || req.headers.get("x-opencodex-api-key") !== "test-self-fetch-key") {
        return new Response(null, { status: 403 });
      }
      return new Response(completion(advisor ? "advisor-direct" : "sidecar-direct"));
    } });
    const config = { hostname, port: server.port, unauthenticatedLoopbackListener: { enabled: false }, apiKeys: [] };

    const sidecar = await postLocalChatCompletion({
      config, body: { model: "m", messages: [] }, label: "test", logTag: "test",
      timeoutMs: 2_000, maxResponseBytes: 1024,
    });
    const advisor = await consultAdvisor({
      parsed: parseRequest({ model: "worker", input: "Test the consultation" }),
      workerIdentity: "worker", advisorModel: "expert", reason: "manual",
    }, config, "medium", 2_000);
    const provider = await configuredOutboundFetch(providerUrl, { signal: AbortSignal.timeout(2_000) });

    expect(proxyRequests).toEqual(["provider"]);
    expect(sidecar).toEqual({ text: "sidecar-direct" });
    expect(advisor).toMatchObject({ ok: true, advice: "advisor-direct" });
    expect(await provider.text()).toBe("proxied provider response");
  } finally {
    restoreEgressGuard();
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await proxy.stop(true);
  }
});

test("stops reading an endless body at the byte bound and cancels it", async () => {
  let cancelled = false;
  const chunk = new TextEncoder().encode("x".repeat(16 * 1024));
  const base = serve(() => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  })));
  const outcome = await send(base, 64 * 1024);
  expect(outcome).toEqual({ text: "", error: "role sizing response exceeded byte bound" });
  for (let i = 0; i < 50 && !cancelled; i += 1) await Bun.sleep(20);
  expect(cancelled).toBe(true);
});

test("counts UTF-8 bytes, not UTF-16 units, against the bound", async () => {
  const body = completion("가".repeat(1_000));
  expect(body.length).toBeLessThan(2_048);
  expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(2_048);
  const base = serve(() => new Response(body));
  expect(await send(base, 2_048)).toEqual({ text: "", error: "role sizing response exceeded byte bound" });
});

test("the routed vision describer keeps its upstream UTF-16 length bound", async () => {
  const caption = "가".repeat(2 * 1024 * 1024);
  const body = completion(caption);
  expect(body.length).toBeLessThan(4 * 1024 * 1024);
  expect(new TextEncoder().encode(body).byteLength).toBeGreaterThan(4 * 1024 * 1024);
  const base = serve(() => new Response(body));
  const outcome = await describeImageRouted(
    "data:image/png;base64,aGVsbG8=",
    undefined,
    "",
    "vlm/qwen-vl",
    CONFIG,
    { model: "vlm/qwen-vl", reasoning: "low", timeoutMs: 10_000 },
    undefined,
    base,
  );
  expect(outcome.error).toBeUndefined();
  expect(outcome.text.length).toBe(caption.length);
});
