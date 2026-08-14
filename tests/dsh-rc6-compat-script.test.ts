import { describe, expect, test } from "bun:test";
import {
  DSH_E2E_TOOL_CALLS,
  DSH_RC6_VERSION,
  assertExpectedDshVersion,
  buildDshChildEnv,
  hasExpectedDshToolOutputs,
  renderDshSettings,
} from "../scripts/dsh-rc6-compat-e2e";

describe("optional DSH rc.6 compatibility E2E helpers", () => {
  test("pins the exact developer-preview version", () => {
    expect(DSH_RC6_VERSION).toBe("0.1.0-rc.6");
    expect(() => assertExpectedDshVersion("0.1.0-rc.6\n")).not.toThrow();
    expect(() => assertExpectedDshVersion("0.1.0-rc.7\n")).toThrow("expected DSH 0.1.0-rc.6");
  });

  test("renders only a loopback OpenCodex endpoint into the checked-in template", () => {
    const template = [
      "agent-default-model:",
      "  model: dsh-e2e-reasoner",
      "llm-pi-ai:",
      "  providers:",
      "    opencodex:",
      "      baseURL: __OCX_BASE_URL__",
    ].join("\n");

    const rendered = renderDshSettings(template, "http://127.0.0.1:18181/v1");
    expect(rendered).toContain("baseURL: http://127.0.0.1:18181/v1");
    expect(rendered).not.toContain("__OCX_BASE_URL__");
    expect(() => renderDshSettings(template, "https://gateway.example/v1"))
      .toThrow("loopback OpenCodex URL");
    expect(() => renderDshSettings(template.replace("__OCX_BASE_URL__", "already-set"), "http://localhost:18181/v1"))
      .toThrow("exactly one __OCX_BASE_URL__ placeholder");
  });

  test("isolates DSH state and strips proxy and provider credentials", () => {
    const env = buildDshChildEnv({
      PATH: "/test/bin",
      HOME: "/real/home",
      DSH_HOME: "/real/dsh",
      HTTP_PROXY: "http://proxy.invalid",
      HTTPS_PROXY: "http://proxy.invalid",
      ALL_PROXY: "socks://proxy.invalid",
      OPENAI_API_KEY: "must-not-leak",
      ANTHROPIC_API_KEY: "must-not-leak",
      DEEPSEEK_API_KEY: "must-not-leak",
      UNRELATED_FLAG: "kept",
    }, {
      home: "/tmp/dsh-e2e-home",
      dshHome: "/tmp/dsh-e2e-dsh",
    });

    expect(env).toMatchObject({
      PATH: "/test/bin",
      HOME: "/tmp/dsh-e2e-home",
      DSH_HOME: "/tmp/dsh-e2e-dsh",
      DSH_TELEMETRY_DISABLED: "1",
      NO_PROXY: "127.0.0.1,localhost,::1",
      UNRELATED_FLAG: "kept",
    });
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.ALL_PROXY).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  test("requires two distinct parallel tool outputs correlated by call id", () => {
    expect(new Set(DSH_E2E_TOOL_CALLS.map(call => call.callId)).size).toBe(2);
    const matching = DSH_E2E_TOOL_CALLS.map(call => ({
      type: "function_call_output",
      call_id: call.callId,
      output: `${call.marker}\n`,
    }));
    expect(hasExpectedDshToolOutputs(matching)).toBe(true);
    expect(hasExpectedDshToolOutputs(matching.slice(0, 1))).toBe(false);
    expect(hasExpectedDshToolOutputs(matching.map((item, index) => ({
      ...item,
      output: matching[(index + 1) % matching.length]!.output,
    })))).toBe(false);
  });
});
