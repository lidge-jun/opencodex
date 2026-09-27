import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { clearGenericFailoverHealth } from "../../src/oauth/generic-account-failover";
import { getAccountSet, saveCredential, setActiveAccount } from "../../src/oauth/store";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import * as retry from "../../src/lib/upstream-retry";
import { createRequestExecutionBudget, type RequestExecutionBudgetPolicy } from "../../src/lib/request-execution-budget";

const DAILY_API_BASE = "https://daily-cloudcode-pa.googleapis.com";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let originalFetch: typeof fetch;
let releaseSpendHome: (() => void) | undefined;
let sleepSpy: ReturnType<typeof spyOn> | undefined;

const takeSpendHome = (): void => {
  releaseSpendHome ??= acquireOwnedSpendHome();
};

beforeEach(() => {
  originalFetch = globalThis.fetch;
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-google-429-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-google-429-"));
  process.env.OPENCODEX_HOME = testDir;
  takeSpendHome();
  clearGenericFailoverHealth();
  sleepSpy = spyOn(retry, "sleepWithAbort").mockImplementation(async () => {});
});

afterEach(() => {
  sleepSpy?.mockRestore();
  sleepSpy = undefined;
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearGenericFailoverHealth();
  globalThis.fetch = originalFetch;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) removeTreeWithRetry(testDir);
});

function antigravityConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "127.0.0.1",
    defaultProvider: "google-antigravity",
    providers: {
      "google-antigravity": {
        adapter: "google",
        baseUrl: DAILY_API_BASE,
        authMode: "oauth",
        googleMode: "cloud-code-assist",
        project: "initial-project-id",
        models: ["gemini-3.8-flash"],
      },
    },
  } as OcxConfig;
}

function jsonSuccessBody(text: string): Record<string, unknown> {
  return {
    response: {
      candidates: [{
        content: {
          role: "model",
          parts: [{ text }],
        },
        finishReason: "STOP",
      }],
      usageMetadata: {
        promptTokenCount: 5,
        candidatesTokenCount: 3,
        totalTokenCount: 8,
      },
    },
  };
}

function transient429ErrorBody(): Record<string, unknown> {
  return {
    error: {
      code: 429,
      message: "Resource has been exhausted: rate limit exceeded.",
      status: "RESOURCE_EXHAUSTED",
    },
  };
}

function hardQuota429ErrorBody(): Record<string, unknown> {
  return {
    error: {
      code: 429,
      message: "Quota exceeded for quota metric ...",
      status: "RESOURCE_EXHAUSTED",
    },
  };
}

function createResponsesRequest(bodyOverrides: Record<string, unknown> = {}): Request {
  return new Request("http://127.0.0.1/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "google-antigravity/gemini-3.8-flash",
      input: "hello",
      stream: false,
      ...bodyOverrides,
    }),
  });
}

async function seedAntigravityAccounts(count: number): Promise<Array<{ id: string; auth: string; project: string }>> {
  for (let i = 1; i <= count; i++) {
    await saveCredential("google-antigravity", {
      access: `token-${i}`,
      refresh: `refresh-${i}`,
      expires: Date.now() + 3_600_000,
      accountId: `account-${i}`,
      projectId: `project-${i}`,
    });
  }
  const accounts = getAccountSet("google-antigravity")!.accounts;
  await setActiveAccount("google-antigravity", accounts[0]!.id);
  return accounts.map((a, idx) => ({
    id: a.id,
    auth: `Bearer token-${idx + 1}`,
    project: `project-${idx + 1}`,
  }));
}

function installAntigravityFetchMock(
  handler: (info: { auth: string; project: string; sendIndex: number }) => Response | Promise<Response>,
): void {
  let sendIndex = 0;
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const parsedUrl = new URL(url);

    if (parsedUrl.origin === DAILY_API_BASE
      && ["/v1internal:streamGenerateContent", "/v1internal:generateContent"].includes(parsedUrl.pathname)) {
      sendIndex += 1;
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      let project = "";
      if (typeof init?.body === "string") {
        try {
          const parsed = JSON.parse(init.body) as { project?: string };
          project = parsed.project ?? "";
        } catch { /* ignore */ }
      }
      return handler({ auth, project, sendIndex });
    }

    if (parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost") return originalFetch(input, init);
    throw new Error(`Unexpected external request: ${url}`);
  }) as typeof fetch;
}

