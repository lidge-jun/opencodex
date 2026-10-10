// INV-DESKTOPWIRE-01: the Desktop 3P decoder is seeded from disk before discovery, so a cold
// start with degraded provider discovery still decodes the wire ids the static Desktop profile
// actually sends, instead of falling through to passthrough or an unresolved-alias error.
// Regression for the cold-start 529: an empty in-memory registry could not decode the ids the
// on-disk profile was written with. Two disk sources: the persisted profile (self-healing, no
// sidecar needed) and the exact .ocx-wire.json sidecar.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  buildDesktop3pRegistry,
  buildDesktop3pRegistryPreserving,
  deriveDesktop3pWireMap,
  desktop3pRegistrySize,
  desktop3pWireMapPath,
  generateDesktop3pModels,
  readDesktop3pWireMap,
  resolveDesktop3pAlias,
  writeDesktop3pWireMap,
} from "../../src/claude/desktop-3p";
import { seedDesktop3pRegistryFromDisk } from "../../src/claude/desktop-3p-startup";
import { parseDesktopProfile } from "../../src/claude/desktop-profile";
import type { OcxConfig } from "../../src/types";

const PROFILE_ID = "ocx-wire-map-profile";
const PROFILE = parseDesktopProfile({
  version: 1,
  assignments: {
    "buddy/glm-5.3": { family: "opus", alias: "claude-opus-4-8-20260529" },
    "buddy/deepseek-v4.1-flash": { family: "sonnet", alias: "claude-opus-4-8-20260106" },
    "buddy/kimi-k3-1": { family: "fable", alias: "claude-opus-4-8-20260820" },
    "buddy/glm-5.3-flash": { family: "haiku", alias: "claude-opus-4-8-20260118" },
    "gemini/gemini-3.8-flash-high": { family: "opus", alias: "claude-opus-4-8-20260119" },
  },
  defaults: { opus: "buddy/glm-5.3", fable: "buddy/kimi-k3-1", sonnet: "buddy/deepseek-v4.1-flash", haiku: "buddy/glm-5.3-flash" },
});
const ROUTES = Object.keys(PROFILE.assignments).map(route => {
  const slash = route.indexOf("/");
  return { provider: route.slice(0, slash), id: route.slice(slash + 1) };
});
const OTHER_ROUTES = ROUTES.filter(model => model.provider !== "gemini");
const CONFIG = { claudeCode: { desktopProfile: PROFILE } } as unknown as OcxConfig;

// Scheme-independent oracle, captured ONCE at module load (the writer installs the live registry
// as a side effect, so it must not be re-invoked after a test empties that registry). The ids are
// read back from the writer rather than hardcoded, so the test holds across wire-id schemes
// (borrowed official slots, hash codes, p-prefixed date slots alike).
function sorted(map: Map<string, string>): Array<[string, string]> {
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}
const WRITTEN = buildDesktop3pRegistry([], ROUTES, PROFILE);
const EMITTED = generateDesktop3pModels([], ROUTES, PROFILE).map(entry => entry.name);
buildDesktop3pRegistry([], []);

let previousDir: string | undefined;
let library: string;
beforeEach(() => {
  previousDir = process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  library = mkdtempSync(join(tmpdir(), "ocx-wire-map-"));
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = library;
});
afterEach(() => {
  if (previousDir === undefined) delete process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR;
  else process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = previousDir;
  removeTreeWithRetry(library);
  buildDesktop3pRegistry([], []);
});

/** Reproduce what writeDesktop3pConfig leaves on disk: an owned profile row, plus its wire sidecar. */
function writeOwnedLibrary(options: { sidecar?: boolean } = {}): void {
  writeFileSync(join(library, "_meta.json"), JSON.stringify({ appliedId: PROFILE_ID, entries: [{ id: PROFILE_ID, name: "opencodex" }] }));
  writeFileSync(join(library, PROFILE_ID + ".json"), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret", inferenceModels: [],
  }));
  if (options.sidecar !== false) writeDesktop3pWireMap(library, PROFILE_ID, WRITTEN);
}

test("the persisted profile alone reproduces the exact wire ids the writer emits", () => {
  // The writer allocates every wire id from the profile's own route set, so replaying it offline
  // yields byte-identical ids. This is what lets an install predating the sidecar heal.
  expect(sorted(deriveDesktop3pWireMap(PROFILE))).toEqual(sorted(WRITTEN));
  for (const name of EMITTED) expect(WRITTEN.get(name)).toBeDefined();
});

