import { spyOn } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Fixture {
  scenario: "owned-99" | "owned-98" | "foreign" | "unknown" | "recovery" | "second-listener"
    | "invalid-access-token" | "invalid-account-id" | "invalid-id-token" | "mismatched-identity" | "renewed-listener"
    | "stage-retry" | "manual-recovery" | "stale-sweep" | "retained-unknown-binding";
  accountId: string;
  bearer: string;
  originalAccountId: string;
  originalBearer: string;
}

const fixture: Fixture = JSON.parse(readFileSync(process.env.OCX_POLICY_STARTUP_FIXTURE!, "utf8"));
let upstreamCalls = 0;
const unexpectedNetwork: string[] = [];
// Install before product imports. Every response is synthetic; no endpoint can escape the fixture.
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const request = input instanceof Request ? input : new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname === "chatgpt.com" && url.pathname.endsWith("/responses")) {
    upstreamCalls++;
    return Response.json({
      id: "resp_policy_startup", object: "response", status: "completed", created_at: 1,
      model: "gpt-5.6-sol", output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
    });
  }
  unexpectedNetwork.push(`${url.hostname}${url.pathname}`);
  throw new Error("Unexpected network request in startup policy fixture");
}, { preconnect() {} }) as typeof fetch;

const { setIcaclsRunnerForTests } = await import("../../src/lib/windows-secret-acl");
setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
const authCollision = await import("../../src/codex/auth-collision");
const readTokens = authCollision.readCodexTokensResult;
const tokenReads: Array<string | undefined> = [];
const tokenSpy = spyOn(authCollision, "readCodexTokensResult").mockImplementation(authPath => {
  tokenReads.push(authPath);
  return readTokens(authPath);
});
const { NativeProfileManager } = await import("../../src/codex/native-profile-manager");
const { matchesMainQuotaCredential } = await import("../../src/codex/main-account-cache");
const { getMainPolicyQuota } = await import("../../src/codex/quota");
const { resolveCodexAuthContext } = await import("../../src/codex/auth-context");
const { saveCodexAccountCredential } = await import("../../src/codex/account-store");
const { blockNativeMainRecovery, completeNativeMainRecovery, nativeMainStartupGateSnapshot, waitForNativeMainStartupGate } = await import("../../src/codex/native-profile-startup");
const { handleNativeProfileAPI } = await import("../../src/codex/native-profile-api");
const { startServer } = await import("../../src/server");
const { handleResponses } = await import("../../src/server/responses/core");
const { loadConfig, saveConfig } = await import("../../src/config");

let config = loadConfig();
const observe = () => ({
  matched: matchesMainQuotaCredential(fixture.bearer, fixture.accountId),
  policy: getMainPolicyQuota(),
  tokenReads: tokenReads.length,
  gate: nativeMainStartupGateSnapshot(),
});
const before = observe();
function barrier() {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return { entered, release: () => release(), async wait() { enter(); await released; } };
}
async function waitForReady() {
  const deadline = Date.now() + 15_000;
  while (nativeMainStartupGateSnapshot().status !== "ready") {
    if (Date.now() >= deadline) throw new Error("startup policy fixture did not become ready");
    await Bun.sleep(1);
  }
}
const manager = new NativeProfileManager({
  codexHome: process.env.CODEX_HOME!, configDir: process.env.OPENCODEX_HOME!,
  keyProvider: {
    async get() { return { keyRef: "memory:policy-startup", key: Buffer.alloc(32, 7) }; },
    async create() { return { keyRef: "memory:policy-startup", key: Buffer.alloc(32, 7) }; },
  },
  hardenPath: async () => {}, processProbe: async () => ({ status: "clear", count: 0 }),
});
let recovered = false;
let recoveryCalls = 0;
let sweepCalls = 0;
const oldSweep = barrier();
const bindingSweep = barrier();
const writeRecoveredAuth = () => writeFileSync(manager.context.authPath, JSON.stringify({ tokens: {
  access_token: fixture.bearer, refresh_token: "fixture-refresh", account_id: fixture.accountId,
} }));
let enterRecovery!: () => void;
let releaseRecovery!: () => void;
const recoveryEntered = new Promise<void>(resolve => { enterRecovery = resolve; });
const recoveryRelease = new Promise<void>(resolve => { releaseRecovery = resolve; });
if (fixture.scenario === "recovery" || fixture.scenario === "manual-recovery") {
  // The existing recovery seam changes the physical credential only when the held recovery runs.
  manager.recover = async () => {
    recoveryCalls++;
    writeRecoveredAuth();
    recovered = true;
    return { status: "none" } as Awaited<ReturnType<NativeProfileManager["recover"]>>;
  };
  saveCodexAccountCredential("startup-pool", {
    accessToken: "fixture-pool-access", refreshToken: "fixture-pool-refresh",
    expiresAt: Date.now() + 86_400_000, chatgptAccountId: "fixture-pool-account",
  });
}
if (["stage-retry", "manual-recovery", "stale-sweep"].includes(fixture.scenario)) {
  manager.stageSweepRequired = () => true;
  manager.sweepStages = async () => {
    const call = ++sweepCalls;
    let plaintextMayRemain = false;
    if (fixture.scenario === "stage-retry") {
      if (call === 1) plaintextMayRemain = true;
      if (call === 2) await oldSweep.wait();
    } else if (fixture.scenario === "manual-recovery") {
      if (call === 1) await bindingSweep.wait();
    } else {
      if (call === 2) { await oldSweep.wait(); plaintextMayRemain = true; }
      if (call === 3) await bindingSweep.wait();
    }
    return { plaintextMayRemain } as Awaited<ReturnType<NativeProfileManager["sweepStages"]>>;
  };
}

