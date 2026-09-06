import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExportModel, ManagedContribution } from "../../src/clients/config-export";
import {
  AmbiguousSelectorError,
  createdContainerPaths,
  deletePath,
  parseSegment,
  setPath,
} from "../../src/integrations/merge";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { blockedContainerPath, readIntegrationState, readPath } from "../../src/integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import {
  applyIntegration,
  disableIntegration,
  overwriteIntegration,
  type IntegrationWriteInput,
} from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * The `[field=value]` path segment: one element of a sequence, addressed by a
 * field rather than an index so the user's own reordering cannot move it under
 * us. Plan: devlog/_plan/260904_raycast_integration/000_plan.md (WP1).
 */
const OURS = { id: "opencodex", name: "OpenCodex" };
const THEIRS = { id: "lmstudio", name: "LM Studio" };
const SELECT = ["providers", "[id=opencodex]"] as const;

function contribution(path: readonly string[], value: unknown = OURS): ManagedContribution {
  return { clientId: "raycast", fragments: [{ path, value }] };
}

describe("parseSegment", () => {
  test("a selector splits into field and value; anything else is a key", () => {
    expect(parseSegment("[id=opencodex]")).toEqual({ kind: "select", field: "id", value: "opencodex" });
    expect(parseSegment("[model_id=anthropic/claude-opus-5]"))
      .toEqual({ kind: "select", field: "model_id", value: "anthropic/claude-opus-5" });
    expect(parseSegment("providers")).toEqual({ kind: "key", key: "providers" });
    // Near misses stay keys: a client whose map literally has such a key keeps working.
    expect(parseSegment("[id=]")).toEqual({ kind: "key", key: "[id=]" });
    expect(parseSegment("[=x]")).toEqual({ kind: "key", key: "[=x]" });
    expect(parseSegment("[id=x")).toEqual({ kind: "key", key: "[id=x" });
  });
});

describe("setPath with a selector", () => {
  test("replaces the matching element in place and keeps siblings and order", () => {
    const doc = { providers: [THEIRS, { id: "opencodex", name: "old" }, { id: "other" }], keep: true };
    const next = setPath(doc, SELECT, OURS) as typeof doc;
    expect(next.providers).toEqual([THEIRS, OURS, { id: "other" }]);
    expect(next.keep).toBe(true);
    // The input is not mutated.
    expect(doc.providers[1]).toEqual({ id: "opencodex", name: "old" });
  });

  test("pushes when no element matches", () => {
    const next = setPath({ providers: [THEIRS] }, SELECT, OURS) as { providers: unknown[] };
    expect(next.providers).toEqual([THEIRS, OURS]);
  });

  test("creates the array when absent, and createdContainerPaths reports it", () => {
    expect(createdContainerPaths({}, contribution(SELECT))).toEqual(["providers"]);
    expect(createdContainerPaths({ providers: {} }, contribution(SELECT))).toEqual(["providers"]);
    expect(createdContainerPaths({ providers: [THEIRS] }, contribution(SELECT))).toEqual([]);
    expect(setPath({}, SELECT, OURS)).toEqual({ providers: [OURS] });
    // A record where the array belongs is replaced, exactly as a scalar under a key is.
    expect(setPath({ providers: {} }, SELECT, OURS)).toEqual({ providers: [OURS] });
  });

  test("descends into a matched element, seeding one when absent", () => {
    const path = ["providers", "[id=opencodex]", "name"];
    expect(setPath({ providers: [THEIRS] }, path, "X"))
      .toEqual({ providers: [THEIRS, { id: "opencodex", name: "X" }] });
    expect(setPath({ providers: [OURS, THEIRS] }, path, "X"))
      .toEqual({ providers: [{ id: "opencodex", name: "X" }, THEIRS] });
    // The element the selector would create is recorded, the existing array is not.
    expect(createdContainerPaths({ providers: [THEIRS] }, contribution(path, "X")))
      .toEqual(["providers\u0000[id=opencodex]"]);
    expect(createdContainerPaths({ providers: [OURS] }, contribution(path, "X"))).toEqual([]);
  });

  test("throws AmbiguousSelectorError when two elements match", () => {
    const doc = { providers: [OURS, THEIRS, { id: "opencodex", name: "dupe" }] };
    expect(() => setPath(doc, SELECT, OURS)).toThrow(AmbiguousSelectorError);
    expect(() => deletePath(doc, SELECT)).toThrow(AmbiguousSelectorError);
  });
});

