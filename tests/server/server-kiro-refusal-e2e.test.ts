import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { saveCredential, saveAccountCredential, getAccountSet, setActiveAccount, credentialGeneration } from "../../src/oauth/store";
import { startServer } from "../../src/server";
import { handleResponses } from "../../src/server/responses";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";
import { ADAPTER_REGISTRY } from "../../src/adapters/registry";
import { encodeMessage } from "../../src/lib/eventstream-decoder";
import { KIRO_COMPLETION_TOOL_NAME } from "../../src/adapters/kiro-constants";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { clearAccountQuotaCache } from "../../src/providers/quota";
import { kiroAccountEvidence, noteKiroMonthlyRefusal } from "../../src/providers/kiro-usage";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const realFetch = globalThis.fetch;
const oldHome = process.env.OPENCODEX_HOME;
const oldRegion = process.env.KIRO_REGION;
let home: string;
let isolated: IsolatedCodexHome;
const aProfile = "arn:aws:codewhisperer:us-east-1:123456789012:profile/a";
const bProfile = "arn:aws:codewhisperer:eu-west-1:123456789012:profile/b";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ocx-kiro-refusal-server-"));
  isolated = installIsolatedCodexHome("ocx-kiro-refusal-codex-");
  process.env.OPENCODEX_HOME = home;
  process.env.KIRO_REGION = "us-east-1";
  clearAccountQuotaCache();
  clearGenericFailoverHealth();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  clearAccountQuotaCache();
  clearGenericFailoverHealth();
  if (oldHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = oldHome;
  if (oldRegion === undefined) delete process.env.KIRO_REGION;
  else process.env.KIRO_REGION = oldRegion;
  isolated.restore();
  removeTreeWithRetry(home);
});

function config(enabled?: boolean): OcxConfig {
  return { port: 0, hostname: "127.0.0.1", defaultProvider: "kiro",
    providers: { kiro: { adapter: "kiro", baseUrl: "https://runtime.us-east-1.kiro.dev",
      authMode: "oauth", models: ["claude-sonnet-4.5"] } },
    ...(enabled === undefined ? {} : { oauthAccountFailover: { enabled } }),
  } as OcxConfig;
}

async function seed(expiredA = false) {
  await saveCredential("kiro", { access: "access-a", refresh: "refresh-a",
    expires: expiredA ? Date.now() - 1_000 : Date.now() + 3_600_000,
    accountId: "a", source: "oauth", kiro: { profileArn: aProfile, apiRegion: "us-east-1" } }, { addAccount: true });
  await saveCredential("kiro", { access: "access-b", refresh: "refresh-b",
    expires: Date.now() + 3_600_000, accountId: "b", source: "oauth",
    kiro: { profileArn: bProfile, apiRegion: "eu-west-1" } }, { addAccount: true });
  const rows = getAccountSet("kiro")!.accounts;
  await setActiveAccount("kiro", rows[0]!.id);
  return rows;
}

async function post(server: ReturnType<typeof startServer>, stream = false) {
  return realFetch(new URL("/v1/responses", server.url), { method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "kiro/claude-sonnet-4.5", input: "hello", stream }) });
}

