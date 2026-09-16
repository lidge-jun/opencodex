import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import {
  resolveCodexAuthContext,
  type CodexAuthContext,
} from "../../src/codex/auth-context";
import { getMainAccountToken, MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import {
  resetCodexModelEntitlementCacheForTests,
  seedCodexModelEntitlementsForTests,
} from "../../src/codex/model-entitlements";
import {
  blockNativeMainRecovery,
  completeNativeMainRecovery,
  nativeMainStartupGateSnapshot,
} from "../../src/codex/native-profile-startup";
import { clearAccountQuota } from "../../src/codex/quota";
import { clearCodexUpstreamHealth, clearThreadAccountMap } from "../../src/codex/routing";
import {
  noteSubagentModelFailure,
  resetSubagentModelFallbackStateForTests,
} from "../../src/codex/subagent-model-fallback";
import { handleResponses } from "../../src/server/responses";
import { resetAgentTaskRecoveryState } from "../../src/server/responses/agent-task-recovery";
import type { ActiveTurnLease } from "../../src/server/lifecycle";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig } from "../../src/types";
import {
  codexHeaders,
  encryptedInput,
  recoverySse,
} from "../helpers/agent-task-recovery";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Request preview predicts final authentication, so both decisions must fence the physical native
 * main credential on the same three facts: caller ownership, retained recovery, and a draining
 * selector. The historical ownership omission was especially dangerous: a `thread_spawn` with a
 * forwardable caller bearer let preview open `auth.json` while final authentication correctly
 * treated that file as belonging to a different credential domain.
 *
 * The denial cache is the behavioral oracle here. A cached native-main denial validates the
 * physical token before it can influence account scoring; excluding main skips that validation
 * before the file is opened. The fence cases therefore reach the real preview/final path and
 * observe `auth.json` reads rather than the spelling of the fence expression.
 */

const NOW = 1_800_000_000_000;
const PREFERRED_MODEL = "gpt-5.6-sol";
const FALLBACK_MODEL = "xai/grok-4.5";
const originalFetch = globalThis.fetch;
const originalNow = Date.now;

let testDir = "";
let previousOpenCodexHome: string | undefined;
let previousCodexHome: string | undefined;
let authJsonReads = 0;
let authJsonReadStacks: string[] = [];
let readSpy: ReturnType<typeof spyOn> | undefined;
let blockedHomeId: string | null = null;

function providerConfig(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    activeCodexAccountId: "pool-a",
    autoSwitchThreshold: 0,
    subagentModelFallback: [FALLBACK_MODEL],
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        authMode: "forward",
        codexAccountMode: "pool",
      },
      xai: {
        adapter: "openai-chat",
        baseUrl: "https://api.x.ai/v1",
        authMode: "key",
        apiKey: "xai-test",
      },
    },
    codexAccounts: [
      { id: MAIN_CODEX_ACCOUNT_ID, email: "main@example.test", isMain: true },
      { id: "pool-a", email: "pool@example.test", isMain: false, chatgptAccountId: "pool-account" },
    ],
    ...overrides,
  } as OcxConfig;
}

function installCredentials(): void {
  writeFileSync(join(testDir, "auth.json"), JSON.stringify({
    tokens: {
      access_token: "physical-main-token",
      refresh_token: "physical-main-refresh",
      account_id: "physical-main-account",
    },
  }));
  saveCodexAccountCredential("pool-a", {
    accessToken: "pool-access-token",
    refreshToken: "pool-refresh-token",
    expiresAt: NOW + 24 * 60 * 60_000,
    chatgptAccountId: "pool-account",
  });
}

function seedMainDenial(): void {
  seedCodexModelEntitlementsForTests(
    MAIN_CODEX_ACCOUNT_ID,
    [],
    NOW,
    "0.146.0",
    "main:physical-main-account",
  );
}

function calibrateMainReadCounter(): void {
  expect(getMainAccountToken()).toEqual({
    accessToken: "physical-main-token",
    chatgptAccountId: "physical-main-account",
  });
  expect(authJsonReads).toBeGreaterThan(0);
  resetMainReadObservations();
}

function resetMainReadObservations(): void {
  authJsonReads = 0;
  authJsonReadStacks = [];
}

/**
 * The request also asks ordinary pool selection whether native main is live: once for the direct
 * preview and once when fallback invokes the preview callback. Those reads travel through
 * `isMainAccountCredentialUsable`, not the denial-cache credential validator this conversion
 * protects. Keep every stack for diagnostics, then select the exact observable whose exclusion
 * would regress if either request-prepare fence dropped ownership.
 */
