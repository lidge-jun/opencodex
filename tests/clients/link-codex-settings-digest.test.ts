/**
 * OCX-6b: `appliedCodexSettingsDigest`, the fingerprint GOAT's hub recomputes byte for byte.
 *
 * The golden values were computed outside this code, with `printf '%s' '<payload>' | shasum -a 256`
 * over the literal payloads below, so a change to the serialization fails here before it reaches a
 * peer that compares digests.
 */
import { describe, expect, test } from "bun:test";
import {
  codexSettingsDigest,
  codexSettingsDigestPayload,
  parseHomeCodexSettingsDocument,
  projectHomeCodexSettings,
  type HomeCodexSettings,
} from "../../src/link/codex-settings";
import type { OcxConfig } from "../../src/types";

const UNSET_DEFAULTS: HomeCodexSettings = {
  fastMode: true, multiAgentMode: "v1", webSearchSidecarEnabled: false, subagentDefaults: null,
};
const UNSET_PAYLOAD = '{"version":1,"settings":{"fastMode":true,"multiAgentMode":"v1","webSearchSidecarEnabled":false,"subagentDefaults":null}}';
const UNSET_DIGEST = "57c751eff89844f93db71a6ee4acdac03afbc29fec52734ade80a40193e826cd";

const SET_DEFAULTS: HomeCodexSettings = {
  fastMode: false, multiAgentMode: "v2", webSearchSidecarEnabled: true,
  subagentDefaults: { model: "anthropic/claude-sonnet-5-5", reasoningEffort: "high" },
};
const SET_PAYLOAD = '{"version":1,"settings":{"fastMode":false,"multiAgentMode":"v2","webSearchSidecarEnabled":true,"subagentDefaults":{"model":"anthropic/claude-sonnet-5-5","reasoningEffort":"high"}}}';
const SET_DIGEST = "55926fac816f7b59a00e01114d36742407fe79c42ad33a69271fb479ee8f346c";

describe("appliedCodexSettingsDigest", () => {
  test("serializes in the published key order and matches the hand-computed digests", () => {
    expect(codexSettingsDigestPayload(UNSET_DEFAULTS)).toBe(UNSET_PAYLOAD);
    expect(codexSettingsDigest(UNSET_DEFAULTS)).toBe(UNSET_DIGEST);
    expect(codexSettingsDigestPayload(SET_DEFAULTS)).toBe(SET_PAYLOAD);
    expect(codexSettingsDigest(SET_DEFAULTS)).toBe(SET_DIGEST);
  });

  test("the input's key order and the source JSON's whitespace do not change it", () => {
    const reordered = JSON.parse(`{
      "subagentDefaults" : { "reasoningEffort": "high", "model": "anthropic/claude-sonnet-5-5" },
      "webSearchSidecarEnabled": true,
      "multiAgentMode":   "v2",
      "fastMode": false
    }`) as HomeCodexSettings;
    expect(Object.keys(reordered)[0]).toBe("subagentDefaults");
    expect(codexSettingsDigest(reordered)).toBe(SET_DIGEST);
  });

  test("every applied value changes it", () => {
    const variants: HomeCodexSettings[] = [
      { ...SET_DEFAULTS, fastMode: true },
      { ...SET_DEFAULTS, multiAgentMode: "default" },
      { ...SET_DEFAULTS, webSearchSidecarEnabled: false },
      { ...SET_DEFAULTS, subagentDefaults: null },
      { ...SET_DEFAULTS, subagentDefaults: { model: "anthropic/claude-sonnet-5-5", reasoningEffort: "low" } },
      { ...SET_DEFAULTS, subagentDefaults: { model: "openai/gpt-6", reasoningEffort: "high" } },
    ];
    const digests = new Set(variants.map(codexSettingsDigest));
    expect(digests.size).toBe(variants.length);
    expect(digests.has(SET_DIGEST)).toBe(false);
    for (const digest of digests) expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a Home's projection and the document its Child parses agree, whatever the Home is called", () => {
    const config = {
      fastMode: false, multiAgentMode: "v2", webSearchSidecar: { enabled: true },
      syncCodexSubagentDefaults: true, injectionModel: " anthropic/claude-sonnet-5-5 ", injectionEffort: "high",
    } as unknown as OcxConfig;
    const home = projectHomeCodexSettings(config, "2.91.0");
    expect(codexSettingsDigest(home.settings)).toBe(SET_DIGEST);
    const wire = JSON.parse(JSON.stringify({ ...home, home: { name: "another-name", version: "2.80.0" } }));
    const child = parseHomeCodexSettingsDocument(wire);
    expect(child && codexSettingsDigest(child.settings)).toBe(SET_DIGEST);
  });
});