describe("deletePath with a selector", () => {
  test("removes only the matching element and leaves siblings", () => {
    const { doc, removed } = deletePath({ providers: [THEIRS, OURS, { id: "other" }], keep: 1 }, SELECT);
    expect(removed).toBe(true);
    expect(doc).toEqual({ providers: [THEIRS, { id: "other" }], keep: 1 });
  });

  test("reports nothing removed when no element matches or the slot is not an array", () => {
    expect(deletePath({ providers: [THEIRS] }, SELECT)).toEqual({ doc: { providers: [THEIRS] }, removed: false });
    expect(deletePath({ providers: {} }, SELECT)).toEqual({ doc: { providers: {} }, removed: false });
    expect(deletePath({}, SELECT)).toEqual({ doc: {}, removed: false });
  });

  test("prunes an emptied array we created and keeps one we did not", () => {
    const created = new Set(["providers"]);
    expect(deletePath({ providers: [OURS], keep: 1 }, SELECT, created).doc).toEqual({ keep: 1 });
    expect(deletePath({ providers: [OURS], keep: 1 }, SELECT).doc).toEqual({ providers: [], keep: 1 });
    // A sibling keeps the array alive even when we created it.
    expect(deletePath({ providers: [OURS, THEIRS] }, SELECT, created).doc).toEqual({ providers: [THEIRS] });
  });

  test("a leaf inside a selected element is removed without touching the element", () => {
    const path = ["providers", "[id=opencodex]", "name"];
    const created = new Set(["providers", "providers\u0000[id=opencodex]"]);
    // The seeded element keeps its selector field, so it is never empty and the prune walk
    // stops at it. No client owns a leaf inside a selected element today; when one does, it
    // decides whether a `{ id }` husk is residue worth a dedicated rule.
    expect(deletePath({ providers: [{ id: "opencodex", name: "X" }] }, path, created).doc)
      .toEqual({ providers: [{ id: "opencodex" }] });
    expect(deletePath({ providers: [{ id: "opencodex", name: "X", extra: 1 }] }, path, created).doc)
      .toEqual({ providers: [{ id: "opencodex", extra: 1 }] });
  });
});

describe("readPath and blockedContainerPath with a selector", () => {
  test("readPath finds the element through a selector", () => {
    const doc = { providers: [THEIRS, OURS] };
    expect(readPath(doc, SELECT)).toEqual(OURS);
    expect(readPath(doc, ["providers", "[id=opencodex]", "name"])).toBe("OpenCodex");
    expect(readPath(doc, ["providers", "[id=missing]"])).toBeUndefined();
    expect(readPath({ providers: {} }, SELECT)).toBeUndefined();
    expect(readPath({ providers: "x" }, SELECT)).toBeUndefined();
  });

  test("blockedContainerPath blocks a non-array where the selector expects one", () => {
    expect(blockedContainerPath({ providers: {} }, contribution(SELECT))).toEqual(["providers"]);
    expect(blockedContainerPath({ providers: "x" }, contribution(SELECT))).toEqual(["providers"]);
    expect(blockedContainerPath({ providers: null }, contribution(SELECT))).toEqual(["providers"]);
    expect(blockedContainerPath({ providers: [THEIRS] }, contribution(SELECT))).toBeNull();
    expect(blockedContainerPath({}, contribution(SELECT))).toBeNull();
    // Reading through a matched element continues the walk: a scalar element is blocked,
    // a record one is fine, an absent one is simply not there yet.
    const deep = ["providers", "[id=opencodex]", "name"];
    expect(blockedContainerPath({ providers: [OURS] }, contribution(deep, "X"))).toBeNull();
    expect(blockedContainerPath({ providers: [THEIRS] }, contribution(deep, "X"))).toBeNull();
    expect(blockedContainerPath({ providers: [{ id: "opencodex", name: 1 }] }, contribution(["providers", "[id=opencodex]", "name", "leaf"], "X")))
      .toEqual(["providers", "[id=opencodex]", "name"]);
  });
});

describe("plain-key paths are unchanged", () => {
  test("setPath, deletePath, readPath, createdContainerPaths and blockedContainerPath behave as before", () => {
    const path = ["providers", "opencodex", "api_key"];
    expect(setPath({}, path, "k")).toEqual({ providers: { opencodex: { api_key: "k" } } });
    expect(setPath({ providers: "x" }, path, "k")).toEqual({ providers: { opencodex: { api_key: "k" } } });
    expect(setPath({ providers: [1] }, path, "k")).toEqual({ providers: { opencodex: { api_key: "k" } } });
    expect(setPath({ providers: { other: 1 } }, path, "k"))
      .toEqual({ providers: { other: 1, opencodex: { api_key: "k" } } });
    expect(createdContainerPaths({}, contribution(path, "k"))).toEqual(["providers", "providers\u0000opencodex"]);
    expect(createdContainerPaths({ providers: { other: 1 } }, contribution(path, "k"))).toEqual(["providers\u0000opencodex"]);

    const created = new Set(["providers", "providers\u0000opencodex"]);
    expect(deletePath({ providers: { opencodex: { api_key: "k" } } }, path, created)).toEqual({ doc: {}, removed: true });
    expect(deletePath({ providers: { opencodex: { api_key: "k" } } }, path)).toEqual({ doc: { providers: { opencodex: {} } }, removed: true });
    expect(deletePath({ providers: { opencodex: { api_key: "k", other: 1 } }, x: 1 }, path, created))
      .toEqual({ doc: { providers: { opencodex: { other: 1 } }, x: 1 }, removed: true });
    expect(deletePath({ providers: {} }, path)).toEqual({ doc: { providers: {} }, removed: false });
    expect(deletePath({ providers: [] }, path)).toEqual({ doc: { providers: [] }, removed: false });
    expect(deletePath({ providers: { opencodex: "x" } }, path)).toEqual({ doc: { providers: { opencodex: "x" } }, removed: false });
    expect(deletePath({ providers: { opencodex: { api_key: null } } }, path, created)).toEqual({ doc: {}, removed: true });

    expect(readPath({ providers: { opencodex: { api_key: "k" } } }, path)).toBe("k");
    expect(readPath({ providers: [OURS] }, ["providers", "0"])).toBeUndefined();
    expect(readPath({ providers: null }, path)).toBeUndefined();

    expect(blockedContainerPath({ providers: ["x"] }, contribution(path, "k"))).toEqual(["providers"]);
    expect(blockedContainerPath({ providers: { opencodex: null } }, contribution(path, "k"))).toEqual(["providers", "opencodex"]);
    expect(blockedContainerPath(null, contribution(path, "k"))).toEqual([]);
    expect(blockedContainerPath({ providers: { opencodex: {} } }, contribution(path, "k"))).toBeNull();
    expect(blockedContainerPath(undefined, contribution(path, "k"))).toBeNull();
  });
});

