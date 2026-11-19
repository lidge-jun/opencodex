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
  comboTargetCooldownExpiry,
  comboTargetCooldownStatus,
  coolComboTargetForCommittedTerminal,
} from "../../src/combos/failover";
import {
  addFinalRequestLog,
  beginRequestAttempt,
  finishRequestAttempt,
  inspectResponseLogSsePayloadParsed,
  registerCommittedTerminalCooldownHandler,
  type RequestLogContext,
  type RequestLogEntry,
} from "../../src/server/request-log";
import { rememberPausedTurn } from "../../src/lib/client-error-body";
import { executeComboResponses } from "../../src/server/responses/core-combo";
import type { ResponsesTerminalStatus } from "../../src/server/responses/core-options";
import { createTranslatorBudget } from "../../src/lib/translator-budget";
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

function inspectIncomplete(logCtx: RequestLogContext, reason: string): void {
  const terminal = { type: "response.incomplete", response: { incomplete_details: { reason } } };
  inspectResponseLogSsePayloadParsed(logCtx, JSON.stringify(terminal), terminal);
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
      terminalReason: "max_output_tokens",
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
      terminalReason: "max_output_tokens",
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
      terminalReason: "max_output_tokens",
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
      terminalReason: "max_output_tokens",
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
      terminalReason: "upstream_stall_timeout",
      servingAttempt: { ...committed, status: 502 },
      httpStatus: 502,
    });
    const now = Date.now();
    expect(isComboTargetInCooldown("free", first, now + 30_000)).toBe(true);
    expect(isComboTargetInCooldown("free", first, now + 61_000)).toBe(false);
  });

  test("completed, failed, and incompletes without a cooldown reason cool nothing", () => {
    for (const terminalStatus of ["completed", "failed"] as const) {
      coolComboTargetForCommittedTerminal({
        comboId: "free",
        terminalStatus,
        terminalReason: "max_output_tokens",
        servingAttempt: committed,
        httpStatus: 200,
        outputTokens: 4096,
        outputCeiling: 4096,
      });
    }
    coolComboTargetForCommittedTerminal({
      comboId: "free",
      terminalStatus: "incomplete",
      servingAttempt: committed,
      httpStatus: 502,
    });
    expect(isComboTargetInCooldown("free", first, Date.now() + 1)).toBe(false);
  });

  test("uncommitted, locally answered, and non-combo terminals cool nothing", () => {
    const base = {
      comboId: "free",
      terminalStatus: "incomplete",
      terminalReason: "max_output_tokens" as const,
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
      terminalReason: "max_output_tokens",
      servingAttempt: committed,
      httpStatus: 200,
      outputTokens: 4096,
      outputCeiling: 4096,
    });
    // output_limit caps at 10 minutes; the original 1h server Retry-After expiry
    // and its 429 status must both survive the committed-terminal report.
    expect(comboTargetCooldownExpiry("free", first, now)).toBe(now + 3_600_000);
    expect(comboTargetCooldownStatus("free", first, now)).toBe(429);
    expect(isComboTargetInCooldown("free", first, now + 11 * 60_000)).toBe(true);
    expect(isComboTargetInCooldown("free", first, now + 59 * 60_000)).toBe(true);
    expect(isComboTargetInCooldown("free", first, now + 61 * 60_000)).toBe(false);
  });

  test("alias target receives cooldown and is skipped on the next pick", () => {
    const aliasTarget = { provider: "a", model: "m-alias" };
    const physicalAttempt = { provider: "a", model: "m-physical", status: 200 };

    coolComboTargetForCommittedTerminal({
      comboId: "aliasCombo",
      terminalStatus: "incomplete",
      terminalReason: "max_output_tokens",
      target: aliasTarget,
      servingAttempt: physicalAttempt,
      httpStatus: 200,
      outputTokens: 8192,
      outputCeiling: 8192,
    });

    expect(isComboTargetInCooldown("aliasCombo", aliasTarget)).toBe(true);
    expect(isComboTargetInCooldown("aliasCombo", physicalAttempt)).toBe(false);

    const pick = pickComboTarget(comboConfig(), "aliasCombo", {
      allowCooldownReprobe: false,
    })!;
    expect(targetKey(pick.target)).toBe(targetKey({ provider: "b", model: "m2" }));
  });

  test("addFinalRequestLog passes comboTarget, outputCeiling and respects paused turn from child context", async () => {
    registerCommittedTerminalCooldownHandler(coolComboTargetForCommittedTerminal);
    try {
      const cfg: OcxConfig = {
        port: 10100,
        defaultProvider: "a",
        providers: {
          a: {
            adapter: "openai-chat", baseUrl: "https://a.example/v1", apiKey: "ka",
            models: ["m-alias"],
            modelMaxOutputTokens: { "m-alias": 4096 },
          },
        },
        combos: {
          aliasCombo: {
            strategy: "failover",
            targets: [{ provider: "a", model: "m-alias" }],
          },
        },
      };

      // Case 1: child receives pause_turn after commit -> carried child -> parent -> no cooldown
      let childLogCaptured: RequestLogContext | undefined;
      let terminalRecorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined;
      let nativeTerminal: ((status: ResponsesTerminalStatus) => void) | undefined;
      const pausedParentLog: RequestLogContext = {
        model: "m-alias",
        provider: "combo",
        comboId: "aliasCombo",
      };
      const req1 = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/aliasCombo", stream: true }),
      });
      const budget1 = createTranslatorBudget();
      try {
        await executeComboResponses(
          req1,
          { model: "combo/aliasCombo", stream: true },
          "aliasCombo",
          cfg,
          pausedParentLog,
          {
            translatorBudget: budget1,
            setTerminalOutcomeRecorder: recorder => { terminalRecorder = recorder; },
          },
          {
            handleComboResponses: async () => { throw new Error("not expected"); },
            handleResponses: async (_req, _cfg, childLog, opts) => {
              childLogCaptured = childLog;
              nativeTerminal = opts.onNativePassthroughTerminal;
              childLog.usage = { inputTokens: 100, outputTokens: 4096 };
              if (childLog.activeAttempt) childLog.activeAttempt.usage = childLog.usage;
              opts.onFirstOutput?.();
              return new Response("ok", { status: 200 });
            },
          },
        );
      } finally {
        budget1.dispose();
      }

      // Mark the child context as paused after commit (simulating Anthropic pause_turn)
      expect(childLogCaptured).toBeDefined();
      rememberPausedTurn(childLogCaptured!);
      // Terminal arrives: trigger terminal recorder and simulate final log write
      inspectIncomplete(childLogCaptured!, "max_output_tokens");
      expect(nativeTerminal).toBeDefined();
      nativeTerminal!("incomplete");
      terminalRecorder?.("incomplete");
      addFinalRequestLog("ocx-test-paused", Date.now(), pausedParentLog, 200, { terminalStatus: "incomplete" }, () => {});
      expect(isComboTargetInCooldown("aliasCombo", { provider: "a", model: "m-alias" })).toBe(false);

      // Case 2: unpaused child reaching ceiling cools the alias target
      let unpausedChildLog: RequestLogContext | undefined;
      let unpausedTerminalRecorder: ((status: ResponsesTerminalStatus, httpStatusOverride?: number) => void) | undefined;
      const unpausedParentLog: RequestLogContext = {
        model: "m-alias",
        provider: "combo",
        comboId: "aliasCombo",
      };
      const req2 = new Request("http://localhost/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "combo/aliasCombo", stream: true }),
      });
      const budget2 = createTranslatorBudget();
      try {
        await executeComboResponses(
          req2,
          { model: "combo/aliasCombo", stream: true },
          "aliasCombo",
          cfg,
          unpausedParentLog,
          {
            translatorBudget: budget2,
            setTerminalOutcomeRecorder: recorder => { unpausedTerminalRecorder = recorder; },
          },
          {
            handleComboResponses: async () => { throw new Error("not expected"); },
            handleResponses: async (_req, _cfg, childLog, opts) => {
              unpausedChildLog = childLog;
              nativeTerminal = opts.onNativePassthroughTerminal;
              childLog.usage = { inputTokens: 100, outputTokens: 4096 };
              if (childLog.activeAttempt) childLog.activeAttempt.usage = childLog.usage;
              opts.onFirstOutput?.();
              return new Response("ok", { status: 200 });
            },
          },
        );
      } finally {
        budget2.dispose();
      }

      expect(unpausedChildLog).toBeDefined();
      // Unpaused: child is NOT marked with rememberPausedTurn
      inspectIncomplete(unpausedChildLog!, "max_output_tokens");
      expect(nativeTerminal).toBeDefined();
      nativeTerminal!("incomplete");
      unpausedTerminalRecorder?.("incomplete");
      addFinalRequestLog("ocx-test-unpaused", Date.now(), unpausedParentLog, 200, { terminalStatus: "incomplete" }, () => {});
      expect(isComboTargetInCooldown("aliasCombo", { provider: "a", model: "m-alias" })).toBe(true);
    } finally {
      registerCommittedTerminalCooldownHandler(undefined);
    }
  });

  test.each([[1024, false], [4096, true]] as const)("uses %i serving output tokens for cooldown and preserves aggregate accounting", (outputTokens, cooled) => {
    registerCommittedTerminalCooldownHandler(coolComboTargetForCommittedTerminal);
    try {
      const earlier = beginRequestAttempt(1, "b", "m2", "openai-responses");
      finishRequestAttempt(earlier, 502, 10, { inputTokens: 100, outputTokens: 3500 });
      const serving = beginRequestAttempt(2, "a", "m1", "openai-responses");
      const logCtx: RequestLogContext = {
        model: "m1", provider: "a", providerAdapter: "openai-responses",
        comboId: "free", comboTarget: first, comboTargetOutputCeiling: 4096,
        attempts: [earlier, serving], activeAttempt: serving,
        usage: { inputTokens: 100, outputTokens },
      };
      inspectIncomplete(logCtx, "max_output_tokens");
      const rows: RequestLogEntry[] = [];
      addFinalRequestLog("ocx-test-output-limit", Date.now(), logCtx, 200, { terminalStatus: "incomplete" }, row => rows.push(row));
      expect(rows[0]?.usage?.outputTokens).toBe(3500 + outputTokens);
      expect(rows[0]?.attempts?.at(-1)?.usage?.outputTokens).toBe(outputTokens);
      expect(isComboTargetInCooldown("free", first)).toBe(cooled);
    } finally {
      registerCommittedTerminalCooldownHandler(undefined);
    }
  });

  test("uses the redirected provider ceiling but cools the configured combo target", async () => {
    registerCommittedTerminalCooldownHandler(coolComboTargetForCommittedTerminal);
    const cfg = comboConfig();
    cfg.providers.a!.defaultMaxOutputTokens = 1024;
    cfg.providers.b!.defaultMaxOutputTokens = 4096;
    cfg.blockedModelRedirects = { "a/m1": "b/m2" };
    const budget = createTranslatorBudget();
    try {
      const payload = { model: "combo/free", stream: true };
      const req = new Request("http://localhost/v1/responses", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      const logCtx: RequestLogContext = { model: "free", provider: "combo", comboId: "free" };
      const response = await executeComboResponses(req, payload, "free", cfg, logCtx, { translatorBudget: budget }, {
        handleComboResponses: async () => { throw new Error("not expected"); },
        handleResponses: async (_req, _cfg, childLog, opts) => {
          childLog.usage = { inputTokens: 100, outputTokens: 4096 };
          opts.onFirstOutput?.();
          return new Response("ok");
        },
      });

      expect(await response.text()).toBe("ok");
      expect(logCtx.comboTargetOutputCeiling).toBe(4096);
      inspectIncomplete(logCtx, "max_output_tokens");
      addFinalRequestLog("ocx-test-redirect", Date.now(), logCtx, 200, { terminalStatus: "incomplete" }, () => {});
      expect(isComboTargetInCooldown("free", first)).toBe(true);
      expect(isComboTargetInCooldown("free", { provider: "b", model: "m2" })).toBe(false);
    } finally {
      budget.dispose();
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
        attempts: [attempt],
        activeAttempt: attempt,
      };
      inspectIncomplete(logCtx, "upstream_stall_timeout");
      addFinalRequestLog("ocx-test-stall", Date.now(), logCtx, 502, { terminalStatus: "incomplete" }, () => {});
      expect(attempt.status).toBe(502);
      expect(isComboTargetInCooldown("free", first, Date.now() + 30_000)).toBe(true);
    } finally {
      registerCommittedTerminalCooldownHandler(undefined);
    }
  });

  test.each([
    { eventReason: "upstream_stall_timeout", cooled: true },
    { responseReason: "upstream_stall_timeout", message: "Provider stream stopped", cooled: true },
    { eventReason: "max_output_tokens", message: "Provider reached its output limit", cooled: true },
    { responseReason: "max_output_tokens", message: "Provider reached its output limit", cooled: true },
    { eventReason: "content_filter", responseReason: "upstream_stall_timeout", cooled: false },
    { eventReason: "refusal", responseReason: "max_output_tokens", cooled: false },
    { eventReason: "max_output_tokens", responseReason: "refusal", cooled: false },
    { eventReason: "upstream_stall_timeout", responseReason: "content_filter", cooled: false },
    { responseReason: "max_output_tokens", eventCode: "content_policy_violation", cooled: false },
    { eventReason: "upstream_stall_timeout", responseCode: "content_filter", cooled: false },
    ...["content_filter", "adapter_eof", "provider_error", "stream_failed"].map(responseReason => ({
      eventReason: undefined, responseReason, cooled: false,
    })),
  ])("reports cooldown from terminal reasons independently of display copy (%j)", row => {
    const { eventReason, responseReason, message, eventCode, responseCode, cooled } = row;
    registerCommittedTerminalCooldownHandler(coolComboTargetForCommittedTerminal);
    try {
      const attempt = beginRequestAttempt(1, "a", "m1", "openai-responses");
      const logCtx: RequestLogContext = {
        model: "m1", provider: "a", providerAdapter: "openai-responses",
        comboId: "free", comboTarget: first, comboTargetOutputCeiling: 4096,
        attempts: [attempt], activeAttempt: attempt,
        usage: { inputTokens: 100, outputTokens: 4096 },
      };
      const terminal = {
        type: "response.incomplete",
        ...(eventReason ? { incomplete_details: { reason: eventReason } } : {}),
        ...(eventCode ? { error: { code: eventCode } } : {}),
        response: {
          status: "incomplete",
          ...(responseReason ? { incomplete_details: { reason: responseReason } } : {}),
          ...(message || responseCode ? { error: { message, code: responseCode } } : {}),
        },
      };
      inspectResponseLogSsePayloadParsed(logCtx, JSON.stringify(terminal), terminal);
      if (message) expect(logCtx.upstreamError).toBe(message);
      addFinalRequestLog("ocx-test-terminal-reason", Date.now(), logCtx, 200, { terminalStatus: "incomplete" }, () => {});
      expect(isComboTargetInCooldown("free", first)).toBe(cooled);
    } finally {
      registerCommittedTerminalCooldownHandler(undefined);
    }
  });
});