function denialCacheMainReadStacks(): string[] {
  return authJsonReadStacks.filter(stack =>
    stack.replaceAll("\\", "/").includes("/src/codex/model-entitlements.ts"));
}

function completedResponses(model = PREFERRED_MODEL): Response {
  return Response.json({
    id: "resp_main_read_fence",
    object: "response",
    status: "completed",
    model,
    output: [],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  });
}

function readableInput(): unknown[] {
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "keep the main credential fenced" }],
  }];
}

async function postSpawn(
  config: OcxConfig,
  options: Parameters<typeof handleResponses>[3] = {},
  headers: HeadersInit = codexHeaders("caller-account"),
  input: unknown[] = readableInput(),
  model = PREFERRED_MODEL,
  logCtx: RequestLogContext = { model: "", provider: "" },
): Promise<Response> {
  const requestHeaders = new Headers(headers);
  requestHeaders.set("content-type", "application/json");
  requestHeaders.set("x-openai-subagent", "collab_spawn");
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({ model, input, stream: false }),
  }), config, logCtx, options);
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "ocx-preview-main-fence-"));
  previousOpenCodexHome = process.env.OPENCODEX_HOME;
  previousCodexHome = process.env.CODEX_HOME;
  process.env.OPENCODEX_HOME = testDir;
  process.env.CODEX_HOME = testDir;
  Date.now = () => NOW;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  resetSubagentModelFallbackStateForTests();
  resetCodexModelEntitlementCacheForTests();
  resetAgentTaskRecoveryState();
  installCredentials();

  const originalReadFileSync = fs.readFileSync as (...args: unknown[]) => unknown;
  readSpy = spyOn(fs, "readFileSync");
  readSpy.mockImplementation(((...args: unknown[]) => {
    const target = args[0];
    if (typeof target === "string" && target.endsWith("auth.json")) {
      authJsonReads += 1;
      authJsonReadStacks.push(new Error("auth.json read").stack ?? "stack unavailable");
    }
    return originalReadFileSync(...args);
  }) as unknown as typeof fs.readFileSync);
  resetMainReadObservations();
  blockedHomeId = null;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  readSpy?.mockRestore();
  readSpy = undefined;
  if (blockedHomeId !== null) completeNativeMainRecovery(blockedHomeId);
  blockedHomeId = null;
  clearThreadAccountMap();
  clearCodexUpstreamHealth();
  clearAccountQuota();
  resetSubagentModelFallbackStateForTests();
  resetCodexModelEntitlementCacheForTests();
  resetAgentTaskRecoveryState();
  if (previousOpenCodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpenCodexHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  removeTreeWithRetry(testDir);
  testDir = "";
  resetMainReadObservations();
});

