import { expect, test } from "bun:test";
import { codexPoolAffinityKey } from "../../src/codex/auth-context";
import { getDefaultConfig } from "../../src/config";
import { routeConcreteModel } from "../../src/router";
import { codexRouteCredentialDomainHeaders } from "../../src/server/responses/core-auth";
import { applyClaudeBridgePoolSession, completeClaudeBridgePoolIdentity, resolveClaudeBridgePoolSession } from "../../src/server/claude-bridge-pool-session";
import type { DataPlaneAdmission } from "../../src/server/auth-cors";

const local: DataPlaneAdmission = { kind: "loopback", source: "loopback" };
const remote = (principal?: string): DataPlaneAdmission => ({ kind: "configured", keyId: "fixture", source: "bearer", contextPrincipalId: principal });
const resolve = (headers: Record<string, string> = {}, admission: DataPlaneAdmission | undefined = local, metadataSessionId?: string, replay = new Headers(headers)) =>
  resolveClaudeBridgePoolSession({ ingress: new Headers(headers), replay, admission, metadataSessionId });

test("admission, spawn and explicit lineage gate synthesis", () => {
  expect(resolveClaudeBridgePoolSession({ ingress: new Headers({ session_id: "alias" }), replay: new Headers() })).toBeUndefined();
  expect(resolveClaudeBridgePoolSession({ ingress: new Headers(), replay: new Headers(), metadataSessionId: "metadata" })).toBeUndefined();
  for (const marker of [{ "x-openai-subagent": "collab_spawn" }, { "x-codex-turn-metadata": '{"subagent_kind":"thread_spawn"}' }]) {
    expect(resolve(marker, local, "metadata")).toBeUndefined();
    expect(resolve({}, local, "metadata", new Headers(marker))).toBeUndefined();
  }
  for (const name of ["thread-id", "x-codex-parent-thread-id"]) for (const value of ["", "parent"]) {
    expect(resolve({ [name]: value }, local, "metadata")).toBeUndefined();
  }
  expect(resolve({}, local, "metadata", new Headers({ "session-id": "existing", "thread-id": "existing" }))).toBeUndefined();
});

test("aliases take precedence and conflicts or invalid values block derivation", () => {
  // An alias names the same keyed identity a derived value of the same text would in that scope.
  const alias = resolve({}, local, "alias");
  for (const headers of [{ session_id: "alias" }, { "session-id": "alias" }, { session_id: "alias", "session-id": "alias" }, { session_id: "", "session-id": "alias" }]) expect(resolve(headers, local, "metadata")).toBe(alias);
  for (const headers of [{ session_id: "a", "session-id": "b" }, { session_id: "" }, { session_id: "bad value", "session-id": "valid" }, { session_id: "bad value" }]) expect(resolve(headers, local, "metadata")).toBeUndefined();
});

test("derived metadata and header identities are keyed per admission scope", () => {
  const loopback = resolve({}, local, "metadata");
  expect(loopback).toMatch(/^[0-9a-f]{64}$/);
  expect(loopback).not.toBe("metadata");
  expect(resolve({}, local, "metadata")).toBe(loopback);
  const a = resolve({}, remote("a"), "metadata");
  expect(a).toMatch(/^[0-9a-f]{64}$/);
  expect(resolve({}, remote("a"), "metadata")).toBe(a);
  expect(resolve({}, remote("b"), "metadata")).not.toBe(a);
  expect(a).not.toBe(loopback);
  expect(resolve({}, remote(), "metadata")).toBeUndefined();
  expect(resolve({ "x-claude-code-session-id": "header" })).toBe(resolve({}, local, "header"));
  expect(resolve({ "x-claude-code-session-id": "header" }, remote("a"))).toMatch(/^[0-9a-f]{64}$/);
  expect(resolve({ "x-claude-code-session-id": "bad value" })).toBeUndefined();
  expect(resolve({ "prompt_cache_key": "shared-system" })).toBeUndefined();
});

test("caller aliases are keyed to their principal and never computable from public inputs", () => {
  const publicDigest = (principal: string, value: string) => new Bun.CryptoHasher("sha256")
    .update(JSON.stringify(["opencodex-caller-session-v1", principal, value])).digest("hex");
  for (const name of ["session_id", "session-id"]) {
    const a = resolve({ [name]: "fixture-alias" }, remote("a"), "metadata");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(publicDigest("a", "fixture-alias"));
    expect(resolve({ [name]: "fixture-alias" }, remote("a"), "metadata")).toBe(a);
    expect(resolve({ [name]: "fixture-alias" }, remote("b"), "metadata")).not.toBe(a);
    expect(resolve({ [name]: "fixture-alias" }, remote(), "metadata")).toBeUndefined();
    expect(resolve({ [name]: "fixture-alias" }, local, "metadata")).not.toBe("fixture-alias");
  }
  // A caller that knows another principal's derived identity cannot reuse it as an alias.
  const victim = resolve({}, remote("b"), "metadata")!;
  expect(resolve({ session_id: victim }, remote("a"))).not.toBe(victim);
});

test("completion agrees with final credential-domain headers for both Codex routes", () => {
  const config = getDefaultConfig();
  const route = routeConcreteModel(config, "openai/gpt-5.4")!;
  const headers = new Headers();
  const options = { claudeBridgePoolSession: "conversation" };
  expect(applyClaudeBridgePoolSession(headers, { codexAccountMode: undefined }, options)).toBe(headers);
  const complete = completeClaudeBridgePoolIdentity(headers, options);
  const key = codexPoolAffinityKey(complete);
  expect(key).toBeDefined();
  const req = new Request("http://localhost/v1/responses", { headers });
  for (const [mode, rewrite] of [["pool", false], ["direct", true]] as const) {
    const codexRoute = { ...route, codexAccountMode: mode };
    expect(codexPoolAffinityKey(codexRouteCredentialDomainHeaders(req, codexRoute, options, rewrite, config))).toBe(key);
  }
  expect(completeClaudeBridgePoolIdentity(complete, options)).toBe(complete);
});
