import { afterEach, describe, expect, test } from "bun:test";
import {
  clearComboSelectionState,
  clearComboTargetCooldowns,
  coolComboTarget,
  isComboTargetInCooldown,
  pickComboTarget,
  targetKey,
} from "../../src/combos";
import {
  coolComboTargetForCommittedTerminal,
} from "../../src/combos/failover";
import {
  addFinalRequestLog,
  beginRequestAttempt,
  registerCommittedTerminalCooldownHandler,
  type RequestLogContext,
} from "../../src/server/request-log";
import { rememberPausedTurn } from "../../src/lib/client-error-body";
import type { OcxConfig } from "../../src/types";

function comboConfig(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "a",
    providers: {
      a: { adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka", models: ["m1", "m-physical"] },
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
      aliasCombo: {
        strategy: "failover",
        targets: [
          { provider: "a", model: "m-alias" },
          { provider: "b", model: "m2" },
        ],
      },
    },
  };
}

describe("committed-terminal combo cooldown", () => {
  const committed = { provider: "a", model: "m1", status: 200 };
  const first = { provider: "a", model: "m1" };

  afterEach(() => {
    clearComboTargetCooldowns();
    clearComboSelectionState();
  });

  test("output_limit on a committed incomplete cools the serving target when output reaches the ceiling", () => {
    coolComboTargetForCommittedTerminal({
      comboId: "free",
      terminalStatus: "incomplete",
      failureDetailCode: "output_limit",
      servingAttempt: committed,
      httpStatus: 200,
      outputTokens: 4096,
      outputCeiling: 4096,
    });
    // Capture after the write: the stored expiry can only be earlier than now + cap,
    // so the boundary assertions stay deterministic without mocking the clock.
    const now = Date.now();
    expect(isComboTargetInCooldown("free", first, now + 60_000)).toBe(true);
    // The next pick skips the exhausted target instead of re-burning its output ceiling.
    const pick = pickComboTarget(comboConfig(), "free", {
      now: now + 1_000,
      allowCooldownReprobe: false,
    })!;
    expect(targetKey(pick.target)).toBe(targetKey({ provider: "b", model: "m2" }));
    // Read the expiry last: an expired-read may retire the entry the pick relied on.
    expect(isComboTargetInCooldown("free", first, now + 10 * 60_000 + 1)).toBe(false);
  });

  test("output_limit does not cool when output is below target ceiling (caller allowance)", () => {
    coolComboTargetForCommittedTerminal({
      comboId: "free",
      terminalStatus: "incomplete",
      failureDetailCode: "output_limit",
      servingAttempt: committed,
      httpStatus: 200,
      outputTokens: 1024,
      outputCeiling: 4096,
    });
    expect(isComboTargetInCooldown("free", first, Date.now() + 1)).toBe(false);
  });

  test("output_limit does not cool when target ceiling is unknown", () => {
    coolComboTargetForCommittedTerminal({
      comboId: "free",
      terminalStatus: "incomplete",
      failureDetailCode: "output_limit",
      servingAttempt: committed,
      httpStatus: 200,
      outputTokens: 4096,
      outputCeiling: null,
    });
    expect(isComboTargetInCooldown("free", first, Date.now() + 1)).toBe(false);
  });

  test("output_limit does not cool on a paused turn (Anthropic pause_turn)", () => {
    coolComboTargetForCommittedTerminal({
      comboId: "free",
      terminalStatus: "incomplete",
      failureDetailCode: "output_limit",
      servingAttempt: committed,
      httpStatus: 200,
      outputTokens: 4096,
      outputCeiling: 4096,
      isPaused: true,
    });
    expect(isComboTargetInCooldown("free", first, Date.now() + 1)).toBe(false);
  });

  test("stall_timeout on a committed incomplete cools briefly regardless of output ceiling", () => {
    coolComboTargetForCommittedTerminal({
      comboId: "free",
      terminalStatus: "incomplete",
      failureDetailCode: "stall_timeout",
      servingAttempt: { ...committed, status: 502 },
      httpStatus: 502,
    });
    const now = Date.now();
    expect(isComboTargetInCooldown("free", first, now + 30_000)).toBe(true);
    expect(isComboTargetInCooldown("free", first, now + 61_000)).toBe(false);
  });

  test("completed, failed, and non-capacity incompletes cool nothing", () => {
    for (const terminalStatus of ["completed", "failed"] as const) {
      coolComboTargetForCommittedTerminal({
        comboId: "free",
        terminalStatus,
        failureDetailCode: "output_limit",
        servingAttempt: committed,
        httpStatus: 200,
        outputTokens: 4096,
        outputCeiling: 4096,
      });
    }
    for (const code of ["content_filter", "adapter_eof", "provider_error", "stream_failed"]) {
      coolComboTargetForCommittedTerminal({
        comboId: "free",
        terminalStatus: "incomplete",
        failureDetailCode: code,
        servingAttempt: committed,
        httpStatus: 502,
      });
    }
    expect(isComboTargetInCooldown("free", first, Date.now() + 1)).toBe(false);
  });

  test("uncommitted, locally answered, and non-combo terminals cool nothing", () => {
    const base = {
      comboId: "free",
      terminalStatus: "incomplete",
      failureDetailCode: "output_limit",
      httpStatus: 200,
      outputTokens: 4096,
      outputCeiling: 4096,
    };
    coolComboTargetForCommittedTerminal({ ...base, servingAttempt: { ...committed, locallyAnswered: true } });
    coolComboTargetForCommittedTerminal({ ...base });
    coolComboTargetForCommittedTerminal({ ...base, comboId: undefined, servingAttempt: committed });
    expect(isComboTargetInCooldown("free", first, Date.now() + 1)).toBe(false);
  });

  test("a longer live cooldown is not shortened by a committed terminal", () => {
    const now = Date.now();
    coolComboTarget("free", first, { retryAfter: "3600", status: 429, now });
    coolComboTargetForCommittedTerminal({
      comboId: "free",
      terminalStatus: "incomplete",
      failureDetailCode: "output_limit",
      servingAttempt: committed,
      httpStatus: 200,
      outputTokens: 4096,
      outputCeiling: 4096,
    });
    // output_limit caps at 10 minutes; the original 1h server Retry-After expiry
    // and its 429 status must both survive the committed-terminal report.
    expect(isComboTargetInCooldown("free", first, now + 11 * 60_000)).toBe(true);
    expect(isComboTargetInCooldown("free", first, now + 59 * 60_000)).toBe(true);
    expect(isComboTargetInCooldown("free", first, now + 61 * 60_000)).toBe(false);
  });

  test("alias target receives cooldown and is skipped on the next pick", () => {
    const aliasTarget = { provider: "a", model: "m-alias" };
    const physicalAttempt = { provider: "a", model: "m-physical", status: 200 };
    let notifiedTarget: Pick<{ provider: string; model: string }, "provider" | "model"> | undefined;

    coolComboTargetForCommittedTerminal({
      comboId: "aliasCombo",
      terminalStatus: "incomplete",
      failureDetailCode: "output_limit",
      target: aliasTarget,
      servingAttempt: physicalAttempt,
      httpStatus: 200,
      outputTokens: 8192,
      outputCeiling: 8192,
      onCooldownRecorded: target => { notifiedTarget = target; },
    });

    expect(notifiedTarget).toEqual(aliasTarget);
    expect(isComboTargetInCooldown("aliasCombo", aliasTarget)).toBe(true);
    expect(isComboTargetInCooldown("aliasCombo", physicalAttempt)).toBe(false);

    const pick = pickComboTarget(comboConfig(), "aliasCombo", {
      allowCooldownReprobe: false,
    })!;
    expect(targetKey(pick.target)).toBe(targetKey({ provider: "b", model: "m2" }));
  });

  test("addFinalRequestLog passes comboTarget, outputCeiling and respects paused turn", () => {
    registerCommittedTerminalCooldownHandler(coolComboTargetForCommittedTerminal);
    try {
      const attempt = beginRequestAttempt(1, "a", "m-physical", "openai-responses");
      attempt.status = 200;
      const aliasTarget = { provider: "a", model: "m-alias" };

      // Case 1: paused turn does not cool
      const pausedLogCtx: RequestLogContext = {
        model: "m-alias", provider: "a", providerAdapter: "openai-responses",
        comboId: "aliasCombo",
        comboTarget: aliasTarget,
        comboTargetOutputCeiling: 4096,
        failureDetail: { code: "output_limit" },
        usage: { inputTokens: 100, outputTokens: 4096 },
        attempts: [attempt],
        activeAttempt: attempt,
      };
      rememberPausedTurn(pausedLogCtx);
      addFinalRequestLog("ocx-test-paused", Date.now(), pausedLogCtx, 200, { terminalStatus: "incomplete" }, () => {});
      expect(isComboTargetInCooldown("aliasCombo", aliasTarget)).toBe(false);

      // Case 2: unpaused turn reaching ceiling cools the alias target
      const unpausedLogCtx: RequestLogContext = {
        model: "m-alias", provider: "a", providerAdapter: "openai-responses",
        comboId: "aliasCombo",
        comboTarget: aliasTarget,
        comboTargetOutputCeiling: 4096,
        failureDetail: { code: "output_limit" },
        usage: { inputTokens: 100, outputTokens: 4096 },
        attempts: [attempt],
        activeAttempt: attempt,
      };
      addFinalRequestLog("ocx-test-unpaused", Date.now(), unpausedLogCtx, 200, { terminalStatus: "incomplete" }, () => {});
      expect(isComboTargetInCooldown("aliasCombo", aliasTarget)).toBe(true);
    } finally {
      registerCommittedTerminalCooldownHandler(undefined);
    }
  });

  test("addFinalRequestLog cools the target after finalization overwrites the stall attempt status", () => {
    registerCommittedTerminalCooldownHandler(coolComboTargetForCommittedTerminal);
    try {
      // The live attempt carries the upstream 200; writeFinalRequestLog finishes it
      // with the client-facing 502 before the cooldown handler reads attempts.at(-1).
      const attempt = beginRequestAttempt(1, "a", "m1", "openai-responses");
      attempt.status = 200;
      const logCtx: RequestLogContext = {
        model: "m1", provider: "a", providerAdapter: "openai-responses",
        comboId: "free",
        failureDetail: { code: "stall_timeout" },
        attempts: [attempt],
        activeAttempt: attempt,
      };
      addFinalRequestLog("ocx-test-stall", Date.now(), logCtx, 502, { terminalStatus: "incomplete" }, () => {});
      expect(attempt.status).toBe(502);
      expect(isComboTargetInCooldown("free", first, Date.now() + 30_000)).toBe(true);
    } finally {
      registerCommittedTerminalCooldownHandler(undefined);
    }
  });
});