describe("preview and final authentication agree on the native-main read fence", () => {
  test("final authentication validates request ownership against the bearer before fencing main", async () => {
    seedMainDenial();
    calibrateMainReadCounter();
    const config = providerConfig();

    const owned = await resolveCodexAuthContext(codexHeaders("caller-account"), config, "pool", {
      requestScopedMainCredential: true,
      modelId: PREFERRED_MODEL,
    });
    expect(owned).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(authJsonReads).toBe(0);

    // The option is only a claim by the caller. Without the bearer final auth must reject that
    // claim, leave the ownership fence open, and perform the ordinary physical-main reads.
    await resolveCodexAuthContext(new Headers(), config, "pool", {
      requestScopedMainCredential: true,
      modelId: PREFERRED_MODEL,
    });
    expect(authJsonReads).toBeGreaterThan(0);
  });

  test("the initial preview excludes physical main from denial-cache credential validation", async () => {
    seedMainDenial();
    calibrateMainReadCounter();
    const upstreamAuth: Array<string | null> = [];
    globalThis.fetch = (async (_input, init) => {
      upstreamAuth.push(new Headers(init?.headers).get("authorization"));
      return completedResponses();
    }) as typeof fetch;

    const response = await postSpawn(providerConfig());

    expect(response.status).toBe(200);
    expect(upstreamAuth).toEqual(["Bearer pool-access-token"]);
    expect(denialCacheMainReadStacks()).toEqual([]);
  });

  test("the initial preview also fences main for recovery blocking and selector drain", async () => {
    seedMainDenial();
    calibrateMainReadCounter();
    globalThis.fetch = (async () => completedResponses()) as typeof fetch;

    const snapshot = nativeMainStartupGateSnapshot();
    blockedHomeId = snapshot.homeId ?? testDir;
    expect(blockNativeMainRecovery(blockedHomeId)).toBe(true);
    const blockedResponse = await postSpawn(providerConfig(), {}, new Headers());
    expect(blockedResponse.status).toBe(200);
    expect(authJsonReads).toBe(0);
    expect(completeNativeMainRecovery(blockedHomeId)).toBe(true);
    blockedHomeId = null;

    let selectionStarts = 0;
    const turnAdmissionLease = {
      release() {},
      beginCodexAccountSelection() {
        selectionStarts += 1;
        return {
          mainProfileDraining: true,
          claimMainProfile: () => false,
          release() {},
        };
      },
    } satisfies Pick<ActiveTurnLease, "release" | "beginCodexAccountSelection">;
    resetMainReadObservations();
    await postSpawn(providerConfig(), { turnAdmissionLease }, new Headers());
    expect(selectionStarts).toBeGreaterThan(0);
    expect(authJsonReads).toBe(0);
  });

  test("the encrypted-recovery re-preview excludes main from denial-cache credential validation", async () => {
    seedMainDenial();
    calibrateMainReadCounter();
    const config = providerConfig({
      defaultProvider: "openai",
      agentTaskRecovery: { enabled: true },
      subagentModelFallback: ["gpt-5.6-terra"],
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
    });
    let recoveryCalls = 0;
    let dispatchCalls = 0;
    globalThis.fetch = (async (_input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        recoveryCalls += 1;
        // Everything before this response is the initial preview or recovery transport. Reads
        // after this point belong to the recovery re-preview and final authentication.
        resetMainReadObservations();
        return new Response(recoverySse("Use the recovered assignment."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      dispatchCalls += 1;
      return completedResponses();
    }) as typeof fetch;

    const response = await postSpawn(
      config,
      {},
      codexHeaders("caller-account"),
      encryptedInput(),
      PREFERRED_MODEL,
    );

    expect(response.status).toBe(200);
    expect(recoveryCalls).toBe(1);
    expect(dispatchCalls).toBe(1);
    expect(denialCacheMainReadStacks()).toEqual([]);
  });

  test("ownership alone leaves selection-only off in preview and final authentication", async () => {
    seedMainDenial();
    calibrateMainReadCounter();
    // Make the two selection modes observably different. Ordinary selection finds physical main
    // unreadable and uses pool-a; selection-only would retain main as a synthetic candidate
    // without opening the missing file.
    unlinkSync(join(testDir, "auth.json"));
    const config = providerConfig({ activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID });
    // If preview incorrectly treated ownership as selection-only, it would score the request as
    // native main, observe this account-scoped failure, and route to the XAI fallback.
    noteSubagentModelFailure(PREFERRED_MODEL, "429", config, MAIN_CODEX_ACCOUNT_ID, NOW);
    const upstreamUrls: string[] = [];
    const upstreamBodies: string[] = [];
    const upstreamAuth: Array<string | null> = [];
    globalThis.fetch = (async (input, init) => {
      upstreamUrls.push(String(input));
      upstreamBodies.push(typeof init?.body === "string" ? init.body : "");
      upstreamAuth.push(new Headers(init?.headers).get("authorization"));
      return completedResponses();
    }) as typeof fetch;
    let finalAuth: CodexAuthContext | undefined;
    const logCtx: RequestLogContext = { model: "", provider: "" };

    const response = await postSpawn(
      config,
      { onCodexAuthContextResolved: context => { finalAuth = context; } },
      codexHeaders("caller-account"),
      readableInput(),
      PREFERRED_MODEL,
      logCtx,
    );

    expect(response.status).toBe(200);
    expect(finalAuth).toMatchObject({ kind: "pool", accountId: "pool-a" });
    expect(upstreamUrls).toHaveLength(1);
    expect(upstreamUrls[0]).toContain("chatgpt.com/backend-api/codex");
    expect(upstreamBodies[0]).toContain(`"model":"${PREFERRED_MODEL}"`);
    expect(upstreamAuth).toEqual(["Bearer pool-access-token"]);
    expect((logCtx as unknown as Record<string, unknown>).subagentModelFallbackTo).toBeUndefined();
  });
});