describe("Google Antigravity OAuth 429 retry and multi-account budget (#5880)", () => {
  test.each([4, 5])("%i accounts each receive three transient sends before terminal 429", async accountCount => {
    const accounts = await seedAntigravityAccounts(accountCount);
    const cfg = antigravityConfig();
    saveConfig(cfg);

    const observedSends: Array<{ auth: string; project: string }> = [];
    installAntigravityFetchMock(({ auth, project }) => {
      observedSends.push({ auth, project });
      return new Response(JSON.stringify(transient429ErrorBody()), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await handleResponses(
      createResponsesRequest(),
      cfg,
      { model: "gemini-3.8-flash", provider: "google-antigravity" },
    );

    expect(res.status).toBe(429);

    expect(await res.text()).toContain("rate_limit_exceeded");
    // Four accounts pin 3,3,3,3; five also proves the snapshot can exceed the old hop cap.
    expect(observedSends).toHaveLength(accountCount * 3);

    for (let acctIdx = 0; acctIdx < accountCount; acctIdx++) {
      const sendsForAccount = observedSends.slice(acctIdx * 3, (acctIdx + 1) * 3);
      expect(sendsForAccount).toHaveLength(3);
      for (const send of sendsForAccount) {
        expect(send).toEqual({ auth: accounts[acctIdx]!.auth, project: accounts[acctIdx]!.project });
      }
    }
  });

  test("a roster larger than the per-request account cap funds only the cap", async () => {
    // Eight enrolled accounts must not turn one request into 24 sends: the default ingress
    // ceiling is GENERIC_OAUTH_MAX_ACCOUNTS_PER_REQUEST (6) accounts x 3 transient sends.
    const accounts = await seedAntigravityAccounts(8);
    const cfg = antigravityConfig();
    saveConfig(cfg);

    const observedSends: Array<{ auth: string; project: string }> = [];
    installAntigravityFetchMock(({ auth, project }) => {
      observedSends.push({ auth, project });
      return new Response(JSON.stringify(transient429ErrorBody()), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await handleResponses(
      createResponsesRequest(),
      cfg,
      { model: "gemini-3.8-flash", provider: "google-antigravity" },
    );

    expect(res.status).toBe(429);
    expect(observedSends).toHaveLength(18);
    const usedAuth = new Set(observedSends.map(send => send.auth));
    expect(usedAuth.size).toBe(6);
    for (const account of accounts.slice(6)) expect(usedAuth.has(account.auth)).toBe(false);
  });

  test.each([2, 3])("single account succeeds attempt %i on transient 429", async successAttempt => {
    const accounts = await seedAntigravityAccounts(1);
    const cfg = antigravityConfig();
    saveConfig(cfg);

    const observedSends: Array<{ auth: string; project: string }> = [];
    installAntigravityFetchMock(({ auth, project, sendIndex }) => {
      observedSends.push({ auth, project });
      if (sendIndex < successAttempt) {
        return new Response(JSON.stringify(transient429ErrorBody()), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify(jsonSuccessBody(`success on attempt ${successAttempt}`)), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await handleResponses(
      createResponsesRequest(),
      cfg,
      { model: "gemini-3.8-flash", provider: "google-antigravity" },
    );

    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(JSON.stringify(body)).toContain(`success on attempt ${successAttempt}`);
    expect(observedSends).toHaveLength(successAttempt);
    for (const send of observedSends) {
      expect(send).toEqual({ auth: accounts[0]!.auth, project: accounts[0]!.project });
    }
  });

  test.each([1, 4])("hard quota with %i accounts does not waste transient retries", async accountCount => {
    const accounts = await seedAntigravityAccounts(accountCount);
    const cfg = antigravityConfig();
    saveConfig(cfg);

    const observedSends: Array<{ auth: string; project: string }> = [];
    installAntigravityFetchMock(({ auth, project }) => {
      observedSends.push({ auth, project });
      return new Response(JSON.stringify(hardQuota429ErrorBody()), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });

    const res = await handleResponses(
      createResponsesRequest(),
      cfg,
      { model: "gemini-3.8-flash", provider: "google-antigravity" },
    );

    expect(res.status).toBe(429);
    // Hard quota must return immediately without burning transient retry attempts
    expect(observedSends).toEqual(accounts.map(({ auth, project }) => ({ auth, project })));
    await res.text();
  });

  test.each([2, 4, 7])("explicit %i-send caller ceiling remains unchanged", async ceiling => {
    await seedAntigravityAccounts(4);
    const cfg = antigravityConfig();
    saveConfig(cfg);

    const observedSends: Array<{ auth: string; project: string }> = [];
    installAntigravityFetchMock(({ auth, project }) => {
      observedSends.push({ auth, project });
      return new Response(JSON.stringify(transient429ErrorBody()), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    });

    const customPolicy: RequestExecutionBudgetPolicy = {
      maxTotalModelSends: ceiling,
      baseSendAllowance: ceiling,
      finalRecoveryAllowance: 0,
      maxAlternateTargetSends: 0,
      maxTargetTransitions: 0,
    };
    const customBudget = createRequestExecutionBudget(customPolicy);

    const res = await handleResponses(
      createResponsesRequest(),
      cfg,
      { model: "gemini-3.8-flash", provider: "google-antigravity" },
      { sendBudget: customBudget },
    );

    expect(res.status).toBe(429);
    expect(observedSends).toHaveLength(ceiling);
    expect(customBudget.used).toBe(ceiling);
    expect(customBudget.policy).toBe(customPolicy);
    expect(customBudget.targetTransitions).toBe(0);
    await res.text();
  });
});
