import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listCatalogNativeSlugs, type CatalogModel } from "../../src/codex/catalog";
import { buildRoleProposals, classifyRoleModelCandidates } from "../../src/codex/role-auto-assign";
import { DELEGATED_WORK_SIZING_SYSTEM_PROMPT } from "../../src/codex/role-sizing";
import { handleManagementAPI } from "../../src/server/management-api";
import type { RoleSizingCall } from "../../src/server/management/codex-role-auto-assign";
import type { OcxConfig } from "../../src/types";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { peekCodexRuntimeProcessCache, resetCodexRuntimeResolveCacheForTests, setCodexRuntimeResolveCacheForTests } from "../../src/codex/runtime";
import { bundledCatalogCacheState, resetBundledCatalogCacheForTests, setBundledCatalogCacheForTests } from "../../src/codex/catalog/bundled";

const ENV_KEYS = ["CODEX_HOME", "OPENCODEX_HOME", "HOME", "USERPROFILE"] as const;
let saved: Record<string, string | undefined> = {};

let root = "";
let calls: RoleSizingCall[] = [];
let catalogLoads = 0;
let answer: { text: string; error?: string } = { text: "" };

function sized(tier: string, effort: string) {
  return JSON.stringify({ roles: { "delegated-work": { tier, effort, rationale: "why", move_up_if: "up", move_down_if: "down" } } });
}

const routed = (id: string, efforts: string[]): CatalogModel => ({ id, provider: "stub", reasoningEfforts: efforts, defaultReasoningEffort: "medium" });

let config: OcxConfig;

// The Codex binary discovery cache is refreshed by catalog reads on any request; it holds no setting.
const RUNTIME_DISCOVERY_CACHE = "codex-runtime.json";

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  root = mkdtempSync(join(tmpdir(), "ocx-injection-suggest-"));
  mkdirSync(join(root, "codex"), { recursive: true });
  mkdirSync(join(root, "ocx"), { recursive: true });
  writeFileSync(join(root, "codex", "config.toml"), 'model = "stub/sizer"\n');
  process.env.CODEX_HOME = join(root, "codex");
  process.env.OPENCODEX_HOME = join(root, "ocx");
  process.env.HOME = join(root, "home");
  process.env.USERPROFILE = join(root, "home");
  // Keep real catalog/handler behavior, but never discover an installed Codex in this fixture.
  const runtime = { command: join(root, "fixture-codex"), version: "0.145.0", source: "fallback" as const };
  resetFixtureDiscovery();
  setCodexRuntimeResolveCacheForTests({ runtime, failures: [] }, { discoverAlternatives: false });
  setBundledCatalogCacheForTests(runtime, { models: [{ slug: "gpt-5.5", base_instructions: "fixture native model" }] });
  calls = [];
  catalogLoads = 0;
  answer = { text: sized("fast", "glance") };
  config = {
    port: 10100,
    providers: {},
    defaultProvider: "openai",
    disabledModels: [...listCatalogNativeSlugs(), "stub/cheapest"],
    codexRoleTiers: { fast: ["stub/cheapest", "stub/small"], standard: ["stub/mid"], frontier: ["stub/big"] },
    injectionModel: "stub/big",
    injectionEffort: "high",
  } as unknown as OcxConfig;
});

function resetFixtureDiscovery(): void {
  resetCodexRuntimeResolveCacheForTests();
  resetBundledCatalogCacheForTests();
}

afterEach(() => {
  try {
    resetFixtureDiscovery();
    expect(peekCodexRuntimeProcessCache().kind).toBe("unavailable");
    expect(bundledCatalogCacheState().valueIdentity).toBeNull();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    removeTreeWithRetry(root);
  }
});

const deps = {
  fetchAllModels: async () => {
    catalogLoads += 1;
    return [
      routed("cheapest", ["low", "medium"]),
      routed("small", ["minimal", "low", "medium", "high"]),
      routed("mid", ["low", "medium", "high"]),
      routed("big", ["low", "medium", "high", "xhigh"]),
    ];
  },
  completeCodexRoleSizing: async (call: RoleSizingCall) => {
    calls.push(call);
    return answer;
  },
};

