import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearComboSelectionState } from "../../src/combos/resolve";
import { advanceComboAfterFailure, pickComboTarget } from "../../src/combos/resolve";
import { clearComboTargetCooldowns, coolComboTarget, isComboTargetInCooldown, reconcileComboTargetCooldowns } from "../../src/combos/failover";
import { captureConfigGeneration, type GenerationContext } from "../../src/lib/state-store-sweeper";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearResponseStateForTests, flushResponseState } from "../../src/responses/state";
import { chatSuccess, responsesSuccess } from "../helpers/combo-failover-upstream";
import { saveCodexAccountCredential } from "../../src/codex/account-store";
import { clearCodexUpstreamHealth, clearCodexUpstreamHealthForAccount, getCodexQuotaHealthSnapshot, recordCodexUpstreamOutcome } from "../../src/codex/routing";
import { clearAccountQuota, flushQuotaObservationsForTests, setAccountQuotaFromParsed } from "../../src/codex/quota";
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import {
  CodexAccountCooldownError, CodexMainAccountHardLockError, CodexMainAccountCreditsOffError,
  CodexPoolAccountCreditsOffError, CodexReserveUnavailableError, CodexReserveHelperUnsupportedError,
  CodexRecoveryWithheldError, cooldownErrorResponse,
} from "../../src/codex/auth-context";
import { isCodexAccountCooldownResponse } from "../../src/codex/account-cooldown-response";
import { consumeComboFailure } from "../../src/server/responses/core-combo-failure";
import { mapCodexAuthContextErrorToResponse } from "../../src/server/responses/codex-auth-error";
import { finalizeAccountLease } from "../../src/server/responses/core-lifetime";

/** The Responses mapping every combo child's local auth refusal goes through. */
function localRefusal(error: CodexAccountCooldownError, now: number): Response {
  const response = mapCodexAuthContextErrorToResponse(error, { now });
  if (!response) throw new Error("cooldown errors always map to a response");
  return response;
}

type HandleOptions = NonNullable<Parameters<typeof handleResponses>[3]>;
const pendingTurns: Response[] = [];
function trackTurn(response: Response): Response { pendingTurns.push(response); return response; }
function takeSpendHome(): void { release ??= acquireOwnedSpendHome(); }
function provider(adapter: string, url: string, apiKey: string): OcxConfig["providers"][string] {
  return { adapter, baseUrl: url, apiKey, allowPrivateNetwork: true };
}
function serve(handler: (request: Request) => Response | Promise<Response>) {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  return upstream;
}
function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `${server.url.toString().replace(/\/$/, "")}/v1`;
}
function comboConfig(
  providers: OcxConfig["providers"],
  targets = Object.keys(providers).map((name, index) => ({ provider: name, model: `m${index + 1}` })),
  extra: Partial<NonNullable<OcxConfig["combos"]>[string]> = {},
): OcxConfig {
  return { port: 0, defaultProvider: Object.keys(providers)[0]!, providers, combos: { free: { strategy: "failover", targets, ...extra } } };
}
async function post(
  config: OcxConfig,
  raw: Record<string, unknown> = {},
  options: HandleOptions = {},
  headers: Record<string, string> = {},
): Promise<Response> {
  takeSpendHome();
  return trackTurn(await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: false, ...raw }),
  }), config, { model: "", provider: "" }, options));
}

