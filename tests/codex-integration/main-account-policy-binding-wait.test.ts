import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CodexMainAccountHardLockError,
  CodexMainProfileDrainingError,
  resolveCodexAuthContext,
} from "../../src/codex/auth-context";
import { resetMainCodexAccountIdentityTrackingForTests } from "../../src/codex/account-lifecycle";
import { MAIN_CODEX_ACCOUNT_ID } from "../../src/codex/main-account";
import { captureMainQuotaWriter, observeMainQuotaCredential, observeMainQuotaIdentity } from "../../src/codex/main-account-cache";
import { NativeProfileManager } from "../../src/codex/native-profile-manager";
import {
  isMainAccountPolicyBindingPending,
  nativeMainStartupGateSnapshot,
  startNativeMainStartupLifecycle,
  type NativeMainStartupLifecycle,
} from "../../src/codex/native-profile-startup";
import { clearAccountQuota, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { handleResponses } from "../../src/server/responses";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

/**
 * The admission fence during an owned startup's main-policy binding (#5694 made it default-on).
 *
 * An owned startup arms the gate synchronously and converges in the background: recovery, the
 * stage sweep, and `initializeMainAccountPolicyBinding` under the exclusive claim. While that
 * runs, `isMainAccountPolicyBindingPending()` is true and no request can establish whether its own
 * credential is the stored main one. Before the default-on lock the fence almost never fired; with
 * it, a request arriving inside that window was answered 503 "native-main profile maintenance is
 * active; retry" -- on Windows the window is wide enough that a client's first request after start
 * reliably lost. These cases pin the wait: the request resumes and is then decided by identity and
 * quota, while a binding that never settles still fails closed.
 */
const MAIN = MAIN_CODEX_ACCOUNT_ID;
const accountId = "policy-binding-wait-fixture";
const token = bearerFor(accountId);

const roots: string[] = [];
const previousHome = process.env.OPENCODEX_HOME;
const previousCodexHome = process.env.CODEX_HOME;
let releases: Array<() => Promise<void>> = [];
let openGates: Array<() => void> = [];
const originalFetch = globalThis.fetch;

function bearerFor(id: string): string {
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 86_400,
    "https://api.openai.com/auth": { chatgpt_account_id: id },
  })).toString("base64url");
  return `header.${payload}.signature`;
}

function callerHeaders(): Headers {
  return new Headers({ authorization: `Bearer ${token}`, "chatgpt-account-id": accountId });
}

/** Direct-mode OpenAI forward, with the hard lock left exactly as the operator persisted it. */
function directConfig(hardLock?: boolean): OcxConfig {
  return {
    port: 0,
    defaultProvider: "openai",
    autoSwitchThreshold: 0,
    activeCodexAccountId: MAIN,
    ...(hardLock === undefined ? {} : { codexMainAccountHardLock: hardLock }),
    providers: { openai: {
      adapter: "openai-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      authMode: "forward",
      codexAccountMode: "direct",
    } },
    codexAccounts: [],
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>(settle => { resolve = settle; });
  return { promise, resolve };
}

interface PendingStartup {
  homeId: string;
  /** The request path's own read, so a case cannot pass against a gate nobody armed. */
  pending(): boolean;
  /** Let recovery finish; the gate then completes its binding and publishes ready. */
  release(): void;
}

/**
 * An owned startup held inside recovery, with `policyBindingPending` true and the gate blocked as
 * `recovery-pending` -- the exact state a request lands in on a slow Windows start.
 *
 * The hold is a real barrier inside the exclusive claim rather than a stubbed predicate: the
 * production convergence below it (recovery, stage sweep, policy binding, ready) all still runs.
 */
async function holdStartup(hardLock?: boolean): Promise<PendingStartup> {
  const root = mkdtempSync(join(tmpdir(), "ocx-policy-binding-wait-"));
  roots.push(root);
  const codexHome = join(root, "codex");
  const configDir = join(root, "opencodex");
  mkdirSync(codexHome, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  process.env.OPENCODEX_HOME = configDir;
  process.env.CODEX_HOME = codexHome;
  writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
    tokens: { access_token: token, refresh_token: "fixture-refresh", account_id: accountId },
  }));
  writeFileSync(join(configDir, "config.json"), JSON.stringify(directConfig(hardLock)));

  const manager = new NativeProfileManager({
    codexHome,
    configDir,
    keyProvider: {
      async get() { return { keyRef: "memory:policy-binding-wait", key: Buffer.alloc(32, 0x3c) }; },
      async create() { return { keyRef: "memory:policy-binding-wait", key: Buffer.alloc(32, 0x3c) }; },
    },
    hardenPath: async () => {},
    processProbe: async () => ({ status: "clear", count: 0 }),
  });
  // No staging tree in this fixture, so the sweep is not the interesting part of convergence.
  manager.stageSweepRequired = () => false;
  let recovered = false;
  manager.recover = async () => {
    recovered = true;
    return { status: "none" } as Awaited<ReturnType<NativeProfileManager["recover"]>>;
  };
  const entered = deferred();
  const gate = deferred();
  const lifecycle: NativeMainStartupLifecycle = startNativeMainStartupLifecycle({
    manager,
    probeRecoveryState: () => recovered ? "none" : "journal",
    stageSweepIntervalMs: 600_000,
    beforeRecovery: async () => { entered.resolve(); await gate.promise; },
    owner: { retryMs: 10, hardenPath: async () => {} },
  });
  releases.push(() => lifecycle.release());
  openGates.push(() => gate.resolve());
  await entered.promise;
  return {
    homeId: lifecycle.homeId!,
    pending: isMainAccountPolicyBindingPending,
    release: () => gate.resolve(),
  };
}

