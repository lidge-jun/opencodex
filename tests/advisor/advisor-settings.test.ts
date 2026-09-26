import { describe, expect, test } from "bun:test";
import {
  ADVISOR_EFFORTS,
  advisorRunnable,
  isValidAdvisorEffort,
  isValidAdvisorPolicy,
  resolveAdvisorSettings,
} from "../../src/advisor/settings";

describe("resolveAdvisorSettings", () => {
  test("absent config resolves to fully disabled defaults", () => {
    const settings = resolveAdvisorSettings({});
    expect(settings.enabled).toBe(false);
    expect(settings.model).toBe("");
    expect(settings.effort).toBe("max");
    expect(settings.policy).toBe("manual");
    expect(settings.sources.enabled).toBe("default");
    expect(advisorRunnable(settings)).toBe(false);
  });

  test("malformed block degrades to defaults instead of throwing", () => {
    expect(resolveAdvisorSettings({ advisor: "yes" as never }).enabled).toBe(false);
    expect(resolveAdvisorSettings({ advisor: null as never }).policy).toBe("manual");
    expect(resolveAdvisorSettings({ advisor: { enabled: "true" } as never }).enabled).toBe(false);
  });

  test("enabled without a model is not runnable", () => {
    const settings = resolveAdvisorSettings({ advisor: { enabled: true } });
    expect(settings.enabled).toBe(true);
    expect(advisorRunnable(settings)).toBe(false);
  });

  test("enabled with a model is runnable and sources are configured", () => {
    const settings = resolveAdvisorSettings({
      advisor: { enabled: true, model: "gpt-6-astra", effort: "high", policy: "preflight" },
    });
    expect(advisorRunnable(settings)).toBe(true);
    expect(settings.model).toBe("gpt-6-astra");
    expect(settings.effort).toBe("high");
    expect(settings.policy).toBe("preflight");
    expect(settings.sources).toEqual({
      enabled: "configured",
      model: "configured",
      effort: "configured",
      policy: "configured",
    });
  });

  test("malformed effort and policy fall back per-field", () => {
    const settings = resolveAdvisorSettings({
      advisor: { enabled: true, model: "xai/grok-5", effort: "ultra-plus" as never, policy: "auto" as never },
    });
    expect(settings.effort).toBe("max");
    expect(settings.policy).toBe("manual");
    expect(settings.sources.effort).toBe("default");
    expect(settings.sources.policy).toBe("default");
    expect(settings.sources.model).toBe("configured");
  });

  test("model whitespace is trimmed", () => {
    expect(resolveAdvisorSettings({ advisor: { model: "  anthropic/claude-sonnet-4-6  " } }).model)
      .toBe("anthropic/claude-sonnet-4-6");
  });

  test("effort ladder matches the canonical levels", () => {
    expect([...ADVISOR_EFFORTS]).toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
    expect(isValidAdvisorEffort("max")).toBe(true);
    expect(isValidAdvisorEffort("minimal")).toBe(false);
    expect(isValidAdvisorPolicy("preflight")).toBe(true);
    expect(isValidAdvisorPolicy("adaptive")).toBe(false);
  });

  test("timeoutMs is bounded to a sane window", () => {
    expect(resolveAdvisorSettings({ advisor: { timeoutMs: 100 } }).timeoutMs).toBe(120_000);
    expect(resolveAdvisorSettings({ advisor: { timeoutMs: 5_000 } }).timeoutMs).toBe(5_000);
    expect(resolveAdvisorSettings({ advisor: { timeoutMs: 10_000_000 } }).timeoutMs).toBe(600_000);
  });
});