let home = "";
let previous: string | undefined;
let codex: IsolatedCodexHome | undefined;
let release: (() => void) | undefined;
let upstream: ReturnType<typeof Bun.serve> | undefined;
const target = { provider: "a", model: "m1" };
function removalContext(): GenerationContext {
  return { generation: captureConfigGeneration() + 1, providerNames: new Set(["a"]),
    comboIds: new Set(["free"]), comboTargets: new Set(), codexAccountIds: new Set(),
    oauthAccountKeys: new Set(), configRoots: new Set([home]) };
}
function config(baseUrl = "http://127.0.0.1:1/v1"): OcxConfig {
  return { port: 0, defaultProvider: "a",
    providers: { a: { adapter: "openai-chat", baseUrl, apiKey: "synthetic-key", allowPrivateNetwork: true } },
    combos: { free: { strategy: "failover", targets: [target], cooldownMs: 100, waitForCooldownMs: 1000 } } };
}
beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-combo-recording-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("ocx-combo-recording-codex-");
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearResponseStateForTests();
});
afterEach(async () => {
  try {
    for (const turn of pendingTurns.splice(0)) {
      if (turn.bodyUsed || !turn.body || turn.body.locked) continue;
      try { await turn.body.cancel(); } catch { /* a turn the test already drained may refuse cancel; cleanup continues */ }
    }
    await upstream?.stop(true);
    upstream = undefined;
    await flushResponseState();
    clearResponseStateForTests();
    release?.();
    release = undefined;
    clearComboSelectionState();
    clearComboTargetCooldowns();
  } finally {
    codex?.restore();
    codex = undefined;
    if (previous === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previous;
    removeTreeWithRetry(home);
  }
});
test("an in-flight cooldown retry cannot initiate an opt-in reprobe", async () => {
  let hits = 0;
  const server = serve(() => {
    hits += 1;
    return hits === 1
      ? Response.json({ error: { message: "rate limited" } }, {
        status: 429, headers: { "retry-after": "2" },
      })
      : chatSuccess("unexpected immediate retry", "m1");
  });
  const cfg = comboConfig({ a: provider("openai-chat", baseUrl(server), "synthetic-key") }, [target], {
    cooldownReprobe: { enabled: true, intervalMs: 1000 }, waitForCooldownMs: 100,
  });
  const response = await post(cfg);
  await response.text();
  expect(response.status).toBe(429);
  expect(hits).toBe(1);
  expect(isComboTargetInCooldown("free", target)).toBe(true);
});

test("a local Codex pool cooldown uses capped target backoff and permits account recovery", async () => {
  let now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const nativeFetch = spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json(responsesSuccess("recovered", "gpt-5.6-terra")));
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  setAsyncIcaclsRunnerForTests(async () => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  const accountId = "combo-local-cooldown";
  const codexTarget = { provider: "openai", model: "gpt-5.6-terra" };
  const cfg = comboConfig({ openai: {
    adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex",
    authMode: "forward", codexAccountMode: "pool",
  } }, [codexTarget], { cooldownMs: 3_600_000, waitForCooldownMs: 0 });
  cfg.codexAccounts = [{ id: accountId, email: "cooldown@example.test", isMain: false }];
  cfg.activeCodexAccountId = accountId;
  cfg.autoSwitchThreshold = 0;
  clearCodexUpstreamHealth();
  try {
    saveCodexAccountCredential(accountId, {
      accessToken: "synthetic-cooldown-access", refreshToken: "synthetic-cooldown-refresh",
      expiresAt: now + 86_400_000, chatgptAccountId: "synthetic-cooldown-account",
    });
    setAccountQuotaFromParsed(accountId, { weeklyPercent: 10 });
    recordCodexUpstreamOutcome(cfg, accountId, 429, { now, retryAfter: "84692", modelId: codexTarget.model });
    const health = getCodexQuotaHealthSnapshot(accountId, "shared");
    const refused = await post(cfg);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBe("84692");
    await refused.text();
    expect(nativeFetch).not.toHaveBeenCalled();
    expect(getCodexQuotaHealthSnapshot(accountId, "shared")).toEqual(health);
    expect(isComboTargetInCooldown("free", codexTarget, now + 599_999)).toBe(true);
    expect(isComboTargetInCooldown("free", codexTarget, now + 600_000)).toBe(false);
    // Model the operator's existing account recovery action, without clearing combo state.
    clearCodexUpstreamHealthForAccount(accountId);
    now += 600_001;
    const recovered = await post(cfg);
    expect(recovered.status).toBe(200);
    expect(await recovered.text()).toContain("recovered");
    expect(nativeFetch).toHaveBeenCalledTimes(1);
  } finally {
    nativeFetch.mockRestore();
    clock.mockRestore();
    clearAccountQuota(accountId);
    await flushQuotaObservationsForTests();
    clearCodexUpstreamHealth();
    setIcaclsRunnerForTests(null);
    setAsyncIcaclsRunnerForTests(null);
  }
});

for (const [seconds, recordedMs] of [[84692, 84_692_000], [172800, 86_400_000]] as const) {
test(`an upstream 429 with the local refusal's wire shape honors Retry-After ${seconds} up to 24h`, async () => {
  const now = 1_800_000_000_000;
  const clock = spyOn(Date, "now").mockReturnValue(now);
  let hits = 0;
  const server = serve(() => {
    hits++;
    // Even a response minted in this process loses provenance across HTTP. A header cannot
    // recover it: this mimics both the ordinary refusal body and a claimed local marker.
    const response = cooldownErrorResponse(new CodexAccountCooldownError("synthetic-upstream", now + seconds * 1000), now);
    response.headers.set("x-opencodex-local-codex-cooldown", "true");
    return response;
  });
  try {
    const cfg = comboConfig({ a: provider("openai-responses", baseUrl(server), "synthetic-key") }, [target], {
      cooldownMs: 1000, waitForCooldownMs: 0,
    });
    const response = await post(cfg);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe(String(seconds));
    await response.text();
    expect(hits).toBe(1);
    expect(isComboTargetInCooldown("free", target, now + recordedMs - 1)).toBe(true);
    expect(isComboTargetInCooldown("free", target, now + recordedMs)).toBe(false);
  } finally {
    clock.mockRestore();
  }
});
}

test("local cooldown provenance survives reconstruction but cannot be copied from wire metadata", async () => {
  const now = 1_800_000_000_000;
  const local = localRefusal(new CodexAccountCooldownError("synthetic-local", now + 84_692_000), now);
  local.headers.set("x-codex-primary-reset-at", String((now + 84_692_000) / 1000));
  expect(isCodexAccountCooldownResponse(local)).toBe(true);
  const copy = new Response(await local.clone().text(), { status: local.status, headers: local.headers });
  expect(isCodexAccountCooldownResponse(copy)).toBe(false);
  const copied = await consumeComboFailure(copy, undefined, now);
  expect(isCodexAccountCooldownResponse(copied.response)).toBe(false);
  expect(copied.retryAfter).toBe("84692");
  const consumed = await consumeComboFailure(local, undefined, now);
  expect(isCodexAccountCooldownResponse(consumed.response)).toBe(true);
  expect(consumed.retryAfter).toBe("84692");
  expect(consumed.resetAt).toEqual([String((now + 84_692_000) / 1000)]);
  expect(consumed.response.headers.get("retry-after")).toBe("84692");
  const reconstructed = await consumeComboFailure(consumed.response, undefined, now);
  expect(isCodexAccountCooldownResponse(reconstructed.response)).toBe(true);
  await copied.response.text();
  await reconstructed.response.text();
});

test("a late local refusal keeps its provenance through the retained-compaction lease wrapper", async () => {
  // Retained compaction v2 delivers every child response through finalizeAccountLease. A refusal
  // minted after admission (for example during pacing) must still reach combo recording as local.
  const now = 1_800_000_000_000;
  let released = 0;
  const local = localRefusal(new CodexAccountCooldownError("synthetic-late", now + 84_692_000), now);
  const delivered = finalizeAccountLease(local, () => { released++; });
  expect(delivered).not.toBe(local);
  expect(isCodexAccountCooldownResponse(delivered)).toBe(true);
  const consumed = await consumeComboFailure(delivered, undefined, now);
  expect(isCodexAccountCooldownResponse(consumed.response)).toBe(true);
  expect(consumed.retryAfter).toBe("84692");
  await consumed.response.text();
  expect(released).toBe(1);
});

for (const policy of [
  () => new CodexMainAccountHardLockError(1_800_084_692_000),
  () => new CodexMainAccountCreditsOffError(1_800_084_692_000),
  () => new CodexPoolAccountCreditsOffError("synthetic-policy", 1_800_084_692_000),
  () => new CodexReserveUnavailableError(),
  () => new CodexReserveHelperUnsupportedError(),
  () => new CodexRecoveryWithheldError("synthetic-policy", 1_800_084_692_000),
  () => new (class FuturePolicyError extends CodexAccountCooldownError {})("synthetic-policy", 1_800_084_692_000),
]) {
  test(`${policy().constructor.name} keeps its refusal behavior without ordinary cooldown provenance`, async () => {
    const now = 1_800_000_000_000;
    const error = policy();
    const response = localRefusal(error, now);
    expect(response.status).toBe(429);
    expect(isCodexAccountCooldownResponse(response)).toBe(false);
    const reserve = error instanceof CodexReserveUnavailableError;
    expect(response.headers.get("retry-after")).toBe(reserve ? null : "84692");
    if (error instanceof CodexMainAccountHardLockError) {
      expect(await response.clone().json()).toMatchObject({ error: {
        type: "usage_limit_reached", code: "usage_limit_reached", resets_at: 1_800_084_692,
      } });
    }
    const consumed = await consumeComboFailure(response, undefined, now);
    expect(isCodexAccountCooldownResponse(consumed.response)).toBe(false);
    expect(consumed.retryAfter).toBe(reserve ? undefined : "84692");
    if (error instanceof CodexMainAccountHardLockError) expect(consumed.upstreamCode).toBe("usage_limit_reached");
    await consumed.response.text();
  });
}

test("cooldown recording distinguishes a successful write from a stale removed writer", () => {
  expect(coolComboTarget("free", target, { cooldownMs: 1000 })).toBe(true);
  reconcileComboTargetCooldowns(removalContext());
  expect(isComboTargetInCooldown("free", target)).toBe(true);
  expect(coolComboTarget("free", target, { cooldownMs: 1000 })).toBe(false);
});
test("advance reports only the current failure's committed cooldown", () => {
  const cfg = config();
  const pick = pickComboTarget(cfg, "free")!;
  expect(pick).not.toBeNull();
  const recorded: string[] = [];
  advanceComboAfterFailure(cfg, pick, { cooldownScope: "target", onCooldownRecorded: t => recorded.push(t.model) });
  expect(recorded).toEqual(["m1"]);
  recorded.length = 0;
  reconcileComboTargetCooldowns(removalContext());
  advanceComboAfterFailure(cfg, pick, { cooldownScope: "target", onCooldownRecorded: t => recorded.push(t.model) });
  expect(recorded).toEqual([]);
  expect(isComboTargetInCooldown("free", target)).toBe(true);
});
test("a pool account's 429 cools nothing at the combo layer, other failures still cool the target", () => {
  const cfg = config();
  const account = { failedAccount: "anthropic-p2e22d0" };
  const cool = (options: Parameters<typeof advanceComboAfterFailure>[2]): boolean => {
    clearComboTargetCooldowns();
    advanceComboAfterFailure(cfg, pickComboTarget(cfg, "free")!, { cooldownScope: "target", ...options });
    return isComboTargetInCooldown("free", target);
  };
  // The outage's own header, attributed to one account of a pool.
  expect(cool({ status: 429, retryAfter: "318747", ...account })).toBe(false);
  // Unknown account: nothing else holds the target back, so the target cooldown still must.
  expect(cool({ status: 429, retryAfter: "318747" })).toBe(true);
  // A genuine target-level failure is not the account's fault and cools as it always did.
  expect(cool({ status: 503, ...account })).toBe(true);
  expect(cool({ status: 410, code: "model_not_found", ...account })).toBe(true);
  // Provider-scoped evidence (a rejected credential) outranks the account attribution.
  expect(cool({ status: 429, cooldownScope: "provider", ...account })).toBe(true);
});
test("a stale in-flight single-target request does not replay a reconciled-away target", async () => {
  let hits = 0;
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    hits += 1;
    if (hits > 1) return chatSuccess("unexpected replay", "m1");
    // The request already captured its generation. A sibling records cooldown,
    // then management removes the target before this response reaches failover.
    expect(coolComboTarget("free", target, { cooldownMs: 100 })).toBe(true);
    reconcileComboTargetCooldowns(removalContext());
    return Response.json({ error: { message: "rate limited" } }, { status: 429 });
  } });
  release = acquireOwnedSpendHome();
  const cfg = config(`${upstream.url.toString().replace(/\/$/, "")}/v1`);
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: false }),
  }), cfg, { model: "", provider: "" });
  await response.text();
  expect(response.status).toBe(429);
  expect(hits).toBe(1);
}, 15000);