const listeners: Array<ReturnType<typeof observe>> = [];
const realServe = Bun.serve;
Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
  listeners.push(observe());
  return realServe(options);
}) as typeof Bun.serve;
const ownership = fixture.scenario === "foreign" || fixture.scenario === "unknown" ? fixture.scenario : "owned";
const start = () => startServer(0, {
  inspectNativeCodexOwnership: () => ({ ownership, reason: "synthetic policy-startup fixture" }),
  nativeMainStartup: {
    manager,
    ...(["stage-retry", "stale-sweep"].includes(fixture.scenario) ? { stageSweepIntervalMs: 10 } : {}),
    ...(fixture.scenario === "manual-recovery" ? {
      probeRecoveryState: () => recovered ? "none" as const : "manual" as const,
    } : {}),
    ...(fixture.scenario === "recovery" ? {
      probeRecoveryState: () => recovered ? "none" as const : "journal" as const,
      beforeRecovery: async () => { enterRecovery(); await recoveryRelease; },
    } : {}),
  },
});
const servers: Array<ReturnType<typeof start>> = [];
const headers = (token = fixture.bearer, id = fixture.accountId) =>
  new Headers({ authorization: `Bearer ${token}`, "chatgpt-account-id": id });
const admit = async (
  mode: "direct" | "pool" = "direct",
  options: Parameters<typeof resolveCodexAuthContext>[3] = {},
  policy = config,
) => {
  try { const context = await resolveCodexAuthContext(headers(), policy, mode, options); return { admitted: true, kind: context.kind }; }
  catch (error) { return { admitted: false, error: (error as Error).name }; }
};
const wire = async (token = fixture.bearer, id = fixture.accountId) => {
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { ...Object.fromEntries(headers(token, id)), "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "synthetic startup probe", stream: false }),
  }), config, { model: "", provider: "" });
  const text = await response.text();
  return { status: response.status, hardLockError: text.includes("codexMainAccountHardLock") };
};