async function suggest(body: unknown) {
  const path = "/api/injection-model/suggest";
  const response = await handleManagementAPI(
    new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }),
    new URL(`http://localhost${path}`),
    config,
    deps,
  );
  expect(response).not.toBeNull();
  return { status: response!.status, body: await response!.json() as Record<string, any> };
}

type SnapshotEntry = { kind: "directory" } | { kind: "file"; bytes: string };

function snapshot() {
  const files: Record<string, SnapshotEntry> = {};
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relative = `${prefix}/${name}`;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`fixture snapshot refuses symbolic link: ${relative}`);
      if (stat.isFile()) {
        if (relative === `ocx/${RUNTIME_DISCOVERY_CACHE}`) continue;
        files[relative] = { kind: "file", bytes: readFileSync(path).toString("base64") };
      } else if (stat.isDirectory()) {
        files[relative] = { kind: "directory" };
        visit(path, relative);
      } else {
        throw new Error(`fixture snapshot refuses nonregular entry: ${relative}`);
      }
    }
  };
  for (const dir of ["codex", "ocx"]) visit(join(root, dir), dir);
  return { files, config: JSON.stringify(config) };
}

describe("POST /api/injection-model/suggest", () => {
  test("sizes the described work in one call and proposes an offered model and a savable effort, writing nothing", async () => {
    mkdirSync(join(root, "codex", "tmp", "nested"), { recursive: true });
    mkdirSync(join(root, "codex", "empty"));
    writeFileSync(join(root, "codex", "tmp", "nested", "bytes"), Buffer.from([255, 0]));
    const before = snapshot();
    const result = await suggest({ work: "Rename symbols across one file and run its tests." });
    expect(result.status).toBe(200);
    expect(snapshot()).toEqual(before);
    expect(calls).toHaveLength(1);
    expect(catalogLoads).toBe(1);
    expect(calls[0]!.model).toBe("stub/sizer");
    expect(calls[0]!.system).toBe(DELEGATED_WORK_SIZING_SYSTEM_PROMPT);
    expect(calls[0]!.user).toContain("Rename symbols across one file");
    expect(result.body.sizingModel).toBe("stub/sizer");
    expect(result.body.sizingError).toBeNull();
    // stub/cheapest is disabled, so the page does not offer it; "minimal" is on the ladder but is
    // not a level the page's PUT accepts, so glance binds to "low".
    expect(result.body.proposal).toMatchObject({
      status: "proposed",
      model: "stub/big",
      effort: "high",
      tier: "fast",
      effortIntent: "glance",
      rationale: "why",
      moveUpIf: "up",
      moveDownIf: "down",
      proposedModel: "stub/small",
      proposedEffort: "low",
    });
    expect((result.body.candidates as any[]).map(c => c.model)).not.toContain("stub/cheapest");
  });

  test("a sizing model override is used, and a failed or unusable answer leaves the work unsized", async () => {
    answer = { text: "use a fast model" };
    let result = await suggest({ work: "Review a release branch.", model: "stub/other" });
    expect(calls[0]!.model).toBe("stub/other");
    expect(result.body.proposal.status).toBe("unsized");
    answer = { text: "", error: "role sizing HTTP 502: boom" };
    result = await suggest({ work: "Review a release branch." });
    expect(result.body.sizingError).toBe("HTTP 502");
    expect(result.body.proposal.reason).toContain("the sizing call failed");
    answer = { text: "", error: "connect ECONNREFUSED while opening /Users/example/secret.sock for acct_123 key=sk-live-abc" };
    result = await suggest({ work: "Review a release branch." });
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain("/Users/example");
    expect(serialized).not.toContain("acct_123");
    expect(serialized).not.toContain("sk-live-abc");
  });

  test("rejects a blank or oversized description and a missing sizing model without calling a model", async () => {
    expect((await suggest({ work: "  " })).body.code).toBe("invalid_work");
    expect((await suggest({ work: "x".repeat(1501) })).status).toBe(400);
    expect((await suggest({ work: "ok", model: 3 })).body.code).toBe("invalid_model");
    writeFileSync(join(root, "codex", "config.toml"), "");
    const result = await suggest({ work: "Summarize logs." });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe("no_sizing_model");
    expect(calls).toHaveLength(0);
  });
});