test("a cold start with degraded discovery decodes the written wire ids from disk", () => {
  writeOwnedLibrary();
  // Cold start: discovery produced nothing, so the in-memory registry is empty.
  buildDesktop3pRegistry([], [], PROFILE);
  expect(desktop3pRegistrySize()).toBe(0);
  // The failure this fixes: the emitted ids are not decodable before the seed.
  expect(EMITTED.some(name => resolveDesktop3pAlias(name) === null)).toBe(true);

  seedDesktop3pRegistryFromDisk(CONFIG);
  for (const name of EMITTED) expect(resolveDesktop3pAlias(name)).toBe(WRITTEN.get(name));
  expect(desktop3pRegistrySize()).toBeGreaterThan(0);
});

test("a cold start heals from the persisted profile even when no sidecar exists", () => {
  // The real case: a profile written by a build that predates the sidecar.
  writeOwnedLibrary({ sidecar: false });
  expect(existsSync(desktop3pWireMapPath(library, PROFILE_ID))).toBe(false);
  buildDesktop3pRegistry([], [], PROFILE);
  expect(EMITTED.some(name => resolveDesktop3pAlias(name) === null)).toBe(true);

  seedDesktop3pRegistryFromDisk(CONFIG);
  for (const name of EMITTED) expect(resolveDesktop3pAlias(name)).toBe(WRITTEN.get(name));
});

test("a discovery build preserves the disk-seeded decoder instead of replacing it", () => {
  writeOwnedLibrary();
  buildDesktop3pRegistry([], [], PROFILE);
  seedDesktop3pRegistryFromDisk(CONFIG);
  for (const name of EMITTED) expect(resolveDesktop3pAlias(name)).toBe(WRITTEN.get(name));

  // Discovery ran but returned nothing (providers still down): the seed must survive.
  buildDesktop3pRegistryPreserving([], [], PROFILE);
  for (const name of EMITTED) expect(resolveDesktop3pAlias(name)).toBe(WRITTEN.get(name));
});

test("a discovery build still lets a fresh mapping override the disk seed", () => {
  writeOwnedLibrary();
  buildDesktop3pRegistry([], [], PROFILE);
  seedDesktop3pRegistryFromDisk(CONFIG);
  const remapped = parseDesktopProfile({
    version: 1,
    assignments: { "xai/grok-4.7": { family: "haiku", alias: "claude-opus-4-8-20260303" } },
    defaults: { opus: null, fable: null, sonnet: null, haiku: "xai/grok-4.7" },
  });
  const routed = [{ provider: "xai", id: "grok-4.7" }];
  buildDesktop3pRegistryPreserving([], routed, remapped);
  const haikuWire = [...buildDesktop3pRegistry([], routed, remapped).entries()]
    .find(([, route]) => route === "xai/grok-4.7");
  expect(haikuWire).toBeDefined();
  expect(resolveDesktop3pAlias(haikuWire![0])).toBe("xai/grok-4.7");
});

test("a malformed sidecar cannot break the profile-derived decoder", () => {
  writeOwnedLibrary();
  writeFileSync(desktop3pWireMapPath(library, PROFILE_ID), "{ not json");
  expect(readDesktop3pWireMap(library, PROFILE_ID).size).toBe(0);
  buildDesktop3pRegistry([], [], PROFILE);
  seedDesktop3pRegistryFromDisk(CONFIG);
  expect(desktop3pRegistrySize()).toBeGreaterThan(0);
  for (const name of EMITTED) expect(resolveDesktop3pAlias(name)).toBe(WRITTEN.get(name));
});

test("a missing profile leaves the decoder empty and does not throw", () => {
  process.env.OPENCODEX_CLAUDE_DESKTOP_CONFIG_DIR = join(library, "missing");
  buildDesktop3pRegistry([], [], PROFILE);
  expect(() => seedDesktop3pRegistryFromDisk()).not.toThrow();
  expect(desktop3pRegistrySize()).toBe(0);
});

test("writeDesktop3pWireMap is independent of the live registry and round-trips", () => {
  writeDesktop3pWireMap(library, PROFILE_ID, WRITTEN);
  expect(existsSync(desktop3pWireMapPath(library, PROFILE_ID))).toBe(true);
  expect(sorted(readDesktop3pWireMap(library, PROFILE_ID))).toEqual(sorted(WRITTEN));
});

test("excluded routes never take a wire slot in the derived decoder", () => {
  const derived = deriveDesktop3pWireMap(PROFILE, ["gemini/gemini-3.8-flash-high"]);
  expect([...derived.values()].includes("gemini/gemini-3.8-flash-high")).toBe(false);
  // The remaining routes still resolve under a writer that never saw the excluded route.
  const limited = buildDesktop3pRegistry([], OTHER_ROUTES, PROFILE);
  for (const entry of generateDesktop3pModels([], OTHER_ROUTES, PROFILE)) {
    expect(resolveDesktop3pAlias(entry.name)).toBe(limited.get(entry.name));
  }
});