try {
  servers.push(start());
  let firstServerSettled: ReturnType<typeof observe> | undefined;
  if (fixture.scenario === "second-listener" || fixture.scenario === "renewed-listener") {
    await waitForNativeMainStartupGate();
    firstServerSettled = observe();
    if (fixture.scenario === "renewed-listener") {
      writeFileSync(manager.context.authPath, JSON.stringify({ tokens: {
        access_token: fixture.bearer, refresh_token: "fixture-refresh", account_id: fixture.accountId,
      } }));
    }
    config = { ...config, codexMainAccountHardLock: true };
    saveConfig(config);
    servers.push(start());
  }
  const firstAdmission = await admit();
  let heldRecovery: Record<string, unknown> | undefined;
  let laterRecovery: Record<string, unknown> | undefined;
  let retainedUnknown: Array<Record<string, unknown>> | undefined;
  let validReplacement: Record<string, unknown> | undefined;
  const otherAccountId = "hard-lock-verified-other";
  const otherBearer = `header.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 86_400,
    "https://api.openai.com/auth": { chatgpt_account_id: otherAccountId } })).toString("base64url")}.signature`;
  if (fixture.scenario === "recovery") {
    await recoveryEntered;
    heldRecovery = {
      observation: observe(),
      poolFallback: await admit("pool", { requestScopedMainCredential: true }),
      mainPin: await admit("pool", { requestScopedMainCredential: true }, { ...config, activeCodexAccountPinned: "__main__" }),
      storedAlternative: await admit("pool", { accountId: "startup-pool" }, {
        ...config, codexAccounts: [{ id: "startup-pool", email: "pool@example.test", isMain: false }],
      }),
      automaticAlternative: await admit("pool", { requestScopedMainCredential: true }, {
        ...config, codexAccounts: [{ id: "startup-pool", email: "pool@example.test", isMain: false }],
      }),
    };
    releaseRecovery();
  }
  if (fixture.scenario === "stage-retry") {
    await waitForNativeMainStartupGate();
    laterRecovery = { blocked: observe() };
    await oldSweep.entered;
    oldSweep.release();
    await waitForReady();
    laterRecovery.sweepCalls = sweepCalls;
  }
  if (fixture.scenario === "manual-recovery") {
    await waitForNativeMainStartupGate();
    laterRecovery = { blocked: observe() };
    const request = new Request("http://localhost/api/native-main-profiles/recover", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    const response = await handleNativeProfileAPI(request, new URL(request.url), config, {
      manager, probeRecoveryState: () => recovered ? "none" : "manual",
    });
    laterRecovery.apiStatus = response?.status;
    await response?.text();
    laterRecovery.pending = observe();
    if (nativeMainStartupGateSnapshot().status === "blocked") {
      await bindingSweep.entered;
      const firstFlight = waitForNativeMainStartupGate();
      laterRecovery.duplicateCompleted = completeNativeMainRecovery(manager.context.homeId);
      laterRecovery.joined = firstFlight === waitForNativeMainStartupGate();
      laterRecovery.recoveryCalls = recoveryCalls;
      bindingSweep.release();
    }
  }
  if (fixture.scenario === "stale-sweep") {
    await waitForNativeMainStartupGate();
    await oldSweep.entered;
    writeRecoveredAuth();
    blockNativeMainRecovery(manager.context.homeId);
    completeNativeMainRecovery(manager.context.homeId);
    await bindingSweep.entered;
    oldSweep.release();
    // Deliver the older sweep result while the new binding's explicit barrier is still held.
    await Bun.sleep(0);
    laterRecovery = { pending: observe(), admission: await admit() };
    bindingSweep.release();
  }
  if (fixture.scenario === "retained-unknown-binding") {
    await waitForNativeMainStartupGate();
    retainedUnknown = [];
    for (const kind of ["malformed", "conflicting"] as const) {
      writeFileSync(manager.context.authPath, kind === "malformed" ? "{" : JSON.stringify({ tokens: {
        access_token: otherBearer, account_id: fixture.accountId,
      } }));
      servers.push(start());
      await waitForNativeMainStartupGate();
      retainedUnknown.push({ kind, observed: observe(), main: await wire(),
        other: await wire(otherBearer, otherAccountId) });
    }
  }
  const settled = await waitForNativeMainStartupGate();
  const after = observe();
  const settledAdmission = await admit();
  const beforePrimaryUpstreamCalls = upstreamCalls;
  const response = await wire();
  const primaryUpstreamCalls = upstreamCalls - beforePrimaryUpstreamCalls;
  const originalResponse = ["recovery", "renewed-listener", "manual-recovery", "stale-sweep"].includes(fixture.scenario)
    ? await wire(fixture.originalBearer, fixture.originalAccountId) : undefined;
  if (fixture.scenario === "retained-unknown-binding") {
    writeFileSync(manager.context.authPath, JSON.stringify({ tokens: { access_token: otherBearer, account_id: otherAccountId } }));
    servers.push(start());
    await waitForNativeMainStartupGate();
    validReplacement = { oldMatched: matchesMainQuotaCredential(fixture.bearer, fixture.accountId),
      newMatched: matchesMainQuotaCredential(otherBearer, otherAccountId), policy: getMainPolicyQuota(), old: await wire() };
  }
  console.log("POLICY_STARTUP_RESULT=" + JSON.stringify({
    scenario: fixture.scenario, before, listeners, firstServerSettled, firstAdmission, heldRecovery, laterRecovery,
    retainedUnknown, validReplacement,
    settled, after, settledAdmission, response, beforePrimaryUpstreamCalls, primaryUpstreamCalls, originalResponse,
    unexpectedNetwork,
    policyReadsPinned: tokenReads.every(path => path === manager.context.authPath),
  }));
} finally {
  releaseRecovery();
  oldSweep.release();
  bindingSweep.release();
  Bun.serve = realServe;
  for (const server of servers.reverse()) await server.stop(true);
  tokenSpy.mockRestore();
  setIcaclsRunnerForTests(null);
}
