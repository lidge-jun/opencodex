import { describe, expect, test } from "bun:test";
import { deriveCodexInjectionPlan } from "../../src/codex/inject/plan";
import { routingTarget } from "../../src/client/connect";
import type { OcxConfig } from "../../src/types";

describe("link Codex injection", () => {
  test("forces websocket support off for the local link routing target", () => {
    const plan = deriveCodexInjectionPlan("# existing config\n", {
      config: { port: 10100, websockets: true } as OcxConfig,
      routingTarget: routingTarget("http://127.0.0.1:34567", 10100),
      catalogPathOption: null,
      journalReadOnly: true,
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(`${plan.content}\n${plan.profileContent}`).toContain("base_url = \"http://localhost:10100/v1\"");
    expect(`${plan.content}\n${plan.profileContent}`).not.toContain("supports_websockets = true");
  });

  test("keeps websocket support for a localhost hub routing target", () => {
    const plan = deriveCodexInjectionPlan("# existing config\n", {
      config: { port: 10100, websockets: true } as OcxConfig,
      routingTarget: routingTarget("http://localhost:34567"),
      catalogPathOption: null,
      journalReadOnly: true,
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(`${plan.content}\n${plan.profileContent}`).toContain("base_url = \"http://localhost:34567/v1\"");
    expect(`${plan.content}\n${plan.profileContent}`).toContain("supports_websockets = true");
  });
});
