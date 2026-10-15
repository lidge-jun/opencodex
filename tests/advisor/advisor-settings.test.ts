import { describe, expect, test } from "bun:test";
import { handleAdvisorCommand } from "../../src/cli/advisor";
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
    expect(settings.contextSharingConsent).toBeNull();
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

  test("enabled with a model but no consent is not runnable", () => {
    const settings = resolveAdvisorSettings({
      advisor: { enabled: true, model: "gpt-6-astra", effort: "high", policy: "preflight" },
    });
    expect(advisorRunnable(settings)).toBe(false);
    expect(settings.contextSharingConsent).toBeNull();
  });

  test("enabled with a model and current consent is runnable", () => {
    const settings = resolveAdvisorSettings({
      advisor: {
        enabled: true,
        model: "gpt-6-astra",
        effort: "high",
        policy: "preflight",
        contextSharingConsent: "v1",
      },
    });
    expect(advisorRunnable(settings)).toBe(true);
    expect(settings.model).toBe("gpt-6-astra");
    expect(settings.effort).toBe("high");
    expect(settings.policy).toBe("preflight");
    expect(settings.contextSharingConsent).toBe("v1");
    expect(settings.sources).toEqual({
      enabled: "configured",
      model: "configured",
      effort: "configured",
      policy: "configured",
      contextSharingConsent: "configured",
    });
  });

  test("stale or wrong-typed consent does not become current and is not upgraded", () => {
    for (const contextSharingConsent of ["v0", "V1", true, 1, ""]) {
      const settings = resolveAdvisorSettings({
        advisor: { enabled: true, model: "gpt-6-astra", contextSharingConsent: contextSharingConsent as never },
      });
      expect(settings.contextSharingConsent).toBeNull();
      expect(advisorRunnable(settings)).toBe(false);
      expect(settings.sources.contextSharingConsent).toBe("configured");
    }
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

describe("ocx advisor consent", () => {
  const depsWith = (requests: Array<{ path: string; method: string; body: unknown }>, current: unknown = null) => ({
    baseUrl: "http://proxy.test",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body });
      if ((init?.method ?? "GET") === "GET") {
        return Response.json({ settings: { contextSharingConsent: current }, runnable: false });
      }
      return Response.json({ settings: body, runnable: body?.contextSharingConsent === "v1" && body?.enabled === true });
    },
  });

  test("on without consent prints the disclosure and does not enable", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const errors: string[] = [];
    const original = console.error;
    console.error = (line?: unknown) => { errors.push(String(line)); };
    try {
      expect(await handleAdvisorCommand(["on", "--json"], depsWith(requests))).toBe(2);
    } finally {
      console.error = original;
    }
    expect(requests).toEqual([{ path: "/api/advisor/settings", method: "GET", body: null }]);
    expect(errors.join("\n")).toContain("Task content is not secret-redacted");
    expect(errors.join("\n")).toContain("--ack-context-sharing");
  });

  test("on --ack-context-sharing records v1 and enables, with disclosure on stderr", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const errors: string[] = [];
    const original = console.error;
    console.error = (line?: unknown) => { errors.push(String(line)); };
    try {
      expect(await handleAdvisorCommand(["on", "--ack-context-sharing", "--json"], depsWith(requests))).toBe(0);
    } finally {
      console.error = original;
    }
    expect(requests[1]).toEqual({
      path: "/api/advisor/settings",
      method: "PUT",
      body: { enabled: true, contextSharingConsent: "v1" },
    });
    expect(errors.join("\n")).toContain("which may differ from the worker provider");
  });

  test("off --ack-context-sharing is refused and does not PUT", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    expect(await handleAdvisorCommand(["off", "--ack-context-sharing", "--json"], depsWith(requests))).toBe(2);
    expect(requests).toHaveLength(0);
  });

  test("on with existing consent enables without writing a new grant", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    expect(await handleAdvisorCommand(["on", "--json"], depsWith(requests, "v1"))).toBe(0);
    expect(requests[1]).toEqual({
      path: "/api/advisor/settings",
      method: "PUT",
      body: { enabled: true },
    });
  });

  test("consent records v1 and revoke removes it; set does not grant consent", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    expect(await handleAdvisorCommand(["consent", "--json"], depsWith(requests))).toBe(0);
    expect(await handleAdvisorCommand(["consent", "--revoke", "--json"], depsWith(requests))).toBe(0);
    expect(await handleAdvisorCommand(["set", "--model", "expert/m", "--json"], depsWith(requests))).toBe(0);
    expect(requests.map(request => request.body)).toEqual([
      { contextSharingConsent: "v1" },
      { contextSharingConsent: null },
      { model: "expert/m" },
    ]);
  });
});

describe("ocx advisor set — clearing the model", () => {
  const depsWith = (requests: Array<{ path: string; method: string; body: unknown }>) => ({
    baseUrl: "http://proxy.test",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", body });
      return Response.json({ settings: { model: "" }, runnable: false, warning: "advisor_enabled_without_model" });
    },
  });

  test("an explicitly empty --model is forwarded as the clear operation", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    expect(await handleAdvisorCommand(["set", "--model", "", "--json"], depsWith(requests))).toBe(0);
    expect(requests).toEqual([
      { path: "/api/advisor/settings", method: "PUT", body: { model: "" } },
    ]);
  });

  test("other valued flags still require a value", async () => {
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    const deps = depsWith(requests);
    expect(await handleAdvisorCommand(["set", "--effort", "", "--json"], deps)).toBe(2);
    expect(await handleAdvisorCommand(["set", "--model"], deps)).toBe(2);
    expect(await handleAdvisorCommand(["set", "--timeout-ms", "", "--json"], deps)).toBe(2);
    // Not one of them reached the settings route.
    expect(requests).toHaveLength(0);
  });
});
