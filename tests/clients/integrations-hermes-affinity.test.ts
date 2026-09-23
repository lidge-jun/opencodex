import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HERMES_API_KEY_ENV_REF, type ManagedContribution } from "../../src/clients/config-export";
import { previewIntegration } from "../../src/integrations/mutation-plan";
import { refreshOwnedIntegration } from "../../src/integrations/owned-refresh";
import { canonicalContribution, fingerprint, semanticContribution } from "../../src/integrations/ownership";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { readIntegrationState } from "../../src/integrations/state";
import { createIntegrationStateStore } from "../../src/integrations/store";
import {
  applyIntegration, disableIntegration, overwriteIntegration, refreshIntegration, restoreIntegration,
  type IntegrationWriteInput,
} from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let root: string;
let path: string;
let input: IntegrationWriteInput;
const prefix = "# User-owned settings\nmodel:\n  default: user-choice\nproviders:\n  other:\n    api: http://localhost:9000/v1 # keep this comment\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-hermes-affinity-"));
  const home = join(root, "home");
  path = INTEGRATION_CLIENTS.hermes.configPath({}, home);
  mkdirSync(dirname(path), { recursive: true });
  input = {
    clientId: "hermes", home, env: {}, port: 10100,
    models: [{ namespaced: "mock/example", provider: "mock", id: "example" }],
    config: {
      port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
      providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
    } as unknown as OcxConfig,
    store: createIntegrationStateStore(join(root, "integrations")),
  };
  writeFileSync(path, prefix);
});

afterEach(() => removeTreeWithRetry(root));

function provider(): Record<string, unknown> {
  return (Bun.YAML.parse(readFileSync(path, "utf8")) as {
    providers: { opencodex: Record<string, unknown> };
  }).providers.opencodex;
}

function writeProvider(block: Record<string, unknown>): void {
  const yaml = Bun.YAML.stringify(block).trimEnd().split("\n").map(line => `    ${line}`).join("\n");
  writeFileSync(path, `${prefix}  opencodex:\n${yaml}\n`);
}

/** A pre-fix contribution, independent of the generator under test. */
function seedLegacy(manual = false, semantic = true): void {
  const block = {
    api: "http://127.0.0.1:10100/v1", api_key: HERMES_API_KEY_ENV_REF,
    api_mode: "chat_completions", discover_models: false, models: { "mock/example": {} },
  };
  writeProvider(block);
  const contribution: ManagedContribution = {
    clientId: "hermes", fragments: [{ path: ["providers", "opencodex"], value: block }],
  };
  input.store!.putRecord({
    clientId: "hermes", configPath: path, fragmentPaths: [["providers", "opencodex"]],
    fileFingerprint: fingerprint(readFileSync(path, "utf8")),
    blockFingerprint: fingerprint(canonicalContribution(contribution)),
    ...(semantic ? { semanticBlockFingerprint: fingerprint(semanticContribution(contribution)) } : {}),
    createdContainers: [], appliedAt: "2026-09-01T00:00:00.000Z", opId: "legacy-apply",
  });
  if (manual) writeProvider({ ...block, session_affinity_header: "session-id" });
}

test("new Hermes integrations enable dynamic affinity even with only third-party models", () => {
  expect(applyIntegration(input)).toMatchObject({ ok: true, state: "current" });
  expect(provider()).toMatchObject({ session_affinity_header: "session-id", api_mode: "chat_completions" });
  expect(provider().extra_headers).toBeUndefined();
  expect(readFileSync(path, "utf8").startsWith(prefix)).toBe(true);
});

