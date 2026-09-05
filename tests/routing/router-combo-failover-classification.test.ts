import { afterEach, describe, expect, test } from "bun:test";
import {
  advanceComboAfterFailure,
  clearComboSelectionState,
  clearComboTargetCooldowns,
  coolComboTarget,
  isComboTargetInCooldown,
  pickComboTarget,
  targetKey,
} from "../../src/combos";
import { comboFailureCooldownScope, comboFailureDecision } from "../../src/combos/failover";
import { adapterFailureFromMessage, inferHttpStatusFromAdapterMessage } from "../../src/lib/errors";
import type { OcxConfig } from "../../src/types";

/**
 * Cooldown scope and hop/stop verdicts must match a failure's actual blast radius. Before this
 * suite, every non-quota failure cooled the target it hit — including request-shape refusals
 * that say nothing about target health — and `pickComboTarget` never consulted the cooldown
 * map at all, so a target cooled a moment earlier was picked again immediately.
 */

function comboConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1"] },
      b: { adapter: "openai-chat", baseUrl: "https://b.example/v1", apiKey: "kb", models: ["m2"] },
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
  };
}

const first = { provider: "a", model: "m1" };

afterEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
});

describe("combo failure cooldown scope", () => {
  test("request-shape refusals cool nothing at all", () => {
    // An oversized request is a fact about the request, not the target: cooling here would make
    // the next, shorter request skip a provider that would have served it.
    expect(comboFailureCooldownScope(413, "request entity too large")).toBe("none");
    for (const code of [
      "input_admission_refused",
      "context_length_exceeded",
      "tool_catalog_too_large",
      "cursor_root_envelope_limit",
      "target_incompatible",
    ]) {
      expect(comboFailureCooldownScope(400, "refused locally", { code })).toBe("none");
    }
    // Hyphenated spellings normalize to the same codes.
    expect(comboFailureCooldownScope(400, "refused", { code: "input-admission-refused" })).toBe("none");
    // A provider's own per-target hard cap (vendor code 5059) is equally request-shaped.
    expect(comboFailureCooldownScope(
      400,
      "prompt 900000 > 200000 maximum context length",
      { code: "5059" },
    )).toBe("none");
  });

  test("a per-request free-tier cap does not cool the whole provider", () => {
    // `free_rate_limited` is evaluated per request, so provider-wide cooldown punished every
    // other combo for one oversized free-tier prompt.
    expect(comboFailureCooldownScope(400, "prompt too long for the free tier", {
      code: "free_rate_limited",
    })).toBe("none");
  });

  test("credential and billing failures cool the whole provider", () => {
    expect(comboFailureCooldownScope(401, "invalid api key")).toBe("provider");
    expect(comboFailureCooldownScope(402, "payment required")).toBe("provider");
    expect(comboFailureCooldownScope(403, "forbidden")).toBe("provider");
    for (const code of [
      "invalid_api_key",
      "insufficient_quota",
      "subscription_required",
      "payment_required",
      "billing_error",
      "insufficient_balance",
    ]) {
      expect(comboFailureCooldownScope(500, "upstream said no", { code })).toBe("provider");
    }
    // The pre-existing account-window quota cap keeps its provider scope.
    expect(comboFailureCooldownScope(429, "monthly usage limit reached")).toBe("provider");
  });

  test("an ordinary target failure still cools only that target", () => {
    expect(comboFailureCooldownScope(500, "internal server error")).toBe("target");
    expect(comboFailureCooldownScope(429, "rate limit reached for requests")).toBe("target");
  });
});

describe("combo failure hop/stop verdicts", () => {
  test("model-scoped rejections hop to the next target", () => {
    for (const code of ["model_not_found", "model_unavailable", "unsupported_model"]) {
      expect(comboFailureDecision(400, "upstream rejected the model", { code })).toBe("hop");
    }
  });

  test("402 and 425 hop instead of ending the chain", () => {
    expect(comboFailureDecision(402, "payment required")).toBe("hop");
    expect(comboFailureDecision(425, "too early")).toBe("hop");
  });

  test("a per-request free-tier cap still hops", () => {
    expect(comboFailureDecision(400, "free tier prompt cap", { code: "free_rate_limited" })).toBe("hop");
  });

  test("INVARIANT: generic 410 and 413 remain terminal", () => {
    // These two are the tripwire for this change. A widened hop list must never swallow them:
    // 410 without a structured lifecycle code is a real resource-gone verdict, and a generic
    // 413 is a request the next target would reject identically.
    expect(comboFailureDecision(410, "resource is gone")).toBe("stop");
    expect(comboFailureDecision(413, "request too large")).toBe("stop");
  });

  test("INVARIANT: a structured model lifecycle 410 still hops", () => {
    expect(comboFailureDecision(410, "model retired", { code: "model_end_of_life" })).toBe("hop");
  });
});

describe("cooled targets are not selectable", () => {
  test("a target inside its cooldown window is skipped by pickComboTarget", () => {
    const config = comboConfig();
    const now = 10_000;
    coolComboTarget("free", first, { now, cooldownMs: 60_000 });
    expect(isComboTargetInCooldown("free", first, now + 5_000)).toBe(true);
    const pick = pickComboTarget(config, "free", { now: now + 5_000 });
    expect(pick && targetKey(pick.target)).toBe(targetKey({ provider: "b", model: "m2" }));
  });

  test("an expired cooldown makes the target selectable again", () => {
    const config = comboConfig();
    const now = 10_000;
    coolComboTarget("free", first, { now, cooldownMs: 1_000 });
    const pick = pickComboTarget(config, "free", { now: now + 1_000 });
    expect(pick && targetKey(pick.target)).toBe(targetKey(first));
  });

  test("a \"none\" scope records no cooldown, so the target stays selectable", () => {
    const config = comboConfig();
    const now = 10_000;
    const pick = pickComboTarget(config, "free", { now })!;
    expect(targetKey(pick.target)).toBe(targetKey(first));
    advanceComboAfterFailure(config, pick, {
      now,
      cooldownScope: comboFailureCooldownScope(413, "request entity too large"),
      status: 413,
      message: "request entity too large",
    });
    expect(isComboTargetInCooldown("free", first, now)).toBe(false);
    // The failed target is excluded from THIS request via `attempted`, but a fresh request
    // (no exclusions) must still find it healthy.
    expect(targetKey(pickComboTarget(config, "free", { now })!.target)).toBe(targetKey(first));
  });

  test("a target-scoped failure does record a cooldown", () => {
    const config = comboConfig();
    const now = 10_000;
    const pick = pickComboTarget(config, "free", { now })!;
    advanceComboAfterFailure(config, pick, {
      now,
      cooldownScope: comboFailureCooldownScope(500, "internal server error"),
      status: 500,
      message: "internal server error",
    });
    expect(isComboTargetInCooldown("free", first, now)).toBe(true);
  });
});

describe("malformed upstream bytes are a provider failure", () => {
  test("\"malformed upstream\" infers 502, not a client 4xx", () => {
    // Message-only path: no structured `server_error` type, so the `structuredServerClass`
    // override in httpStatusFromTerminalError cannot absorb this case. Plain "malformed"
    // keeps its 400 verdict, which is what scopes the new branch.
    expect(inferHttpStatusFromAdapterMessage("malformed upstream SSE data frame")).toBe(502);
    expect(inferHttpStatusFromAdapterMessage("malformed request payload")).toBe(400);
    expect(adapterFailureFromMessage("malformed upstream SSE data frame")).toMatchObject({
      httpStatus: 502,
      error: { type: "server_error", code: "upstream_server_error" },
    });
  });
});