function answer(text: string) {
  return new Response(encodeMessage({ ":message-type": "event", ":event-type": "assistantResponseEvent" },
    new TextEncoder().encode(JSON.stringify({ content: text }))),
  { headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

function completedAnswer(text: string) {
  const frame = (payload: Record<string, unknown>) => encodeMessage(
    { ":message-type": "event", ":event-type": "toolUseEvent" },
    new TextEncoder().encode(JSON.stringify(payload)));
  const id = "completion-1";
  return new Response(Buffer.concat([
    frame({ name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id }),
    frame({ name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id, input: JSON.stringify({ answer: text }) }),
    frame({ name: KIRO_COMPLETION_TOOL_NAME, toolUseId: id, stop: true }),
  ]), { headers: { "content-type": "application/vnd.amazon.eventstream" } });
}

describe("Kiro refusal recovery through Responses", () => {
  test("a spent send budget returns the original normalized refusal after one physical send", async () => {
    await seed(); saveConfig(config());
    const budget = createRequestExecutionBudget({ maxTotalModelSends: 1,
      baseSendAllowance: 1, finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0, maxTargetTransitions: 0 });
    let sends = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        sends++;
        return new Response(JSON.stringify({ reason: "MONTHLY_REQUEST_COUNT" }), { status: 400 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const request = new Request("http://127.0.0.1/v1/responses", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "kiro/claude-sonnet-4.5", input: "hello", stream: false }) });
    const response = await handleResponses(request, config(),
      { model: "claude-sonnet-4.5", provider: "kiro" }, { sendBudget: budget });
    expect(response.status).toBe(400);
    expect(sends).toBe(1);
    expect(budget.used).toBe(1);
    const body = await response.text();
    expect(body).toContain("Kiro");
    expect(body).not.toContain('"reason"');
  });

  test("successful rotation cancels the original refusal body exactly once", async () => {
    await seed(); saveConfig(config());
    const refusalBodies = new Set<ReadableStream<Uint8Array>>();
    const originalClone = Response.prototype.clone;
    const cloneSpy = spyOn(Response.prototype, "clone").mockImplementation(function (this: Response) {
      const copy = originalClone.call(this);
      if (this.status === 400 && this.body) refusalBodies.add(this.body);
      return copy;
    });
    const originalCancel = ReadableStream.prototype.cancel;
    let refusalBodyCancels = 0;
    const cancelSpy = spyOn(ReadableStream.prototype, "cancel").mockImplementation(function (this: ReadableStream<Uint8Array>, reason) {
      if (refusalBodies.has(this)) refusalBodyCancels++;
      return originalCancel.call(this, reason);
    });
    let sends = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        sends++;
        if (sends === 1) {
          return new Response(JSON.stringify({ reason: "MONTHLY_REQUEST_COUNT" }), { status: 400 });
        }
        return answer("served by b");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    let server: ReturnType<typeof startServer> | undefined;
    try {
      server = startServer(0);
      const response = await post(server);
      expect(response.status).toBe(200);
      await response.text();
      expect(sends).toBe(2);
      expect(refusalBodyCancels).toBe(1);
      expect(cancelSpy).toHaveBeenCalledTimes(1);
    } finally { await server?.stop(true); cancelSpy.mockRestore(); cloneSpy.mockRestore(); }
  });

  test("a rotated request build failure returns the original normalized refusal", async () => {
    await seed(); saveConfig(config());
    const originalCreate = ADAPTER_REGISTRY.kiro.create;
    ADAPTER_REGISTRY.kiro.create = (provider, context) => {
      const adapter = originalCreate(provider, context);
      if (provider.apiKey === "access-b") adapter.buildRequest = async () => {
        throw new Error("synthetic rotated build failure");
      };
      return adapter;
    };
    let sends = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        sends++;
        return new Response(JSON.stringify({ reason: "TEMPORARILY_SUSPENDED" }), { status: 403 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    let server: ReturnType<typeof startServer> | undefined;
    try {
      server = startServer(0);
      const response = await post(server);
      expect(response.status).toBe(403);
      expect(sends).toBe(1);
      const body = await response.text();
      expect(body).toContain("Kiro");
      expect(body).not.toContain("synthetic rotated build failure");
      expect(body).not.toContain('"reason"');
    } finally { ADAPTER_REGISTRY.kiro.create = originalCreate; await server?.stop(true); }
  });

  for (const [status, reason] of [[400, "MONTHLY_REQUEST_COUNT"], [403, "TEMPORARILY_SUSPENDED"],
    [429, "USER_REQUEST_RATE_EXCEEDED"]] as const) {
    test(`streaming Kiro ${status} ${reason} rotates with paired bearer profile and region`, async () => {
      const [a] = await seed();
      saveConfig(config());
      const observed: Array<{ url: string; auth: string | null; profile: string | null }> = [];
      globalThis.fetch = (async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
          observed.push({ url, auth: new Headers(init?.headers).get("authorization"),
            profile: new Headers(init?.headers).get("x-amzn-kiro-profile-arn") });
          if (observed.length === 1) return new Response(JSON.stringify({ reason }), { status });
          return answer("served by b");
        }
        return realFetch(input, init);
      }) as typeof fetch;
      const server = startServer(0);
      try {
        const response = await post(server, true);
        expect(response.status).toBe(200);
        expect(await response.text()).toContain("served by b");
        expect(observed).toEqual([
          { url: "https://runtime.us-east-1.kiro.dev/", auth: "Bearer access-a", profile: aProfile },
          { url: "https://runtime.eu-west-1.kiro.dev/", auth: "Bearer access-b", profile: bProfile },
        ]);
        if (status === 400) expect(kiroAccountEvidence(a!).exhausted).toBe(true);
      } finally { await server.stop(true); }
    });
  }


  test("Kiro web-search sidecar completion clears B's older verdict after rotated refusal", async () => {
    const [a, b] = await seed();
    saveConfig({ ...config(), webSearchSidecar: { backend: "exa", exaApiKey: "synthetic" } } as OcxConfig);
    let sends = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        sends++;
        const auth = new Headers(init?.headers).get("authorization");
        if (auth === "Bearer access-a")
          return new Response(JSON.stringify({ reason: "MONTHLY_REQUEST_COUNT" }), { status: 400 });
        noteKiroMonthlyRefusal(b!.id, credentialGeneration(b!.credential), Date.now() - 10);
        return answer("web search ready");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await realFetch(new URL("/v1/responses", server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kiro/claude-sonnet-4.5", input: "hello", stream: true,
          tools: [{ type: "web_search_preview" }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(sends).toBe(2);
      expect(kiroAccountEvidence(a!).exhausted).toBe(true);
      expect(kiroAccountEvidence(b!).exhausted).toBe(false);
    } finally { await server.stop(true); }
  });

  test("Kiro image sidecar completion clears B's older verdict after rotated refusal", async () => {
    const [a, b] = await seed();
    saveConfig({ ...config(), images: { bridgeEnabled: true }, providers: {
      ...config().providers, xai: { adapter: "openai-chat", baseUrl: "https://api.x.ai/v1",
        authMode: "key", apiKey: "synthetic", models: ["grok-4"] },
    } } as OcxConfig);
    let sends = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        sends++;
        const auth = new Headers(init?.headers).get("authorization");
        if (auth === "Bearer access-a")
          return new Response(JSON.stringify({ reason: "TEMPORARILY_SUSPENDED" }), { status: 403 });
        noteKiroMonthlyRefusal(b!.id, credentialGeneration(b!.credential), Date.now() - 10);
        return completedAnswer("image bridge ready");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await realFetch(new URL("/v1/responses", server.url), {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "kiro/claude-sonnet-4.5", input: "hello", stream: true,
          tools: [{ type: "image_generation" }] }),
      });
      expect(response.status).toBe(200);
      await response.text();
      expect(sends).toBe(2);
      expect(kiroAccountEvidence(a!).exhausted).toBeUndefined();
      expect(kiroAccountEvidence(b!).exhausted).toBe(false);
    } finally { await server.stop(true); }
  });

  test("unknown Kiro 400 returns original status with normalized Kiro message", async () => {
    await seed(); saveConfig(config());
    let sends = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        sends++;
        return new Response(JSON.stringify({ reason: "INVALID_MODEL_ID" }), { status: 400 });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(400);
      expect(sends).toBe(1);
      expect(await response.text()).toContain("Kiro");
    } finally { await server.stop(true); }
  });

  test("Kiro post-output refusal never resends the turn", async () => {
    await seed(); saveConfig(config());
    let sends = 0;
    const textFrame = encodeMessage({ ":message-type": "event", ":event-type": "assistantResponseEvent" },
      new TextEncoder().encode(JSON.stringify({ content: "partial answer" })));
    const errorFrame = encodeMessage({ ":message-type": "exception", ":exception-type": "AccessDeniedException" },
      new TextEncoder().encode(JSON.stringify({ reason: "TEMPORARILY_SUSPENDED" })));
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        sends++;
        return new Response(Buffer.concat([textFrame, errorFrame]),
          { headers: { "content-type": "application/vnd.amazon.eventstream" } });
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await post(server, true);
      expect(response.status).toBe(200);
      await response.text();
      expect(sends).toBe(1);
    } finally { await server.stop(true); }
  });

  test("unrotated Kiro 5xx retains fixed public text after raw-error handoff", async () => {
    await seed(); saveConfig(config());
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if ((url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/"))
        || url === "https://q.us-east-1.amazonaws.com/")
        return new Response("PRIVATE_UPSTREAM_TEXT", { status: 503 });
      return realFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).toContain("Kiro upstream service unavailable");
      expect(body).not.toContain("PRIVATE_UPSTREAM_TEXT");
    } finally { await server.stop(true); }
  });

  test("terminal refresh rejection marks reauth and admits the sibling before any A send", async () => {
    const [a] = await seed(true); saveConfig(config());
    const sends: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/refreshToken")) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        sends.push(new Headers(init?.headers).get("authorization") ?? "");
        return answer("served by b");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(200);
      expect(sends).toEqual(["Bearer access-b"]);
      expect(getAccountSet("kiro")!.accounts.find(row => row.id === a!.id)?.needsReauth).toBe(true);
    } finally { await server.stop(true); }
  });

  test("a completed B turn clears only B's older verdict after A refusal", async () => {
    const [a, b] = await seed(); saveConfig(config());
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        const auth = new Headers(init?.headers).get("authorization");
        if (auth === "Bearer access-a") return new Response(JSON.stringify({ reason: "MONTHLY_REQUEST_COUNT" }), { status: 400 });
        noteKiroMonthlyRefusal(b!.id, credentialGeneration(b!.credential), Date.now() - 10);
        return answer("done");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(200);
      await response.text();
      expect(kiroAccountEvidence(a!).exhausted).toBe(true);
      expect(kiroAccountEvidence(b!).exhausted).toBe(false);
    } finally { await server.stop(true); }
  });

  test("proactive first admission skips a known monthly-exhausted active account", async () => {
    const [a] = await seed();
    noteKiroMonthlyRefusal(a!.id, credentialGeneration(a!.credential));
    saveConfig(config(true));
    const sends: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        sends.push(new Headers(init?.headers).get("authorization") ?? "");
        return answer("served by b");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(200);
      expect(sends).toEqual(["Bearer access-b"]);
    } finally { await server.stop(true); }
  });

  test("explicit proactive off keeps A for the first send and still rotates after refusal", async () => {
    await seed(); saveConfig(config(false));
    const sends: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        sends.push(auth);
        return auth === "Bearer access-a"
          ? new Response(JSON.stringify({ reason: "MONTHLY_REQUEST_COUNT" }), { status: 400 })
          : answer("served by b");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(200);
      expect(sends).toEqual(["Bearer access-a", "Bearer access-b"]);
    } finally { await server.stop(true); }
  });

  test("an unlisted refresh error on 400 does not mark reauth or rotate", async () => {
    const [a] = await seed(true); saveConfig(config());
    let sends = 0;
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/refreshToken")) return new Response(JSON.stringify({ error: "future_unknown" }), { status: 400 });
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) sends++;
      return realFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(401);
      expect(sends).toBe(0);
      expect(getAccountSet("kiro")!.accounts.find(row => row.id === a!.id)?.needsReauth).not.toBe(true);
    } finally { await server.stop(true); }
  });

  test("post-401 terminal refresh rejects A generation and replays on B once", async () => {
    const [a] = await seed(); saveConfig(config());
    const sends: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith("/refreshToken")) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        sends.push(auth);
        return auth === "Bearer access-a" ? new Response("expired", { status: 401 }) : answer("served by b");
      }
      return realFetch(input, init);
    }) as typeof fetch;
    const server = startServer(0);
    try {
      const response = await post(server);
      expect(response.status).toBe(200);
      expect(sends).toEqual(["Bearer access-a", "Bearer access-b"]);
      expect(getAccountSet("kiro")!.accounts.find(row => row.id === a!.id)?.needsReauth).toBe(true);
    } finally { await server.stop(true); }
  });

  for (const [status, reason] of [[400, "MONTHLY_REQUEST_COUNT"], [403, "TEMPORARILY_SUSPENDED"]] as const) {
    test(`failed alternate resolution returns original ${status} with normalized Kiro message`, async () => {
      const [, b] = await seed(); saveConfig(config());
      await saveAccountCredential("kiro", b!.id, { ...b!.credential, expires: Date.now() - 1_000 });
      let sends = 0;
      globalThis.fetch = (async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/refreshToken")) return new Response(JSON.stringify({ error: "future_unknown" }), { status: 400 });
        if (url.startsWith("https://runtime.") && url.endsWith(".kiro.dev/")) {
          sends++;
          return new Response(JSON.stringify({ reason }), { status });
        }
        return realFetch(input, init);
      }) as typeof fetch;
      const server = startServer(0);
      try {
        const response = await post(server);
        expect(response.status).toBe(status);
        expect(sends).toBe(1);
        const body = await response.text();
        expect(body).toContain("Kiro");
        expect(body).not.toContain('"reason"');
      } finally { await server.stop(true); }
    });
  }
});
