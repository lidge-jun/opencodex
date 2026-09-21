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
import { clearComboTargetCooldowns } from "../../src/combos/failover";
import { clearComboSelectionState } from "../../src/combos/resolve";
import {
  clearResponseStateForTests,
  clearResponseStateMemoryForTests,
} from "../../src/responses/state";
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
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
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
 * Selects the exact observable whose exclusion would regress if either request-prepare fence
 * dropped ownership: the denial-cache credential validator, not the pool-liveness probe.
 *
 * Pool selection used to ask whether native main is live on this path too -- once for the direct
 * preview and once when fallback re-entered it through the callback -- and those reads travelled
 * through `isMainAccountCredentialUsable` instead. #4850 closed them, so the unfiltered counter
 * is now assertable on its own and the test below this one does exactly that. This narrower
 * filter stays because it names one specific validator rather than a total, and a total cannot
 * say which fence failed. Every stack is kept for diagnostics either way.
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
  // Acquire on this case's installed home so direct dispatch can open the shared spend journal.
  const releaseSpendHome = acquireOwnedSpendHome();
  try {
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: requestHeaders,
      body: JSON.stringify({ model, input, stream: false }),
    }), config, logCtx, options);
    // handleResponses owns its translator budget through the returned body lifecycle. Draining the
    // body also lets completed Responses schedule their state write before afterEach cancels it.
    await response.arrayBuffer();
    return response;
  } finally {
    // Release before afterEach removes this home to prevent Windows removal failures.
    releaseSpendHome();
  }
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
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearResponseStateMemoryForTests();
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
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearResponseStateForTests();
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

  /**
   * #4850. Pool eligibility was the last part of request preview outside the fence: with no
   * `isMainAccountTokenLive` in the preview options, `codexAccountUnusableReason` fell through to
   * `isMainAccountCredentialUsable()` and opened the physical file, twice per spawn because
   * subagent fallback re-enters the preview through its callback.
   *
   * Asserted on the unfiltered counter on purpose. "The right credential was eventually sent"
   * was already true while the defect existed -- final authentication never selected physical
   * main here -- so only a read count can distinguish a closed fence from a lucky outcome. The
   * stacks are asserted rather than the number so a failure names the caller that reopened it.
   */
  test("caller-owned preview reads no physical main credential through pool eligibility", async () => {
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
    expect(authJsonReadStacks).toEqual([]);
    expect(authJsonReads).toBe(0);
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

  /**
   * A bare preferred native model can reach the request-prepare recovery re-preview only after
   * routing has already chosen a noncanonical provider, but bare native ids are reserved to the
   * canonical OpenAI provider. Combo recovery is the reachable response-driven boundary: the
   * canonical target rejects, recovery decrypts once, and only then may the routed target run.
   */
  test("response-triggered encrypted recovery replays plaintext without post-recovery main reads", async () => {
    calibrateMainReadCounter();
    const config = providerConfig({
      defaultProvider: "openai",
      agentTaskRecovery: { enabled: true },
      providers: {
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
        backup: {
          adapter: "openai-responses",
          baseUrl: "https://backup.example/v1",
          authMode: "key",
          apiKey: "backup-test-key",
        },
      },
      combos: {
        recovery: {
          strategy: "failover",
          targets: [
            { provider: "openai", model: PREFERRED_MODEL },
            { provider: "backup", model: "m2" },
          ],
        },
      },
    });
    let recoveryCalls = 0;
    const backupBodies: string[] = [];
    globalThis.fetch = (async (input, init) => {
      const body = typeof init?.body === "string" ? init.body : "";
      if (body.includes("capture_assignment")) {
        recoveryCalls += 1;
        // The canonical target has already failed. Reads after this response belong only to the
        // recovered routed replay, so the observation cannot be satisfied by pre-recovery work.
        resetMainReadObservations();
        return new Response(recoverySse("Use the recovered assignment."), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === "backup.example") {
        backupBodies.push(body);
        return completedResponses("m2");
      }
      // The canonical target is the only target allowed to receive unreadable ciphertext. Its
      // response forces the combo owner to recover the assignment before backup becomes eligible.
      return Response.json({ error: { message: "caller credential rejected" } }, { status: 401 });
    }) as typeof fetch;

    const response = await postSpawn(
      config,
      {},
      codexHeaders("caller-account"),
      encryptedInput(),
      "combo/recovery",
    );

    expect(response.status).toBe(200);
    expect(recoveryCalls).toBe(1);
    expect(backupBodies).toHaveLength(1);
    expect(backupBodies[0]).toContain("Use the recovered assignment.");
    expect(authJsonReads).toBe(0);
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

  // The two cases below are last on purpose. Both let a request reach native main, and observing
  // a main credential writes module state in `main-account-cache.ts` that no reset helper in this
  // file clears -- `beforeEach` rebuilds `OPENCODEX_HOME` and the read counters, not that cache.
  // Running them earlier made the recovery/drain case above see three reads it does not make on
  // its own. Keep read-count assertions ahead of them.

  /**
   * The other half of #4850, and the reason the seam is scoped to
   * `previewRequestScopedMainCredential` instead of being applied to every preview. A fix that
   * made main read-free for everyone would satisfy the zero-read assertion above and quietly
   * change ordinary routing: this request brought no credential of its own, so probing physical
   * main liveness is exactly what its preview is supposed to do.
   */
  test("a preview that owns no credential still probes physical main liveness", async () => {
    seedMainDenial();
    calibrateMainReadCounter();
    globalThis.fetch = (async () => completedResponses()) as typeof fetch;

    const response = await postSpawn(providerConfig(), {}, new Headers());

    expect(response.status).toBe(200);
    expect(authJsonReads).toBeGreaterThan(0);
  });

  /**
   * The synthetic liveness #4850 installs is final authentication's own value rather than a
   * constant, and this is the case that tells the two apart. Under an effective manual main pin
   * (#3166) the request really is served by its own main credential, so preview has to keep
   * scoring main eligible; a preview-only `false` would move it to the pool and diverge from the
   * resolution this preview exists to predict.
   *
   * The recorded failure is the discriminator. It belongs to `pool-a`, so a preview that scored
   * `pool-a` would see it and rewrite the model to the XAI fallback. Leaving the model alone is
   * only possible if preview scored main.
   *
   * No read assertion here. The pin path does reach the physical credential elsewhere in the
   * request, and pretending otherwise would assert something this change never claimed: the
   * guarantee under test is that preview and final authentication agree on the pin, which the
   * context and the untouched model together establish.
   */
  test("an effective main pin keeps a caller-owned request on main (#3166)", async () => {
    calibrateMainReadCounter();
    const config = providerConfig({
      activeCodexAccountId: MAIN_CODEX_ACCOUNT_ID,
      activeCodexAccountPinned: MAIN_CODEX_ACCOUNT_ID,
    });
    noteSubagentModelFailure(PREFERRED_MODEL, "429", config, "pool-a", NOW);
    const upstreamAuth: Array<string | null> = [];
    const upstreamBodies: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      upstreamAuth.push(new Headers(init?.headers).get("authorization"));
      upstreamBodies.push(typeof init?.body === "string" ? init.body : "");
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
    expect(finalAuth).toMatchObject({ kind: "main", accountId: null });
    expect(upstreamBodies[0]).toContain(`"model":"${PREFERRED_MODEL}"`);
    expect((logCtx as unknown as Record<string, unknown>).subagentModelFallbackTo).toBeUndefined();
    // The caller's own bearer is forwarded. Neither stored credential may appear.
    expect(upstreamAuth[0]).not.toBe("Bearer pool-access-token");
    expect(upstreamAuth[0]).not.toBe("Bearer physical-main-token");
  });
});
