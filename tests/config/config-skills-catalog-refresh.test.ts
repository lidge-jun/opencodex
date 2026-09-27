import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getConfigPath,
  getDefaultConfig,
  loadConfig,
  saveConfig,
  validateConfigCandidate,
} from "../../src/config";
import { resolveSkillsCatalogRefresh } from "../../src/server/responses/skills-snapshot";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let home = "";
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-skills-config-"));
  process.env.OPENCODEX_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function candidate(skills: unknown) {
  return {
    ...getDefaultConfig(),
    defaultProvider: "xai",
    providers: {
      xai: {
        adapter: "openai-responses",
        baseUrl: "https://api.x.ai/v1",
      },
    },
    skills,
  };
}

test("validateConfigCandidate accepts valid skills configuration", () => {
  const c1 = validateConfigCandidate(candidate({ catalog_refresh: "per_session" }));
  expect(c1.ok).toBe(true);
  if (c1.ok) {
    expect(c1.config.skills?.catalog_refresh).toBe("per_session");
  }

  const c2 = validateConfigCandidate(candidate({ catalog_refresh: "per_turn" }));
  expect(c2.ok).toBe(true);
  if (c2.ok) {
    expect(c2.config.skills?.catalog_refresh).toBe("per_turn");
  }

  const c3 = validateConfigCandidate(candidate({}));
  expect(c3.ok).toBe(true);

  const c4 = validateConfigCandidate(candidate(undefined));
  expect(c4.ok).toBe(true);
});

test("validateConfigCandidate explicitly rejects invalid skills configuration", () => {
  const badValue = validateConfigCandidate(candidate({ catalog_refresh: "invalid_refresh" }));
  expect(badValue.ok).toBe(false);
  if (!badValue.ok) {
    expect(badValue.error).toContain("schema_invalid: skills.catalog_refresh");
  }

  const extraProp = validateConfigCandidate(candidate({ catalog_refresh: "per_session", extra: 123 }));
  expect(extraProp.ok).toBe(false);
  if (!extraProp.ok) {
    expect(extraProp.error).toContain("schema_invalid: skills");
  }

  const nonObject = validateConfigCandidate(candidate("per_session"));
  expect(nonObject.ok).toBe(false);
  if (!nonObject.ok) {
    expect(nonObject.error).toContain("schema_invalid: skills");
  }
});

test("resolveSkillsCatalogRefresh defaults to per_session", () => {
  expect(resolveSkillsCatalogRefresh(undefined)).toBe("per_session");
  expect(resolveSkillsCatalogRefresh({} as any)).toBe("per_session");
  expect(resolveSkillsCatalogRefresh({ skills: {} } as any)).toBe("per_session");
  expect(resolveSkillsCatalogRefresh({ skills: { catalog_refresh: "per_session" } } as any)).toBe("per_session");
  expect(resolveSkillsCatalogRefresh({ skills: { catalog_refresh: "per_turn" } } as any)).toBe("per_turn");
});

test("skills configuration persists to disk and loads correctly", () => {
  const cfg = {
    ...getDefaultConfig(),
    skills: { catalog_refresh: "per_turn" as const },
  };
  saveConfig(cfg);

  const loaded = loadConfig();
  expect(loaded.skills?.catalog_refresh).toBe("per_turn");
});

test("malformed hand-edited skills in config file degrades gracefully on load", () => {
  const configPath = getConfigPath();
  const raw = JSON.stringify({
    ...getDefaultConfig(),
    skills: { catalog_refresh: "bad_value" },
  });
  writeFileSync(configPath, raw, "utf8");

  const loaded = loadConfig();
  expect(loaded.skills).toBeUndefined();
  expect(resolveSkillsCatalogRefresh(loaded)).toBe("per_session");
});

