import { afterEach, beforeEach, expect, test } from "bun:test";
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
import { chatSuccess } from "../helpers/combo-failover-upstream";

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

