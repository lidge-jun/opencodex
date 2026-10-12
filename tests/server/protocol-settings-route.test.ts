/**
 * PATCH /api/protocols/settings (src/server/management/protocol-routes.ts): strict body, the
 * Messages close writes both keys in one save, the open writes only the surface, a failed save
 * leaves the live config as it was, and the answer is the fresh GET /api/protocols shape.
 */
import { describe, expect, test } from "bun:test";
import type { ManagementContext } from "../../src/server/management/context";
import { handleProtocolRoutes } from "../../src/server/management/protocol-routes";
import { parseProtocolSettingsPatch } from "../../src/server/management/protocol-settings-patch";
import type { OcxConfig } from "../../src/types";

interface Harness {
  config: OcxConfig;
  /** Snapshots of every persisted config; the real save is never reached. */
  saves: OcxConfig[];
  syncs: number;
  ctx: (body: unknown, method?: string) => ManagementContext;
}

function harness(extra: Record<string, unknown> = {}, save?: (config: OcxConfig) => void): Harness {
  const state: Harness = {
    config: { port: 10100, providers: {}, ...extra } as unknown as OcxConfig,
    saves: [],
    syncs: 0,
    ctx: (body, method = "PATCH") => {
      const url = new URL("http://127.0.0.1:10100/api/protocols/settings");
      const req = new Request(url, {
        method,
        body: typeof body === "string" ? body : JSON.stringify(body),
        headers: { "content-type": "application/json" },
      });
      return {
        req, url, config: state.config, version: "test",
        deps: {
          saveConfigPreservingClaudeCode: (config: OcxConfig) => {
            save?.(config);
            state.saves.push(structuredClone(config));
          },
        },
        syncClaudeAgentDefsBestEffort: async () => { state.syncs++; },
      } as unknown as ManagementContext;
    },
  };
  return state;
}

async function patch(h: Harness, body: unknown): Promise<Response> {
  const res = await handleProtocolRoutes(h.ctx(body));
  if (!res) throw new Error("route did not answer");
  return res;
}

