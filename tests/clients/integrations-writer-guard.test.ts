import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportModel } from "../../src/clients/config-export";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import {
  applyIntegrationCoordinated, disableIntegrationCoordinated, overwriteIntegrationCoordinated,
  refreshIntegrationCoordinated, restoreIntegrationCoordinated, type IntegrationWriteInput, type WriteOutcome,
} from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const models: ExportModel[] = [{ namespaced: "mock/alpha", provider: "mock", id: "alpha", contextWindow: 128_000 }];
const config = { port: 12345, hostname: "127.0.0.1", defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "https://fixture.invalid/v1" } } } as OcxConfig;
const paths = ["no-lock", "absent-home", "locked"] as const;
let root: string;
let home: string;
let store: IntegrationStateStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-writer-guard-"));
  home = join(root, "home");
  mkdirSync(home);
  store = createIntegrationStateStore(join(root, "state", "integrations"));
});
afterEach(() => removeTreeWithRetry(root));

function input(path: typeof paths[number]): IntegrationWriteInput {
  const clientId = path === "no-lock" ? "pi" : "commandcode";
  const spec = INTEGRATION_CLIENTS[clientId];
  if (path !== "absent-home") {
    mkdirSync(spec.detectDir({}, home), { recursive: true });
    mkdirSync(dirname(spec.configPath({}, home)), { recursive: true });
    writeFileSync(spec.configPath({}, home), "{}\n");
  }
  return { clientId, models, config, port: 12345, env: {}, home, store };
}

function refusal(frozen: IntegrationWriteInput): WriteOutcome {
  return { ok: false, reason: "superseded_store", state: "current", clientId: frozen.clientId,
    message: "Background refresh superseded" };
}

for (const path of paths) {
  for (const [name, operation] of Object.entries({
    apply: applyIntegrationCoordinated, refresh: refreshIntegrationCoordinated,
    overwrite: overwriteIntegrationCoordinated, disable: disableIntegrationCoordinated,
  })) {
    test(`${name} guard refuses without a transaction on ${path}`, async () => {
      const bound = input(path);
      const spec = INTEGRATION_CLIENTS[bound.clientId];
      const target = spec.configPath({}, home);
      const before = existsSync(target) ? readFileSync(target, "utf8") : null;
      let guards = 0;
      const result = await operation(bound, { guard: frozen => {
        guards += 1;
        expect(frozen.clientId).toBe(bound.clientId);
        expect(existsSync(`${target}.lock`)).toBe(path === "locked");
        return refusal(frozen);
      } });
      expect(result).toEqual(refusal(bound));
      expect(guards).toBe(1);
      expect(existsSync(target) ? readFileSync(target, "utf8") : null).toBe(before);
      expect(existsSync(store.root)).toBe(false);
      expect(existsSync(`${target}.lock`)).toBe(false);
      if (path === "absent-home") expect(existsSync(spec.detectDir({}, home))).toBe(false);
    });
  }

  test(`admission revoked after revalidate refuses on ${path}`, async () => {
    const bound = input(path);
    const target = INTEGRATION_CLIENTS[bound.clientId].configPath({}, home);
    const before = existsSync(target) ? readFileSync(target, "utf8") : null;
    let admitted = true;
    let validations = 0;
    const result = await applyIntegrationCoordinated(bound, {
      revalidate: async () => {
        validations += 1;
        expect(admitted).toBe(true);
        // A retired generation can arrive after an async confirmation has agreed to the write.
        queueMicrotask(() => { admitted = false; });
        return null;
      },
      guard: frozen => admitted ? null : refusal(frozen),
    });
    expect(validations).toBe(1);
    expect(result).toEqual(refusal(bound));
    expect(existsSync(target) ? readFileSync(target, "utf8") : null).toBe(before);
    expect(existsSync(store.root)).toBe(false);
  });
}

test.each(["no-lock", "locked"] as const)("a null guard admits a real apply on %s", async path => {
  const bound = input(path);
  expect(await applyIntegrationCoordinated(bound, { guard: () => null }))
    .toMatchObject({ ok: true, changed: true });
  expect(readFileSync(INTEGRATION_CLIENTS[bound.clientId].configPath({}, home), "utf8")).toContain("opencodex");
  expect(store.readRecords()[bound.clientId]).toBeDefined();
});

test.each(["no-lock", "locked"] as const)("the transaction cannot yield after its final guard on %s", async path => {
  const bound = input(path);
  const io = store.io();
  let retired = false;
  let writes = 0;
  const result = await applyIntegrationCoordinated({ ...bound, io: {
    ...io,
    writeText: (target, text) => {
      expect(retired).toBe(false);
      writes += 1;
      io.writeText(target, text);
    },
  } }, { guard: () => {
    // Any await after this decision would let the next generation retire it before mutation.
    queueMicrotask(() => { retired = true; });
    return null;
  } });
  expect(result).toMatchObject({ ok: true, changed: true });
  expect(writes).toBeGreaterThan(0);
  expect(retired).toBe(true);
});

test.each(["no-lock", "locked"] as const)("restore keeps its existing contract on %s", async path => {
  const bound = input(path);
  const applied = await applyIntegrationCoordinated(bound);
  expect(applied.ok).toBe(true);
  if (!applied.ok || !applied.opId) throw new Error("fixture apply needs a restorable operation");
  let guards = 0;
  expect(await restoreIntegrationCoordinated({ ...bound, opId: applied.opId }, { guard: frozen => {
    guards += 1;
    return refusal(frozen);
  } })).toMatchObject({ ok: true, changed: true });
  expect(guards).toBe(0);
  expect(readFileSync(INTEGRATION_CLIENTS[bound.clientId].configPath({}, home), "utf8")).toBe("{}\n");
});
