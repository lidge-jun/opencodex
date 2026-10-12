import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The schema this exercises is reached through `src/config`, the entry the
// runtime evaluates first. Importing `config/schema/*` directly enters that
// module cycle from the wrong end and throws a TDZ ReferenceError.
import { loadConfig } from "../../src/config";
import {
  admissionModelDeniedBody,
  AdmissionModelDeniedError,
  admissionModelDeniedResponse,
  admissionModelScopeOf,
  assertRouteAllowedByScope,
  MODEL_NOT_ALLOWED_FOR_KEY,
  resolveAdmissionModelScope,
  routeAllowedByScope,
} from "../../src/server/admission-model-scope";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const KEY = "ocx_data_" + "a".repeat(40);
const OTHER_KEY = "ocx_data_" + "b".repeat(40);

const previousHome = process.env.OPENCODEX_HOME;
const homes: string[] = [];

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  for (const home of homes.splice(0)) removeTreeWithRetry(home);
});

/** Load a hand-written config.json the way a startup would, and report the keys that survived. */
function loadKeysFrom(apiKeys: unknown[]): string[] {
  const home = mkdtempSync(join(tmpdir(), "ocx-key-scope-"));
  homes.push(home);
  process.env.OPENCODEX_HOME = home;
  writeFileSync(join(home, "config.json"), JSON.stringify({
    port: 10100,
    defaultProvider: "allowed",
    providers: { allowed: { adapter: "openai-chat", baseUrl: "https://allowed.test/v1", models: ["small"] } },
    apiKeys,
  }));
  return (loadConfig().apiKeys ?? []).map(entry => entry.name);
}

function configWithKey(scope: { allowedProviders?: string[]; allowedModels?: string[] }): Pick<OcxConfig, "apiKeys"> {
  return {
    apiKeys: [
      { id: "scoped", name: "mail", key: KEY, createdAt: "2026-01-01T00:00:00.000Z", ...scope },
      { id: "open", name: "coding", key: OTHER_KEY, createdAt: "2026-01-01T00:00:00.000Z" },
    ],
  };
}