describe("buildRoleProposals alwaysProposeEffort", () => {
  test("changes only the effort of a role that carries none", () => {
    const classified = classifyRoleModelCandidates([{ model: "m", unitPrice: 1, efforts: ["low", "medium", "high"] }]);
    const sizing = new Map([["r", { sizing: { tier: "fast" as const, effort: "exhaustive" as const, rationale: "a", moveUpIf: "b", moveDownIf: "c" } }]]);
    const roles = [{ role: "r", model: null, effort: null }];
    const [plain] = buildRoleProposals(roles, sizing, classified);
    const [always] = buildRoleProposals(roles, sizing, classified, { alwaysProposeEffort: true });
    expect(plain).toMatchObject({ proposedModel: "m", proposedEffort: null });
    expect(always).toEqual({ ...plain!, proposedEffort: "high" } as typeof always);
  });
});


describe("injection suggestion fixture isolation", () => {
  test("snapshot observes nested bytes, empty directories and file/directory replacement", () => {
    const nested = join(root, "codex", "tmp", "nested");
    mkdirSync(nested, { recursive: true });
    const bytes = join(nested, "bytes");
    writeFileSync(bytes, Buffer.from([255, 0]));
    const before = snapshot();
    expect(before.files["codex/tmp/nested/bytes"]).toEqual({ kind: "file", bytes: "/wA=" });
    writeFileSync(bytes, Buffer.from([254, 0]));
    expect(snapshot()).not.toEqual(before);
    writeFileSync(bytes, Buffer.from([255, 0]));
    expect(snapshot()).toEqual(before);
    const empty = join(nested, "empty");
    mkdirSync(empty);
    expect(snapshot()).not.toEqual(before);
    expect(snapshot().files["codex/tmp/nested/empty"]).toEqual({ kind: "directory" });
    removeTreeWithRetry(empty);
    expect(snapshot()).toEqual(before);
    removeTreeWithRetry(bytes);
    mkdirSync(bytes);
    expect(snapshot()).not.toEqual(before);
  });

  test("only the exact regular runtime cache file is exempt", () => {
    const cache = join(root, "ocx", RUNTIME_DISCOVERY_CACHE);
    const before = snapshot();
    writeFileSync(cache, "cache bytes");
    expect(snapshot()).toEqual(before);
    const nested = join(root, "codex", "nested");
    mkdirSync(nested);
    const nestedCache = join(nested, RUNTIME_DISCOVERY_CACHE);
    writeFileSync(nestedCache, "before");
    const nestedBefore = snapshot();
    writeFileSync(nestedCache, "after");
    expect(snapshot()).not.toEqual(nestedBefore);
    const topBefore = snapshot();
    writeFileSync(join(root, "codex", RUNTIME_DISCOVERY_CACHE), "not the runtime cache");
    expect(snapshot()).not.toEqual(topBefore);
    const directoryBefore = snapshot();
    removeTreeWithRetry(cache);
    mkdirSync(cache);
    expect(snapshot()).not.toEqual(directoryBefore);
  });

  test("snapshot refuses a link rather than traversing its target", () => {
    const target = join(root, "outside-observed-homes");
    mkdirSync(target);
    writeFileSync(join(target, "sentinel"), "must not be read by the snapshot");
    symlinkSync(target, join(root, "codex", "link"), process.platform === "win32" ? "junction" : "dir");
    expect(() => snapshot()).toThrow(/refuses symbolic link/);
  });

  test("discovery cleanup removes both seeded process memo owners", () => {
    expect(peekCodexRuntimeProcessCache().kind).toBe("available");
    expect(bundledCatalogCacheState().valueIdentity).not.toBeNull();
    resetFixtureDiscovery();
    expect(peekCodexRuntimeProcessCache().kind).toBe("unavailable");
    expect(bundledCatalogCacheState().valueIdentity).toBeNull();
  });
});

describe("incoming environment changed after module evaluation", () => {
  let previousProfile: string | undefined;
  const incomingProfile = join(tmpdir(), "injection-incoming-profile");
  beforeAll(() => {
    previousProfile = process.env.USERPROFILE;
    process.env.USERPROFILE = incomingProfile;
  });
  afterAll(() => {
    try {
      expect(process.env.USERPROFILE).toBe(incomingProfile);
    } finally {
      if (previousProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = previousProfile;
    }
  });
  test("case cleanup restores its incoming environment, not the module snapshot", () => {
    expect(process.env.USERPROFILE).toBe(join(root, "home"));
  });
});
