import { afterEach, beforeEach, expect, test } from "bun:test";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearAccountNeedsReauth } from "../../src/codex/account-runtime-state";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import {
  CODEX_QUOTA_PROBE_INTERVAL_MS,
  canAcquireCodexQuotaProbeLease,
  clearCodexUpstreamHealth,
  clearThreadAccountMap,
  getCodexUpstreamHealth,
  recordCodexUpstreamOutcome,
} from "../../src/codex/routing";
import { saveConfig } from "../../src/config";
import { handleImages } from "../../src/server/images";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { createTempHome, type TempHome } from "../helpers/temp-home";

const ADMISSION_SECRET = "pool-admission-fixture";
const POOL_TOKEN = "pool-access-fixture";
const PROMPT = "private-image-fixture";
const originalFetch = globalThis.fetch;
const previousAdmissionSecret = process.env.OPENCODEX_API_AUTH_TOKEN;
let home: TempHome | undefined;
let sent: Array<{ url: string; headers: Headers }> = [];

beforeEach(() => {
  home = createTempHome("ocx-images-pool-admission-");
  process.env.OPENCODEX_API_AUTH_TOKEN = ADMISSION_SECRET;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  clearAccountNeedsReauth("pool-img");
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith("/images/generations")) throw new Error("unexpected fixture upstream");
    sent.push({ url, headers: new Headers(init?.headers) });
    return Response.json({ created: 1, data: [{ b64_json: "aGk=" }] });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (previousAdmissionSecret === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousAdmissionSecret;
  clearCodexUpstreamHealth();
  clearThreadAccountMap();
  clearAccountQuota();
  clearAccountNeedsReauth("pool-img");
  home?.remove();
  home = undefined;
});

function imageConfig(mode: "pool" | "direct" = "pool", options: {
  providerHeaders?: Record<string, string>;
  keyed?: boolean;
} = {}): OcxConfig {
  const openai: OcxProviderConfig = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward",
    codexAccountMode: mode,
    ...(options.providerHeaders ? { headers: options.providerHeaders } : {}),
  };
  return {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai,
      ...(options.keyed ? {
        "openai-apikey": {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "key",
          apiKey: "keyed-image-fixture",
        } satisfies OcxProviderConfig,
      } : {}),
    },
    codexAccounts: [{ id: "pool-img", email: "pool-img@example.test", plan: "team", isMain: false }],
    activeCodexAccountId: "pool-img",
    accountPoolStrategy: "fill-first",
  } as OcxConfig;
}

function savePool(config: OcxConfig, accessToken = POOL_TOKEN): void {
  saveConfig(config);
  saveCodexAccountCredential("pool-img", {
    accessToken,
    refreshToken: "pool-refresh-fixture",
    expiresAt: Date.now() + 3_600_000,
    chatgptAccountId: "acct-pool-fixture",
  });
  setAccountQuotaFromParsed("pool-img", { weeklyPercent: 10, weeklyResetAt: Date.now() / 1000 + 3_600 });
}

function request(): Request {
  return new Request("http://127.0.0.1/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ADMISSION_SECRET}` },
    body: JSON.stringify({ model: "gpt-image-2", prompt: PROMPT }),
  });
}

function logContext(): RequestLogContext {
  return { model: "image_gen", provider: "" };
}

function markRecoveryProbeDue(config: OcxConfig): number {
  const old = Date.now() - CODEX_QUOTA_PROBE_INTERVAL_MS - 1_000;
  recordCodexUpstreamOutcome(config, "pool-img", 429, {
    now: old,
    resetAt: Date.now() + 60 * 60_000,
  });
  expect(getCodexUpstreamHealth("pool-img")?.cooldownUntil).toBeGreaterThan(Date.now());
  expect(canAcquireCodexQuotaProbeLease("pool-img")).toBe(true);
  return old;
}

async function callImages(config: OcxConfig): Promise<Response> {
  return handleImages(request(), config, "generations", logContext());
}