/** The request must still be waiting, not already refused and not already served. */
function trackSettlement(admission: Promise<unknown>): () => boolean {
  let settled = false;
  void admission.then(() => { settled = true; }, () => { settled = true; });
  return () => settled;
}

beforeEach(() => {
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  setAsyncIcaclsRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  resetMainCodexAccountIdentityTrackingForTests();
  clearAccountQuota();
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  // A case may end with the hold still up (the deadline case has to). Open every gate first:
  // `release` below awaits convergence, which cannot finish behind a closed barrier.
  for (const open of openGates.splice(0)) open();
  for (const release of releases.splice(0)) await release();
  setIcaclsRunnerForTests(null);
  setAsyncIcaclsRunnerForTests(null);
  resetMainCodexAccountIdentityTrackingForTests();
  clearAccountQuota();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

describe("a caller-owned request waits out the startup policy binding", () => {
  for (const source of ["loopback", "dedicated"] as const) {
    test(`handleResponses missing caller bearer keeps immediate 401 during binding under ${source} admission`, async () => {
      const startup = await holdStartup();
      const cfg = directConfig();
      cfg.codexMainAccountHardLockFallback = { model: "rescue/rescue-model" };
      cfg.providers.rescue = { adapter: "openai-responses", authMode: "key", apiKey: "fixture-rescue",
        baseUrl: "https://fallback.example/v1" };
      let sends = 0;
      globalThis.fetch = (async () => { sends++; throw new Error("missing caller must not send"); }) as typeof fetch;
      const request = handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-5.3", stream: false, input: "hello" }),
      }), cfg, { model: "", provider: "" }, {
        admission: source === "loopback" ? { kind: "loopback", source }
          : { kind: "configured", keyId: "fixture-admission", source },
      });
      const settled = trackSettlement(request);
      const outcome = request.then(response => ({ response }), error => ({ error }));
      try {
        await Bun.sleep(25);
        expect(startup.pending()).toBe(true);
        expect(settled()).toBe(true);
        const result = await outcome;
        if (!("response" in result)) throw result.error;
        expect(result.response.status).toBe(401);
        await result.response.text();
        expect(sends).toBe(0);
      } finally {
        startup.release();
        const result = await outcome;
        if ("response" in result && !result.response.bodyUsed && !result.response.body?.locked) {
          await result.response.body?.cancel();
        }
      }
    });
  }

  for (const [initialUsage, releaseBlocked] of [[100, true], [100, false], [undefined, true]] as const) {
    test(`handleResponses rechecks fallback after binding settles from ${initialUsage ?? "unknown"} with blocked=${releaseBlocked}`, async () => {
      const startup = await holdStartup();
      observeMainQuotaIdentity(accountId);
      observeMainQuotaCredential(token, accountId);
      const writer = captureMainQuotaWriter(accountId)!;
      if (initialUsage !== undefined) setAccountQuotaFromParsed(MAIN, { weeklyPercent: initialUsage }, undefined, writer);
      const cfg = directConfig();
      cfg.providers.rescue = { adapter: "openai-responses", authMode: "key", apiKey: "fixture-rescue",
        baseUrl: "https://fallback.example/v1" };
      cfg.codexMainAccountHardLockFallback = { model: "rescue/rescue-model" };
      const seen: string[] = [];
      const releaseSpend = acquireOwnedSpendHome();
      globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
        seen.push(String(input));
        const body = JSON.parse(String(init?.body ?? "{}"));
        return Response.json({ id: "resp_binding_fixture", status: "completed", model: body.model,
          output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
      }) as typeof fetch;
      const request = handleResponses(new Request("http://localhost/v1/responses", {
        method: "POST", headers: callerHeaders(),
        body: JSON.stringify({ model: "gpt-5.3", stream: false, input: "hello" }),
      }), cfg, { model: "", provider: "" });
      // Observe rejection too, so a failed assertion never leaves an unhandled request.
      const outcome = request.then(response => ({ response }), error => ({ error }));
      try {
        await Bun.sleep(25);
        expect(startup.pending()).toBe(true);
        expect(seen).toEqual([]);
        setAccountQuotaFromParsed(MAIN, { weeklyPercent: releaseBlocked ? 100 : 10 }, undefined, writer);
        startup.release();
        const result = await outcome;
        if (!("response" in result)) throw result.error;
        expect(result.response.status).toBe(200);
        await result.response.text();
        expect(seen).toEqual([releaseBlocked
          ? "https://fallback.example/v1/responses" : "https://chatgpt.com/backend-api/codex/responses"]);
      } finally {
        startup.release();
        try {
          const result = await outcome;
          if ("response" in result && !result.response.bodyUsed && !result.response.body?.locked) {
            await result.response.body?.cancel();
          }
        } finally { releaseSpend(); }
      }
    });
  }

  test("default config waits for convergence and then resolves an auth context", async () => {
    const startup = await holdStartup();
    expect(startup.pending()).toBe(true);
    expect(nativeMainStartupGateSnapshot()).toEqual({
      status: "blocked", homeId: startup.homeId, reason: "recovery-pending",
    });

    const admission = resolveCodexAuthContext(callerHeaders(), directConfig(), "direct");
    const settled = trackSettlement(admission);
    await Bun.sleep(25);
    // The regression: this used to be a refusal, not a wait.
    expect(settled()).toBe(false);

    startup.release();
    await expect(admission).resolves.toEqual({ kind: "main", accountId: null });
    expect(startup.pending()).toBe(false);
    expect(nativeMainStartupGateSnapshot()).toEqual({ status: "ready", homeId: startup.homeId });
  });

  test("a request-owned main pin waits instead of failing closed on the pin fence", async () => {
    const startup = await holdStartup();
    const cfg = directConfig();
    cfg.activeCodexAccountPinned = MAIN;

    const admission = resolveCodexAuthContext(callerHeaders(), cfg, "pool", {
      requestScopedMainCredential: true,
    });
    const settled = trackSettlement(admission);
    await Bun.sleep(25);
    expect(settled()).toBe(false);

    startup.release();
    await expect(admission).resolves.toEqual({ kind: "main", accountId: null });
  });

  test("a binding still pending at the deadline fails closed as draining", async () => {
    const startup = await holdStartup();
    const startedAt = Date.now();

    await expect(resolveCodexAuthContext(callerHeaders(), directConfig(), "direct", {
      mainAccountPolicyBindingWaitMs: 50,
    })).rejects.toBeInstanceOf(CodexMainProfileDrainingError);

    // The bounded wait was spent, not skipped: the refusal is the deadline, not the arrival.
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(40);
    expect(startup.pending()).toBe(true);

    // A request that has no budget left is refused at once, not after the 15 s default. This is
    // the seam a fixture pins when it asserts the fail-closed fence itself rather than the wait.
    const refusedAt = Date.now();
    await expect(resolveCodexAuthContext(callerHeaders(), directConfig(), "direct", {
      mainAccountPolicyBindingWaitMs: 0,
    })).rejects.toBeInstanceOf(CodexMainProfileDrainingError);
    expect(Date.now() - refusedAt).toBeLessThan(250);
  });

  test("with the hard lock off the request never waits on the binding", async () => {
    const startup = await holdStartup(false);
    expect(startup.pending()).toBe(true);

    // Resolves while the gate is still blocked: the opt-out skips the fence entirely.
    await expect(resolveCodexAuthContext(callerHeaders(), directConfig(false), "direct"))
      .resolves.toEqual({ kind: "main", accountId: null });
    expect(startup.pending()).toBe(true);
  });

  test("an identity-matched caller at 99% is still refused after the wait", async () => {
    const startup = await holdStartup();
    observeMainQuotaIdentity(accountId);
    observeMainQuotaCredential(token, accountId);
    const writer = captureMainQuotaWriter(accountId);
    expect(writer).toBeDefined();
    setAccountQuotaFromParsed(MAIN, { shortPercent: 99 }, undefined, writer);

    const admission = resolveCodexAuthContext(callerHeaders(), directConfig(), "direct");
    const settled = trackSettlement(admission);
    await Bun.sleep(25);
    expect(settled()).toBe(false);

    startup.release();
    const error = await admission.then(() => undefined, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(CodexMainAccountHardLockError);
    expect(error).not.toBeInstanceOf(CodexMainProfileDrainingError);
  });
});
