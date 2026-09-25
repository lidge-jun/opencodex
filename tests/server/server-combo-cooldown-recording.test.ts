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
