import { describe, expect, test } from "bun:test";
import { deriveCodexInjectionPlan } from "../../src/codex/inject/plan";
import { standaloneCodexRoutingTarget } from "../../src/codex/inject/routing-target";
import { routingTarget } from "../../src/client/connect";
import type { OcxConfig } from "../../src/types";

function plan(source: string, target: ReturnType<typeof routingTarget>) {
  const derived = deriveCodexInjectionPlan(source, {
    config: { port: 10100, websockets: true } as OcxConfig,
    routingTarget: target,
    catalogPathOption: null,
    journalReadOnly: true,
  });
  expect(derived.kind).toBe("ok");
  if (derived.kind !== "ok") throw new Error("plan refused");
  return derived;
}

describe("link Codex injection", () => {
  test("writes the standalone root form: 127.0.0.1 base and realtime URLs, no provider table or env_key", () => {
    const link = plan("# existing config\n", routingTarget("http://127.0.0.1:34567", 10100));
    const written = `${link.content}\n${link.profileContent}`;
    expect(link.content).toContain("openai_base_url = \"http://127.0.0.1:10100/v1\"");
    expect(link.content).toContain("experimental_realtime_ws_base_url");
    expect(link.providerTableMode).toBe(false);
    expect(written).not.toContain("env_key");
    expect(written).not.toContain("model_provider = \"opencodex\"");
    expect(written).not.toContain("localhost:10100");
    expect(written).not.toContain("supports_websockets = true");
    // For the same port the join writes exactly the bytes the standalone injection writes.
    const standalone = plan("# existing config\n", standaloneCodexRoutingTarget(10100, { hostname: "127.0.0.1" }));
    expect(link.content).toBe(standalone.content);
  });

  test("rebuilds an earlier env_key link table into the root form", () => {
    const legacy = plan("# existing config\n", { baseUrl: "http://localhost:10100/v1", requiresAdmissionToken: true, tokenEnv: "OPENCODEX_API_AUTH_TOKEN", link: true } as ReturnType<typeof routingTarget>);
    expect(legacy.content).toContain("env_key");
    const rebuilt = plan(legacy.content, routingTarget("http://127.0.0.1:34567", 10100));
    expect(rebuilt.content).toContain("openai_base_url = \"http://127.0.0.1:10100/v1\"");
    expect(rebuilt.content).not.toContain("env_key");
    expect(rebuilt.content).not.toContain("model_provider = \"opencodex\"");
  });

  test("keeps websocket support for a localhost hub routing target", () => {
    const hub = plan("# existing config\n", routingTarget("http://localhost:34567"));
    expect(`${hub.content}\n${hub.profileContent}`).toContain("base_url = \"http://localhost:34567/v1\"");
    expect(`${hub.content}\n${hub.profileContent}`).toContain("supports_websockets = true");
  });
});