describe("PATCH /api/protocols/settings", () => {
  test("closing Messages writes apiSurfaces and claudeCode in one save", async () => {
    const h = harness({ claudeCode: { enabled: true, model: "m" } });
    const res = await patch(h, { messagesEnabled: false });
    expect(res.status).toBe(200);
    expect(h.saves).toHaveLength(1);
    const saved = h.saves[0]!;
    expect(saved.apiSurfaces).toEqual({ messages: { enabled: false } });
    expect(saved.claudeCode?.enabled).toBe(false);
    expect(saved.claudeCode?.model).toBe("m");
    // The block writer shared with PUT /api/claude-code stamps the auth-mode sentinel.
    expect(typeof saved.claudeCode?.authModeMigratedAt).toBe("string");
    expect(h.syncs).toBe(1);
    const body = await res.json() as { schemaVersion: number; surfaces: { messages: unknown }; policyRevision: string };
    expect(body.schemaVersion).toBe(1);
    expect(body.surfaces.messages).toEqual({ enabled: false, source: "api-surfaces" });
    expect(typeof body.policyRevision).toBe("string");
  });

  test("closing Messages when Claude is already off leaves the claudeCode block alone", async () => {
    const h = harness({ claudeCode: { enabled: false } });
    expect((await patch(h, { messagesEnabled: false })).status).toBe(200);
    expect(h.saves[0]!.claudeCode).toEqual({ enabled: false });
    expect(h.syncs).toBe(0);
  });

  test("opening Messages writes only apiSurfaces", async () => {
    const h = harness({ claudeCode: { enabled: false } });
    const res = await patch(h, { messagesEnabled: true });
    expect(res.status).toBe(200);
    expect(h.saves[0]!.apiSurfaces).toEqual({ messages: { enabled: true } });
    expect(h.saves[0]!.claudeCode).toEqual({ enabled: false });
    expect(h.syncs).toBe(0);
    expect((await res.json() as { surfaces: { messages: unknown } }).surfaces.messages)
      .toEqual({ enabled: true, source: "api-surfaces" });
  });

  test("opening replaces a malformed surface value instead of merging into it", async () => {
    const h = harness({ apiSurfaces: { messages: "off" } });
    expect((await patch(h, { messagesEnabled: true })).status).toBe(200);
    expect(h.saves[0]!.apiSurfaces).toEqual({ messages: { enabled: true } });
  });

  test("policy and rollout switches merge into protocols", async () => {
    const h = harness({ protocols: { rollout: { directEncoders: true } } });
    const res = await patch(h, { unrepresentable: "reject", rollout: { shadowPlan: true } });
    expect(res.status).toBe(200);
    expect(h.saves[0]!.protocols).toEqual({ unrepresentable: "reject", rollout: { directEncoders: true, shadowPlan: true } });
    const body = await res.json() as { settings: { unrepresentable: string; rollout: Record<string, boolean> } };
    expect(body.settings.unrepresentable).toBe("reject");
    expect(body.settings.rollout).toMatchObject({ directEncoders: true, shadowPlan: true, nativeChatCombos: false });
  });

  test("the OAuth native-Messages switch cannot be turned on without the key-auth one", async () => {
    const h = harness();
    const res = await patch(h, { rollout: { managedMessagesNativeOAuth: true } });
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe("rollout_dependency");
    expect(h.saves).toHaveLength(0);
    expect(h.config.protocols).toBeUndefined();
  });

  test("a failed save restores the live config and reports a write failure", async () => {
    const h = harness({ claudeCode: { enabled: true } }, () => { throw new Error("disk full at /secret/path"); });
    const res = await patch(h, { messagesEnabled: false });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("write_failed");
    expect(text).not.toContain("/secret/path");
    expect(h.config.apiSurfaces).toBeUndefined();
    expect(h.config.claudeCode).toEqual({ enabled: true });
    expect(h.syncs).toBe(0);
  });

  test("lock contention answers 409", async () => {
    const busy = Object.assign(new Error("busy"), { code: "CONFIG_MUTATION_LOCK_UNAVAILABLE", cause: { code: "SQLITE_BUSY" } });
    const h = harness({}, () => { throw busy; });
    const res = await patch(h, { messagesEnabled: true });
    expect(res.status).toBe(409);
    expect(h.config.apiSurfaces).toBeUndefined();
  });

  test.each([
    ["invalid JSON", "{", "invalid_json"],
    ["a non-object body", [], "invalid_body"],
    ["an empty body", {}, "empty_body"],
    ["an unknown key", { messagesEnabled: true, claudeCode: { enabled: true } }, "unknown_field"],
    ["a string messagesEnabled", { messagesEnabled: "false" }, "invalid_messages_enabled"],
    ["an unknown policy", { unrepresentable: "drop" }, "invalid_unrepresentable"],
    ["a non-object rollout", { rollout: true }, "invalid_rollout"],
    ["an unknown rollout switch", { rollout: { turbo: true } }, "unknown_rollout_field"],
    ["a non-boolean rollout switch", { rollout: { shadowPlan: 1 } }, "invalid_rollout"],
  ])("rejects %s with 400 and writes nothing", async (_label, body, code) => {
    const h = harness({ claudeCode: { enabled: true } });
    const res = await patch(h, body);
    expect(res.status).toBe(400);
    expect((await res.json() as { error: { code: string } }).error.code).toBe(code);
    expect(h.saves).toHaveLength(0);
    expect(h.config.claudeCode).toEqual({ enabled: true });
  });

  test("errors name the field, never the submitted value", () => {
    const parsed = parseProtocolSettingsPatch({ unrepresentable: "secret-looking-value" });
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("secret-looking-value");
  });

  test("other methods fall through", async () => {
    const h = harness();
    expect(await handleProtocolRoutes(h.ctx({ messagesEnabled: true }, "PUT"))).toBeNull();
    expect(await handleProtocolRoutes(h.ctx({ messagesEnabled: true }, "POST"))).toBeNull();
    expect(h.saves).toHaveLength(0);
  });
});
