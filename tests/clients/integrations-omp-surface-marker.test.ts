import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LOOPBACK_API_KEY_PLACEHOLDER, type ManagedContribution } from "../../src/clients/config-export";
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

/** Marker adoption requires Apply; refresh preserves the old file and ownership record. */
let root: string;
let path: string;
let input: IntegrationWriteInput;
const prefix = "# User-owned settings\nproviders:\n  freebuff: # keep provider comment\n    api: openai-completions # keep inline comment\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-omp-marker-"));
  const home = join(root, "home");
  path = INTEGRATION_CLIENTS.omp.configPath({}, home);
  mkdirSync(dirname(path), { recursive: true });
  input = {
    clientId: "omp", home, env: {}, port: 10100,
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

/** The managed block, read back through a guard rather than an inline cast. */
function provider(): Record<string, unknown> {
  const parsed: unknown = Bun.YAML.parse(readFileSync(path, "utf8"));
  if (!parsed || typeof parsed !== "object" || !("providers" in parsed)) {
    throw new Error("fixture has no providers block");
  }
  const { providers } = parsed;
  if (!providers || typeof providers !== "object" || !("opencodex" in providers)) {
    throw new Error("fixture has no opencodex provider");
  }
  const block = providers.opencodex;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw new Error("fixture opencodex provider is not a mapping");
  }
  return block as Record<string, unknown>;
}

function writeProvider(block: Record<string, unknown>): void {
  const yaml = Bun.YAML.stringify(block).trimEnd().split("\n").map(line => `    ${line}`).join("\n");
  writeFileSync(path, `${prefix}  opencodex:\n${yaml}\n`);
}

/** A pre-marker contribution, independent of the generator under test. */
function seedLegacy(semantic = true): void {
  const block = {
    baseUrl: "http://127.0.0.1:10100/v1", api: "openai-completions",
    apiKey: LOOPBACK_API_KEY_PLACEHOLDER,
    models: [{ id: "mock/example", name: "example (mock)", input: ["text"] }],
  };
  writeProvider(block);
  const contribution: ManagedContribution = {
    clientId: "omp", fragments: [{ path: ["providers", "opencodex"], value: block }],
  };
  input.store!.putRecord({
    clientId: "omp", configPath: path, fragmentPaths: [["providers", "opencodex"]],
    fileFingerprint: fingerprint(readFileSync(path, "utf8")),
    blockFingerprint: fingerprint(canonicalContribution(contribution)),
    ...(semantic ? { semanticBlockFingerprint: fingerprint(semanticContribution(contribution)) } : {}),
    createdContainers: [], appliedAt: "2026-09-01T00:00:00.000Z", opId: "legacy-apply",
  });
}

test("a new OMP integration writes the surface marker on its first Apply", () => {
  expect(applyIntegration(input)).toMatchObject({ ok: true, state: "current" });
  expect(provider().headers).toEqual({ "x-opencodex-client": "omp" });
  // The user's own provider and its comments survive the write.
  expect(readFileSync(path, "utf8").startsWith(prefix)).toBe(true);
});

test.each([true, false])("legacy semantic=%s waits for Apply, then supports refresh and undo", async semantic => {
  seedLegacy(semantic);
  const before = readFileSync(path, "utf8");
  const record = input.store!.readRecords().omp;
  expect(readIntegrationState(input).state).toBe("stale");
  expect(previewIntegration(input, { operation: "apply" })).toMatchObject({ canApply: true, willChange: true });
  expect(refreshIntegration(input)).toMatchObject({ ok: true, changed: false, state: "stale" });
  expect(await refreshOwnedIntegration(input)).toMatchObject({ ok: true, changed: false, reason: expect.stringContaining("Apply") });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(input.store!.readRecords().omp).toEqual(record);
  expect(input.store!.listOperations("omp")).toEqual([]);

  const applied = applyIntegration(input);
  expect(applied).toMatchObject({ ok: true, changed: true, state: "current" });
  expect(provider().headers).toEqual({ "x-opencodex-client": "omp" });
  expect(readIntegrationState(input).state).toBe("current");
  expect(applyIntegration(input)).toMatchObject({ ok: true, changed: false });
  if (!applied.ok || !applied.opId) throw new Error("missing apply operation");
  expect(restoreIntegration({ ...input, opId: applied.opId })).toMatchObject({ ok: true });
  expect(readFileSync(path, "utf8")).toBe(before);
  expect(readIntegrationState(input).state).toBe("stale");

  // After adoption the field is protected like every other managed field, and
  // ordinary catalog refresh resumes.
  expect(applyIntegration(input).ok).toBe(true);
  const changed = { ...input, models: [...input.models, { namespaced: "mock/next", provider: "mock", id: "next" }] };
  expect(await refreshOwnedIntegration(changed)).toMatchObject({ ok: true, changed: true });
  expect(provider().headers).toEqual({ "x-opencodex-client": "omp" });
  expect(readFileSync(path, "utf8").startsWith(prefix)).toBe(true);
  expect(disableIntegration(changed).ok).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(prefix);
});

test("a user-authored headers map is never adopted as our upgrade", () => {
  seedLegacy();
  const block = provider();
  writeProvider({ ...block, headers: { "x-user": "keep" } });
  // The user wrote their own headers, so the marker is not a field we may add.
  expect(readIntegrationState(input)).toMatchObject({ state: "conflict", reason: "foreign-edit" });
  expect(refreshIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
  expect(overwriteIntegration(input)).toMatchObject({ ok: true, state: "current" });
  expect(provider().headers).toEqual({ "x-opencodex-client": "omp" });
});

test.each([undefined, "1", "cursor"])("the marker value is a closed vocabulary, not a truthy flag: %s", value => {
  seedLegacy();
  const block = provider();
  const headers: Record<string, string> = value === undefined ? {} : { "x-opencodex-client": value };
  writeProvider({ ...block, headers });
  // Any foreign value is a user edit, never something refresh may rewrite.
  expect(readIntegrationState(input)).toMatchObject({ state: "conflict", reason: "foreign-edit" });
  expect(refreshIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
});

test("removing an applied marker is a foreign edit, not another upgrade", () => {
  expect(applyIntegration(input).ok).toBe(true);
  const block = provider();
  delete block.headers;
  writeProvider(block);
  const before = readFileSync(path, "utf8");
  expect(readIntegrationState(input)).toMatchObject({ state: "conflict", reason: "foreign-edit" });
  expect(applyIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
  expect(refreshIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
  expect(readFileSync(path, "utf8")).toBe(before);
});

test.each(["missing", "different-path", "different-client"])("adoption requires ownership: %s", kind => {
  seedLegacy();
  const record = input.store!.readRecords().omp!;
  if (kind === "missing") input.store!.dropRecord("omp");
  else if (kind === "different-path") input.store!.putRecord({ ...record, fragmentPaths: [["providers", "other"]] });
  // A record under another client's id is not an OMP record at all, so the reader
  // must not hand it to the OMP upgrade hook. Replacing the whole store view is
  // what makes that observable: writing a `hermes` record on top of the `omp` one
  // would leave both in place and the OMP record would still be found.
  else input.store = { ...input.store!, readRecords: () => ({ hermes: { ...record, clientId: "hermes" } }) };

  // Without a record naming this block, the block is somebody else's: the
  // upgrade hook never runs and the writer refuses rather than claiming it.
  expect(readIntegrationState(input)).toMatchObject({ state: "conflict", reason: "unowned-key" });
  expect(refreshIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
  expect(applyIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
  expect(provider().headers).toBeUndefined();
});