test("the seed drops config-disabled routes exactly as the writer does", () => {
  // A route the operator disabled drops out of the catalog-visible writer set, so the replay must
  // drop it too or the allocation would shift out from under the written bytes.
  const disabledConfig = {
    disabledModels: ["gemini/gemini-3.8-flash-high"],
    claudeCode: { desktopProfile: PROFILE },
  } as unknown as OcxConfig;
  const derived = deriveDesktop3pWireMap(PROFILE, disabledConfig.disabledModels);
  expect([...derived.values()].includes("gemini/gemini-3.8-flash-high")).toBe(false);
  expect(derived).toEqual(deriveDesktop3pWireMap(PROFILE, ["gemini/gemini-3.8-flash-high"]));

  writeOwnedLibrary({ sidecar: false });
  buildDesktop3pRegistry([], [], PROFILE);
  seedDesktop3pRegistryFromDisk(disabledConfig);
  for (const [alias, route] of derived) expect(resolveDesktop3pAlias(alias)).toBe(route);
});

test("an applied model change re-derives the wire ids on the next cold start", () => {
  const changed = parseDesktopProfile({
    version: 1,
    assignments: {
      "buddy/glm-5.4": { family: "opus", alias: "claude-opus-4-8-20260529" },
      "buddy/new-haiku": { family: "haiku", alias: "claude-opus-4-8-20260118" },
    },
    defaults: { opus: "buddy/glm-5.4", fable: null, sonnet: null, haiku: "buddy/new-haiku" },
  });
  const changedRoutes = Object.keys(changed.assignments).map(route => {
    const slash = route.indexOf("/");
    return { provider: route.slice(0, slash), id: route.slice(slash + 1) };
  });
  const changedRegistry = buildDesktop3pRegistry([], changedRoutes, changed);
  const oldHaiku = [...WRITTEN.entries()].find(([, route]) => route === "buddy/glm-5.3-flash")![0];
  // First apply writes the OLD profile and its sidecar.
  writeOwnedLibrary();
  buildDesktop3pRegistry([], [], PROFILE);
  seedDesktop3pRegistryFromDisk(CONFIG);
  expect(resolveDesktop3pAlias(oldHaiku)).toBe("buddy/glm-5.3-flash");

  // The operator switches models and applies: the apply rewrites BOTH the profile and its sidecar.
  writeFileSync(join(library, PROFILE_ID + ".json"), JSON.stringify({
    inferenceProvider: "gateway", inferenceCredentialKind: "static",
    inferenceGatewayBaseUrl: "http://127.0.0.1:10100", inferenceGatewayApiKey: "not-a-secret", inferenceModels: [],
  }));
  writeDesktop3pWireMap(library, PROFILE_ID, changedRegistry);
  // Next cold start: registry empty, seed reads the new sidecar + new profile.
  buildDesktop3pRegistry([], []);
  seedDesktop3pRegistryFromDisk({ claudeCode: { desktopProfile: changed } } as unknown as OcxConfig);
  for (const [alias, route] of changedRegistry) expect(resolveDesktop3pAlias(alias)).toBe(route);
  const newHaiku = [...changedRegistry.entries()].find(([, route]) => route === "buddy/new-haiku");
  expect(resolveDesktop3pAlias(newHaiku![0])).toBe("buddy/new-haiku");
});

test("the applied sidecar wins over a newer desired profile", () => {
  const newer = parseDesktopProfile({
    version: 1,
    assignments: { "buddy/glm-5.4": { family: "opus", alias: "claude-opus-4-8-20260529" } },
    defaults: { opus: "buddy/glm-5.4", fable: null, sonnet: null, haiku: null },
  });
  writeOwnedLibrary(); // sidecar describes the OLD applied routes
  buildDesktop3pRegistry([], [], PROFILE);
  seedDesktop3pRegistryFromDisk({ claudeCode: { desktopProfile: newer } } as unknown as OcxConfig);
  // Desktop still sends the applied ids, so those keep decoding to the applied routes.
  for (const [alias, route] of WRITTEN) expect(resolveDesktop3pAlias(alias)).toBe(route);
});

test("removing a route updates the derived decoder", () => {
  const reduced = parseDesktopProfile({
    version: 1,
    assignments: {
      "buddy/glm-5.3": { family: "opus", alias: "claude-opus-4-8-20260529" },
      "buddy/glm-5.3-flash": { family: "haiku", alias: "claude-opus-4-8-20260118" },
    },
    defaults: { opus: "buddy/glm-5.3", fable: null, sonnet: null, haiku: "buddy/glm-5.3-flash" },
  });
  const derived = deriveDesktop3pWireMap(reduced);
  expect([...derived.values()].some(route => route.startsWith("gemini/"))).toBe(false);
  expect([...derived.values()].includes("buddy/glm-5.3")).toBe(true);
  expect([...derived.values()].includes("buddy/glm-5.3-flash")).toBe(true);
});

