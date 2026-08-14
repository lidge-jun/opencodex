import { describe, expect, test, beforeEach } from "bun:test";
import {
  setPassiveRouteLinker,
  resolvePassiveRouteSubjectId,
  hasPassiveRouteLinker,
  resetPassiveRouteLinkerForTests,
} from "../src/server/passive-route-linker";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const config = {} as OcxConfig;
const routed = { baseUrl: "https://example.test" } as OcxProviderConfig;

describe("passive route linker slot", () => {
  beforeEach(() => resetPassiveRouteLinkerForTests());

  // The property the whole decoupling exists for: an install that never activates an
  // optional subsystem does no work on the request path.
  test("resolves to null with no linker registered", () => {
    expect(hasPassiveRouteLinker()).toBe(false);
    expect(resolvePassiveRouteSubjectId(config, "anthropic", "claude", routed, "responses")).toBeNull();
  });

  test("a registered linker receives the exact arguments and its value is returned", () => {
    const seen: unknown[] = [];
    setPassiveRouteLinker((c, provider, model, r, wire) => {
      seen.push(c, provider, model, r, wire);
      return "a".repeat(64);
    });
    expect(resolvePassiveRouteSubjectId(config, "anthropic", "claude", routed, "responses"))
      .toBe("a".repeat(64));
    expect(seen).toEqual([config, "anthropic", "claude", routed, "responses"]);
  });

  // Identity linkage is best-effort metadata: it must never surface as a request failure.
  test("a throwing linker yields null instead of propagating", () => {
    setPassiveRouteLinker(() => { throw new Error("subject construction failed"); });
    expect(() => resolvePassiveRouteSubjectId(config, "p", "m", routed, "responses")).not.toThrow();
    expect(resolvePassiveRouteSubjectId(config, "p", "m", routed, "responses")).toBeNull();
  });

  test("a linker returning null is passed through", () => {
    setPassiveRouteLinker(() => null);
    expect(resolvePassiveRouteSubjectId(config, "p", "m", routed, "responses")).toBeNull();
  });

  test("detach restores the null state", () => {
    const detach = setPassiveRouteLinker(() => "b".repeat(64));
    expect(hasPassiveRouteLinker()).toBe(true);
    detach();
    expect(hasPassiveRouteLinker()).toBe(false);
    expect(resolvePassiveRouteSubjectId(config, "p", "m", routed, "responses")).toBeNull();
  });

  // A stale detach belongs to a replaced registration and must not remove the live one.
  test("a stale detach after replacement is inert", () => {
    const staleDetach = setPassiveRouteLinker(() => "old".padEnd(64, "0"));
    setPassiveRouteLinker(() => "new".padEnd(64, "0"));
    staleDetach();
    expect(resolvePassiveRouteSubjectId(config, "p", "m", routed, "responses"))
      .toBe("new".padEnd(64, "0"));
  });
});

describe("core request path boundary", () => {
  // Guard 1 for this phase: the per-request module must not name Lab or the
  // compatibility layer at all. Driven red by restoring the old import.
  test("responses/core.ts does not import lab or routing/compatibility", async () => {
    const source = await Bun.file(new URL("../src/server/responses/core.ts", import.meta.url)).text();
    expect(source).not.toContain("routing/compatibility");
    expect(source).not.toContain('from "../../lab/');
    expect(source).not.toContain("resolveProductionRouteSubject");
    // ...and it does use the core slot instead.
    expect(source).toContain("resolvePassiveRouteSubjectId");
  });

  test("the Lab-side registration owns the subject construction", async () => {
    const source = await Bun.file(new URL("../src/lib/lab-passive-linker-registration.ts", import.meta.url)).text();
    expect(source).toContain("resolveProductionRouteSubject");
    expect(source).toContain("setPassiveRouteLinker");
  });
});