test("proxy admission bearer uses managed Pool Images credentials", async () => {
  const config = imageConfig();
  savePool(config);
  const response = await callImages(config);
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe("https://chatgpt.com/backend-api/codex/images/generations");
  expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${POOL_TOKEN}`);
  expect(sent[0]!.headers.get("chatgpt-account-id")).toBe("acct-pool-fixture");
  expect([...sent[0]!.headers.values()].some(value => value.includes(ADMISSION_SECRET))).toBe(false);
});

test("Pool authentication failure does not fall back to a billed keyed Images provider", async () => {
  const config = imageConfig("pool", { keyed: true });
  saveConfig(config);
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  let response: Response;
  try {
    response = await callImages(config);
  } finally {
    console.error = originalError;
  }
  expect(response.status).toBe(401);
  expect(sent).toHaveLength(0);
  expect(logs).toEqual(["[images] Pool credential failed; reauthentication required"]);
});

test("proxy admission bearer remains ineligible for Direct forwarding", async () => {
  const config = imageConfig("direct", { keyed: true });
  saveConfig(config);
  const response = await callImages(config);
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe("https://api.openai.com/v1/images/generations");
  expect(sent[0]!.headers.get("authorization")).toBe("Bearer keyed-image-fixture");
  expect([...sent[0]!.headers.values()].some(value => value.includes(ADMISSION_SECRET))).toBe(false);
});

test("selected Pool bearer owns Authorization despite a differently cased configured header", async () => {
  const config = imageConfig("pool", { providerHeaders: { Authorization: "Bearer configured-fixture" } });
  savePool(config);
  const response = await callImages(config);
  expect(response.status).toBe(200);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${POOL_TOKEN}`);
  expect([...sent[0]!.headers.values()].some(value => value.includes("configured-fixture"))).toBe(false);
});

async function expectPreFetchCredentialRefusal(config: OcxConfig, old: number, privateValue: string): Promise<void> {
  const logs: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  let response: Response;
  try {
    response = await callImages(config);
  } finally {
    console.error = originalError;
  }
  expect(response.status).toBe(500);
  const body = await response.text();
  expect(body).toContain("image generation request failed forward credential validation");
  expect(body).not.toContain(privateValue);
  expect(body).not.toContain(ADMISSION_SECRET);
  expect(body).not.toContain(PROMPT);
  expect(sent).toHaveLength(0);
  expect(getCodexUpstreamHealth("pool-img")?.probeLeaseId).toBeUndefined();
  expect(getCodexUpstreamHealth("pool-img")?.lastProbeAt).toBeGreaterThan(old);
  expect(logs.join(" ")).not.toContain(privateValue);
  expect(logs.join(" ")).not.toContain(ADMISSION_SECRET);
  expect(logs.join(" ")).not.toContain(PROMPT);
}

test("invalid selected Pool bearer is refused before send and releases its probe lease", async () => {
  const config = imageConfig();
  const invalidToken = "bad,credential-fixture";
  savePool(config, invalidToken);
  const old = markRecoveryProbeDue(config);
  await expectPreFetchCredentialRefusal(config, old, invalidToken);
});

test("a selected Pool token matching proxy admission never reaches the upstream", async () => {
  const config = imageConfig();
  savePool(config, ADMISSION_SECRET);
  const old = markRecoveryProbeDue(config);
  await expectPreFetchCredentialRefusal(config, old, ADMISSION_SECRET);
});

test("invalid Pool credential materialization is refused without a send or private log", async () => {
  const config = imageConfig();
  const invalidToken = "bad\ncredential-fixture";
  savePool(config, invalidToken);
  const old = markRecoveryProbeDue(config);
  await expectPreFetchCredentialRefusal(config, old, invalidToken);
});

test("invalid configured header assembly is refused before an Images send", async () => {
  const invalidValue = "private\nheader-fixture";
  const config = imageConfig("pool", { providerHeaders: { "x-image-fixture": invalidValue } });
  savePool(config);
  const old = markRecoveryProbeDue(config);
  await expectPreFetchCredentialRefusal(config, old, invalidValue);
});
