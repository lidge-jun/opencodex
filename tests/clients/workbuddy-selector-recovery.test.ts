import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { agentConfigPath } from "../../src/clients/config-export/agent-clients";
import { previewIntegration } from "../../src/integrations/mutation-plan";
import { readIntegrationState } from "../../src/integrations/state";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, refreshIntegration, restoreIntegration, type IntegrationWriteInput } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const config = { hostname: "127.0.0.1", port: 10100, defaultProvider: "mock", providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1", allowPrivateNetwork: true } } } as OcxConfig;
const model = (id: string) => ({ namespaced: `mock/${id}`, provider: "mock", id });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) removeTreeWithRetry(root); });

function fixture(clientId: "workbuddy" | "workbuddy-ai", arrayRoot: boolean) {
  const home = mkdtempSync(join(tmpdir(), "ocx-workbuddy-selector-")); roots.push(home);
  const path = agentConfigPath(clientId, {}, home); mkdirSync(dirname(path), { recursive: true });
  const foreign = { id: "mock/foreign", name: "Keep", vendor: "Other" };
  const original = arrayRoot ? [foreign] : { theme: "dark", models: [foreign] };
  const before = JSON.stringify(original, null, 4) + "\n"; writeFileSync(path, before);
  const store = createIntegrationStateStore(join(home, "store"));
  const input: IntegrationWriteInput = { clientId, config, port: 10100, models: [model("a")], home, env: {}, store };
  // A newly visible valid ID collides with a foreign row as well as the invalid ID.
  const invalid = { ...input, models: [model("a]"), model("foreign")] };
  const read = () => JSON.parse(readFileSync(path, "utf8"));
  const rows = () => arrayRoot ? read() : read().models;
  return { path, original, before, store, input, invalid, read, rows };
}

for (const client of ["workbuddy", "workbuddy-ai"] as const) for (const arrayRoot of [false, true]) {
  test(`${client} (${arrayRoot ? "array" : "object"}) refuses an unaddressable catalog without writes or thrown status`, () => {
    const f = fixture(client, arrayRoot);
    expect(readIntegrationState(f.invalid).state).toBe("absent");
    const plan = previewIntegration(f.invalid, { operation: "apply" });
    expect(plan.canApply).toBe(false);
    const refused = applyIntegration(f.invalid);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe("unsafe");
      expect(refused.message).toContain("selector");
      expect(refused.message).not.toContain("mock/a]");
    }
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
    expect(f.store.listOperations(client)).toEqual([]);
  });

  test(`${client} (${arrayRoot ? "array" : "object"}) disables recorded rows despite today's unaddressable catalog`, () => {
    const f = fixture(client, arrayRoot);
    expect(applyIntegration(f.input).ok).toBe(true);
    expect(readIntegrationState(f.invalid).state).toBe("stale");
    const applied = readFileSync(f.path, "utf8");
    expect(refreshIntegration(f.invalid).ok).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(applied);
    expect(previewIntegration(f.invalid, { operation: "disable" }).canApply).toBe(true);
    expect(disableIntegration(f.invalid).ok).toBe(true);
    expect(f.read()).toEqual(f.original);
    expect(readIntegrationState(f.invalid).state).toBe("absent");
  });

  test(`${client} (${arrayRoot ? "array" : "object"}) retains foreign-edit protection and byte-exact Undo with an unaddressable catalog`, () => {
    const f = fixture(client, arrayRoot);
    expect(applyIntegration(f.input).ok).toBe(true);
    const opId = f.store.listOperations(client)[0]!.opId;
    const document = f.read();
    (arrayRoot ? document : document.models).find((row: { id: string }) => row.id === "mock/a").name = "User edit";
    const edited = JSON.stringify(document); writeFileSync(f.path, edited);
    expect(readIntegrationState(f.invalid).state).toBe("conflict");
    expect(disableIntegration(f.invalid).ok).toBe(false);
    expect(readFileSync(f.path, "utf8")).toBe(edited);
    expect(restoreIntegration({ ...f.invalid, opId, confirmDrift: true }).ok).toBe(true);
    expect(readFileSync(f.path, "utf8")).toBe(f.before);
  });
}