describe("per-key model and provider scope", () => {
  test("a key with neither list is unrestricted", () => {
    expect(admissionModelScopeOf({})).toBeUndefined();
    expect(admissionModelScopeOf({ allowedProviders: [], allowedModels: [] })).toBeUndefined();
    expect(routeAllowedByScope(undefined, { providerName: "xai", modelId: "grok-4.6" })).toBe(true);
  });

  test("only a configured key carries a scope", () => {
    const config = configWithKey({ allowedProviders: ["zai-discount"] });
    expect(resolveAdmissionModelScope(config, { kind: "configured", keyId: "scoped", source: "bearer" }))
      .toEqual({ providers: ["zai-discount"], models: [] });
    // The environment token and loopback have no stored record to attach a
    // scope to, so narrowing them would be inventing a policy nobody wrote.
    expect(resolveAdmissionModelScope(config, { kind: "environment", source: "bearer" })).toBeUndefined();
    expect(resolveAdmissionModelScope(config, { kind: "loopback", source: "loopback" })).toBeUndefined();
    expect(resolveAdmissionModelScope(config, undefined)).toBeUndefined();
    expect(resolveAdmissionModelScope(config, { kind: "configured", keyId: "open", source: "bearer" })).toBeUndefined();
  });

  test("the two lists are independent conditions and both must hold", () => {
    const scope = admissionModelScopeOf({ allowedProviders: ["zai-discount"], allowedModels: ["glm-5.3-flash"] })!;
    expect(routeAllowedByScope(scope, { providerName: "zai-discount", modelId: "glm-5.3-flash" })).toBe(true);
    // The allowed model on a forbidden provider is exactly what a combo child or
    // a policy fallback reaches while the requested selector never changes.
    expect(routeAllowedByScope(scope, { providerName: "openrouter", modelId: "glm-5.3-flash" })).toBe(false);
    // The allowed provider carrying a forbidden model is the mirror case.
    expect(routeAllowedByScope(scope, { providerName: "zai-discount", modelId: "grok-4.6" })).toBe(false);
  });

  test("a model entry matches bare or fully qualified, and folds case and spacing", () => {
    const scope = admissionModelScopeOf({ allowedModels: ["  ZAI-Discount/GLM-5.3-Flash  "] })!;
    expect(routeAllowedByScope(scope, { providerName: "zai-discount", modelId: "glm-5.3-flash" })).toBe(true);
    // Pinned to that provider: the same model elsewhere is a different destination.
    expect(routeAllowedByScope(scope, { providerName: "openrouter", modelId: "glm-5.3-flash" })).toBe(false);
    const bare = admissionModelScopeOf({ allowedModels: ["glm-5.3-flash"] })!;
    expect(routeAllowedByScope(bare, { providerName: "openrouter", modelId: "glm-5.3-flash" })).toBe(true);
  });

  test("an alias is judged by what it resolves to, not by the name the client sent", () => {
    // The defect this guards: a bare alias names neither the provider nor the
    // model, so a scope checked against the caller's string has nothing to
    // match on and would authorize a destination it never saw.
    const config = {
      port: 10100,
      defaultProvider: "allowed",
      providers: {
        allowed: { adapter: "openai-chat", baseUrl: "https://allowed.test/v1", models: ["small"] },
        forbidden: {
          adapter: "openai-chat", baseUrl: "https://forbidden.test/v1",
          models: ["expensive"], modelAliases: { expensive: "cheap" },
        },
      },
    } as unknown as OcxConfig;
    const scope = admissionModelScopeOf({ allowedProviders: ["allowed"] })!;

    const routed = routeModel(config, "cheap");
    expect(routed).toMatchObject({ providerName: "forbidden", modelId: "expensive" });
    expect(routeAllowedByScope(scope, routed)).toBe(false);
    expect(() => assertRouteAllowedByScope(scope, "cheap", routed)).toThrow(AdmissionModelDeniedError);

    const permitted = routeModel(config, "allowed/small");
    expect(() => assertRouteAllowedByScope(scope, "allowed/small", permitted)).not.toThrow();
  });

  test("a refusal is 403 and names the caller's own selector", () => {
    const error = new AdmissionModelDeniedError("gldf-flash", { providerName: "xai", modelId: "grok-4.6" });
    const body = admissionModelDeniedBody(error);
    expect(body.error.type).toBe(MODEL_NOT_ALLOWED_FOR_KEY);
    // The client learns which of its own requests was refused. A key that may
    // not reach xai has no business learning that its alias points there.
    expect(body.error.model).toBe("gldf-flash");
    expect(JSON.stringify(body)).not.toContain("grok-4.6");
    const response = admissionModelDeniedResponse(error);
    // 403, not 404: the key authenticated and simply may not go there, and a
    // 404 would tell the client its credential is wrong and invite a retry.
    expect(response.status).toBe(403);
  });

  test("a malformed scope drops the key instead of widening it", () => {
    const scoped = { key: KEY, id: "scoped", name: "mail", createdAt: "2026-01-01T00:00:00.000Z", allowedProviders: ["zai-discount"] };
    const open = { key: OTHER_KEY, id: "open", name: "coding", createdAt: "2026-01-01T00:00:00.000Z" };
    expect(loadKeysFrom([scoped, open])).toEqual(["mail", "coding"]);

    // Every other field on this record degrades to a default. These two must
    // not: degrading a damaged permission field reads as "allowed everything",
    // which is the one direction it can never fail. The damaged key is dropped
    // and its still-valid neighbour survives, so one bad record does not take
    // the whole array with it.
    for (const damaged of [
      { ...scoped, allowedProviders: "zai-discount" },
      { ...scoped, allowedProviders: [""] },
      { ...scoped, allowedModels: [123] },
      { ...scoped, allowedModels: ["x".repeat(257)] },
    ]) {
      expect(loadKeysFrom([damaged, open])).toEqual(["coding"]);
    }

    // A degrading neighbour still degrades, so the fail-closed choice is scoped
    // to the permission fields rather than hardening the whole record.
    expect(loadKeysFrom([{ ...scoped, name: 7 }, open])).toHaveLength(2);
  });
});
