import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
import { handleComboResponses } from "../../src/server/responses/core";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import type { HandleResponsesOptions } from "../../src/server/responses/core-options";
import type { RequestLogContext } from "../../src/server/request-log";
import type { OcxConfig, OcxUsage } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

/**
 * A combo child logs into its own context and the combo copies it into the request context when
 * the child commits. The bridge binds the adapter usage on the child, possibly before that commit
 * and normally after it. Only the child that commits may hand its usage to the request context.
 */
let releaseSpendHome: (() => void) | undefined;
const reset = (): void => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
};
beforeEach(() => {
  reset();
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(() => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  reset();
});

const provider = (name: string) => ({
  adapter: "openai-chat",
  baseUrl: `https://${name}.example/v1`,
  authMode: "key",
  apiKey: `sk-${name}`,
  models: [`model-${name}`],
});
const config = {
  defaultProvider: "primary",
  providers: { primary: provider("primary"), fallback: provider("fallback") },
  combos: {
    fan: {
      strategy: "failover",
      targets: [
        { provider: "primary", model: "model-primary" },
        { provider: "fallback", model: "model-fallback" },
      ],
    },
  },
} as unknown as OcxConfig;

const usageOf = (credits: number): OcxUsage => ({
  inputTokens: 18, outputTokens: 2, providerCredits: credits, upstreamReported: true,
});

interface Child {
  provider: string;
  /** The request context the combo writes the row from. */
  parent: RequestLogContext;
  log: RequestLogContext;
  options: HandleResponsesOptions;
}

/** Stands in for the bridge: binds usage on the child's own context, as bindKeyUsageFromBridge does. */
function bind(child: Child, usage: OcxUsage): void {
  child.log.usageFromBridge = true;
  child.log.usage = usage;
  if (child.log.activeAttempt) child.log.activeAttempt.usage = usage;
  child.options.onBridgeUsageBound?.();
}

async function runCombo(
  answer: (child: Child) => Response | Promise<Response>,
  options: Partial<HandleResponsesOptions> = {},
): Promise<{ response: Promise<Response>; logCtx: RequestLogContext; children: Child[] }> {
  const children: Child[] = [];
  const logCtx: RequestLogContext = { model: "", provider: "" };
  const req = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/fan", stream: false, input: "hello" }),
  });
  const response = executeComboResponses(req, await req.clone().json(), "fan", config, logCtx, {
    translatorBudget: createTranslatorBudget(),
    ...options,
  }, {
    handleComboResponses,
    handleResponses: async (_req, _config, childLog, childOptions) => {
      const child: Child = { provider: childLog.provider, parent: logCtx, log: childLog, options: childOptions ?? {} };
      children.push(child);
      return answer(child);
    },
  });
  return { response, logCtx, children };
}

const ok = (): Response => Response.json({ status: "completed" });
const refused = (): Response => Response.json(
  { error: { message: "weekly usage limit reached", type: "rate_limit_error" } },
  { status: 429 },
);

describe("combo hands the committed child's bridge usage to the request context", () => {
  test("usage bound after the commit reaches the request context", async () => {
    const run = await runCombo(() => ok());
    expect((await run.response).status).toBe(200);
    expect(run.logCtx.usageFromBridge).toBeUndefined();

    const usage = usageOf(0.04);
    bind(run.children[0]!, usage);
    expect(run.logCtx.usageFromBridge).toBe(true);
    expect(run.logCtx.usage).toBe(usage);
    expect(run.logCtx.activeAttempt?.usage).toBe(usage);
  });

  test("usage bound before the commit is still handed over once the child commits", async () => {
    const usage = usageOf(0.05);
    const run = await runCombo(child => {
      bind(child, usage);
      // The commit has not happened yet, so nothing may reach the request context from here.
      expect(child.parent.usage).toBeUndefined();
      return ok();
    });
    expect((await run.response).status).toBe(200);
    expect(run.logCtx.usageFromBridge).toBe(true);
    expect(run.logCtx.usage).toBe(usage);
  });

  test("a refused first target never lends its usage; only the committed target does", async () => {
    const run = await runCombo(child => child.provider === "primary" ? refused() : ok());
    expect((await run.response).status).toBe(200);
    expect(run.children.map(child => child.provider)).toEqual(["primary", "fallback"]);
    const [primary, fallback] = run.children as [Child, Child];

    // The refused target's stream can still report after the fallback has committed.
    bind(primary, usageOf(9.99));
    expect(run.logCtx.usage).toBeUndefined();
    expect(run.logCtx.usageFromBridge).toBeUndefined();

    const usage = usageOf(0.04);
    bind(fallback, usage);
    expect(run.logCtx.usage).toBe(usage);
    expect(run.logCtx.usage?.providerCredits).toBe(0.04);
    expect(run.logCtx.usageFromBridge).toBe(true);
  });

  test("a commit that throws forwards nothing for that child", async () => {
    // The child reported its terminal before the commit, so the commit publishes it to the
    // caller's callback. A callback that throws aborts the commit.
    const run = await runCombo(child => {
      child.options.onNativePassthroughTerminal?.("completed");
      return ok();
    }, {
      onNativePassthroughTerminal: () => { throw new Error("terminal sink failed"); },
    });
    await expect(run.response).rejects.toThrow("terminal sink failed");

    bind(run.children[0]!, usageOf(0.07));
    expect(run.logCtx.usage).toBeUndefined();
    expect(run.logCtx.usageFromBridge).toBeUndefined();
  });
});