test.each([
  [false, false], [false, true], [true, false], [true, true],
])("legacy manual=%s semantic=%s waits for Apply, then supports refresh and undo", async (manual, semantic) => {
  seedLegacy(manual, semantic);
  const before = readFileSync(path, "utf8");
  const record = input.store!.readRecords().hermes;
  expect(readIntegrationState(input).state).toBe("stale");
  expect(previewIntegration(input, { operation: "apply" })).toMatchObject({ canApply: true, willChange: true });
  expect(refreshIntegration(input)).toMatchObject({ ok: true, changed: false, state: "stale" });
  expect(await refreshOwnedIntegration(input)).toMatchObject({ ok: true, changed: false, reason: expect.stringContaining("Apply") });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(input.store!.readRecords().hermes).toEqual(record);
  expect(input.store!.listOperations("hermes")).toEqual([]);

  const applied = applyIntegration(input);
  expect(applied).toMatchObject({ ok: true, changed: true, state: "current" });
  expect(provider().session_affinity_header).toBe("session-id");
  expect(readIntegrationState(input).state).toBe("current");
  expect(applyIntegration(input)).toMatchObject({ ok: true, changed: false });
  if (!applied.ok || !applied.opId) throw new Error("missing apply operation");
  expect(restoreIntegration({ ...input, opId: applied.opId })).toMatchObject({ ok: true });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(readIntegrationState(input).state).toBe("stale");

  expect(applyIntegration(input).ok).toBe(true);
  const changed = { ...input, models: [...input.models, { namespaced: "mock/next", provider: "mock", id: "next" }] };
  expect(await refreshOwnedIntegration(changed)).toMatchObject({ ok: true, changed: true });
  expect(provider()).toMatchObject({ session_affinity_header: "session-id", models: { "mock/next": {} } });
  expect(readFileSync(path, "utf8").startsWith(prefix)).toBe(true);
  expect(disableIntegration(changed).ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(prefix);
});

test("a manual affinity addition can be adopted despite catalog drift and YAML key reordering", () => {
  seedLegacy(true);
  writeProvider(Object.fromEntries(Object.entries(provider()).reverse()));
  const changed = { ...input, models: [{ namespaced: "mock/new", provider: "mock", id: "new" }] };
  expect(readIntegrationState(changed).state).toBe("stale");
  expect(applyIntegration(changed).ok).toBe(true);
  expect(provider()).toMatchObject({ session_affinity_header: "session-id", models: { "mock/new": {} } });
  expect(provider().models).not.toHaveProperty("mock/example");
});

test.each([
  ["api", "http://localhost:9900/v1"], ["api_key", "user-env-reference"],
  ["api_mode", "codex_responses"], ["discover_models", true],
  ["models", { "mock/own": {} }], ["extra_headers", { "x-user": "keep" }],
  ["user_option", true], ["session_affinity_header", "thread-id"],
])("the supported workaround does not excuse a protected %s edit", (key, value) => {
  seedLegacy(true);
  writeProvider({ ...provider(), [key as string]: value });
  const before = readFileSync(path, "utf8");
  expect(readIntegrationState(input)).toMatchObject({ state: "conflict", reason: "foreign-edit" });
  for (const action of [applyIntegration, refreshIntegration, disableIntegration]) {
    expect(action(input)).toMatchObject({ ok: false, reason: "conflict" });
  }
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(input.store!.listOperations("hermes")).toEqual([]);
});

test.each([undefined, null, "thread-id"])("after adoption the affinity field is protected against %s", value => {
  expect(applyIntegration(input).ok).toBe(true);
  const block = provider();
  if (value === undefined) delete block.session_affinity_header;
  else block.session_affinity_header = value;
  writeProvider(block);
  expect(readIntegrationState(input)).toMatchObject({ state: "conflict", reason: "foreign-edit" });
  expect(refreshIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
  expect(overwriteIntegration(input)).toMatchObject({ ok: true, state: "current" });
  expect(provider().session_affinity_header).toBe("session-id");
});

test.each(["missing", "different-path", "different-client"])("adoption requires ownership: %s", kind => {
  seedLegacy(true);
  const record = input.store!.readRecords().hermes!;
  if (kind === "missing") input.store!.dropRecord("hermes");
  else if (kind === "different-path") input.store!.putRecord({ ...record, configPath: join(root, "unowned.yaml") });
  else input.store = { ...input.store!, readRecords: () => ({ hermes: { ...record, clientId: "pi" } }) };
  expect(readIntegrationState(input).state).toBe("conflict");
  expect(applyIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
});