/**
 * End to end through the real writer: Raycast is the first client whose
 * fragment path carries a selector, so this is where status and mutation are
 * shown agreeing on which sequence element is ours.
 */
describe("raycast writer round trip", () => {
  const TEST_ENV = {} as NodeJS.ProcessEnv;
  const MODELS: ExportModel[] = [
    { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
  ];
  const CONFIG: OcxConfig = {
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
  } as unknown as OcxConfig;
  let home: string;
  let store: IntegrationStateStore;

  beforeEach(() => {
    const base = mkdtempSync(join(tmpdir(), "ocx-integrations-merge-"));
    home = join(base, "home");
    mkdirSync(home, { recursive: true });
    store = createIntegrationStateStore(join(base, "store", "integrations"));
  });

  afterEach(() => {
    removeTreeWithRetry(dirname(home));
  });

  function installRaycast(): string {
    const spec = INTEGRATION_CLIENTS.raycast;
    mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
    const configPath = spec.configPath(TEST_ENV, home);
    mkdirSync(dirname(configPath), { recursive: true });
    return configPath;
  }

  function input(): IntegrationWriteInput {
    return { clientId: "raycast", models: MODELS, config: CONFIG, port: 10100, env: TEST_ENV, home, store };
  }

  test("apply appends beside the user's provider, disable removes only ours", () => {
    const configPath = installRaycast();
    writeFileSync(configPath, Bun.YAML.stringify({ providers: [THEIRS] }));

    expect(readIntegrationState(input())).toMatchObject({ state: "absent" });
    expect(applyIntegration(input())).toMatchObject({ ok: true, changed: true });
    const applied = Bun.YAML.parse(readFileSync(configPath, "utf8")) as { providers: Array<{ id: string }> };
    expect(applied.providers.map(item => item.id)).toEqual(["lmstudio", "opencodex"]);
    expect(readIntegrationState(input())).toMatchObject({ state: "current" });

    expect(disableIntegration(input())).toMatchObject({ ok: true, changed: true });
    // The user's array was there before us, so it survives with their entry intact.
    expect(Bun.YAML.parse(readFileSync(configPath, "utf8"))).toEqual({ providers: [THEIRS] });
    expect(readIntegrationState(input())).toMatchObject({ state: "absent" });
  });

  test("a providers map instead of a sequence is unsafe for status and writer alike", () => {
    const configPath = installRaycast();
    writeFileSync(configPath, Bun.YAML.stringify({ providers: { opencodex: {} } }));
    expect(readIntegrationState(input())).toMatchObject({ state: "unsafe", reason: "blocked-container" });
    expect(applyIntegration(input())).toMatchObject({ ok: false, reason: "unsafe" });
    expect(Bun.YAML.parse(readFileSync(configPath, "utf8"))).toEqual({ providers: { opencodex: {} } });
  });

  test("two entries with our id refuse as unsafe and leave the file alone", () => {
    const configPath = installRaycast();
    const text = Bun.YAML.stringify({ providers: [{ id: "opencodex", name: "a" }, { id: "opencodex", name: "b" }] });
    writeFileSync(configPath, text);
    // Neither entry is ours on record, so status reads conflict and a plain apply refuses
    // there. The explicit overwrite reaches the merge, which is where the ambiguity is
    // detected: it must surface as an `unsafe` refusal, never as a thrown error.
    expect(readIntegrationState(input())).toMatchObject({ state: "conflict" });
    expect(applyIntegration(input())).toMatchObject({ ok: false, reason: "conflict" });
    const result = overwriteIntegration(input());
    expect(result).toMatchObject({ ok: false, reason: "unsafe", state: "unsafe" });
    if (!result.ok) expect(result.message).toContain("more than one entry");
    expect(readFileSync(configPath, "utf8")).toBe(text);
    expect(store.listOperations("raycast")).toHaveLength(0);
  });
});