// Moved from tests/server/server-combo-failover-e2e.test.ts to keep that file under its file-size cap.
  test("single-target wait does not retry a request-local refusal", async () => {
    let hits = 0;
    const upstream = serve(() => {
      hits += 1;
      return Response.json({ error: { type: "invalid_request_error", message: "Unsupported parameter: user" } }, { status: 400 });
    });
    const response = await post(comboConfig({ a: provider("openai-responses", baseUrl(upstream), "key-a") }, [
      { provider: "a", model: "m1" },
    ], { cooldownMs: 50, waitForCooldownMs: 500 }), { user: "synthetic-client" });
    expect(response.status).toBe(400);
    expect(hits).toBe(1);
  });

  test("a concurrent cooldown does not retry a request-local refusal", async () => {
    // Two requests share one target: the first stays in flight on a gate while the second
    // fails hot and writes the SHARED cooldown. The first request's own failure records no
    // cooldown (scope "none"), so the foreign entry alone must not arm the retry gate —
    // it would wait out the sibling's cooldown and replay the refused request.
    let markHeld!: () => void;
    let releaseHeld!: () => void;
    const heldRequest = new Promise<void>(resolve => { markHeld = resolve; });
    const gate = new Promise<void>(resolve => { releaseHeld = resolve; });
    let hits = 0;
    const upstream = serve(async () => {
      hits += 1;
      if (hits === 1) {
        markHeld();
        await gate;
        return Response.json({ error: { type: "invalid_request_error", message: "Unsupported parameter: user" } }, { status: 400 });
      }
      // 429 rather than 5xx so the failure reaches the combo layer directly:
      // fetchWithTransientRetry would absorb a 503 before it could cool the target.
      return hits === 2
        ? Response.json({ error: { message: "rate limited" } }, { status: 429 })
        : chatSuccess("single target recovered", "m1");
    });
    const config = comboConfig({ a: provider("openai-responses", baseUrl(upstream), "key-a") }, [
      { provider: "a", model: "m1" },
    ], { cooldownMs: 500, waitForCooldownMs: 2_000 });

    const refused = post(config, { user: "synthetic-client" });
    await heldRequest;
    const cooling = post(config);
    const target = { provider: "a", model: "m1" };
    const deadline = Date.now() + 5_000;
    while (!isComboTargetInCooldown("free", target)) {
      if (Date.now() > deadline) throw new Error("sibling request never cooled the target");
      await Bun.sleep(5);
    }
    releaseHeld();
    const [refusal, cooled] = await Promise.all([refused, cooling]);
    expect(refusal.status).toBe(400);
    expect(cooled.status).toBe(200);
    // The cooling request hits twice (failure, then its own post-cooldown retry); the
    // refused request must hit exactly once.
    expect(hits).toBe(3);
  });

