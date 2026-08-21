import { afterEach, describe, expect, mock, test } from "bun:test";
import * as storeModule from "../src/oauth/store";
import * as usabilityModule from "../src/codex/account-usability";
import * as modelRowsModule from "../src/server/management/model-rows";

let accountSets: Record<string, { accounts: Array<{ id: string; needsReauth?: boolean }>; activeAccountId?: string }> = {};
let usableCodexAccounts: Set<string> = new Set();
let managementRows: Array<Record<string, unknown>> | Error = [];

mock.module("../src/oauth/store", () => ({
  ...storeModule,
  getAccountSet: (provider: string) => accountSets[provider] ?? null,
}));
mock.module("../src/codex/account-usability", () => ({
  ...usabilityModule,
  isCodexAccountUsable: (_config: unknown, accountId: string) => usableCodexAccounts.has(accountId),
}));
mock.module("../src/server/management/model-rows", () => ({
  ...modelRowsModule,
  listManagementModelRows: async () => {
    if (managementRows instanceof Error) throw managementRows;
    return managementRows;
  },
}));

import { pickerVisibleSidecarCandidates, visionSidecarCandidates } from "../src/sidecar/candidates";
import { resolveSidecarAuth } from "../src/sidecar/auth";
import { visionCandidateRows, visionDescriberIsProvablyBlind } from "../src/server/management/vision-sidecar-options";
import { MAIN_CODEX_ACCOUNT_ID } from "../src/codex/account-id";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

const forward: OcxProviderConfig = { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" };
const anthropicOAuth: OcxProviderConfig = { adapter: "anthropic", baseUrl: "https://api.anthropic.com", authMode: "oauth" };

function config(overrides: Partial<OcxConfig> = {}): OcxConfig {
  return { port: 10100, defaultProvider: "openai", providers: { openai: forward }, ...overrides };
}

afterEach(() => {
  accountSets = {};
  usableCodexAccounts = new Set();
  managementRows = [];
});

function loginBoth(): void {
  usableCodexAccounts.add(MAIN_CODEX_ACCOUNT_ID);
  accountSets = { claude: { accounts: [{ id: "a1" }], activeAccountId: "a1" } };
}

describe("pickerVisibleSidecarCandidates", () => {
  test("disabled rows disappear; hidden Luna survives via the auth slot", async () => {
    loginBoth();
    managementRows = [
      { provider: "openai", id: "gpt-5.6-luna", disabled: true, native: true },
      { provider: "openai", id: "gpt-5.6-terra", disabled: false, native: true },
      { provider: "routed", id: "some-model", disabled: false },
    ];
    const cfg = config({ providers: { openai: forward, claude: anthropicOAuth } });
    const all = await pickerVisibleSidecarCandidates(cfg, resolveSidecarAuth(cfg));
    const ids = all.map(c => `${c.provider}/${c.id}`).sort();
    expect(ids).toEqual([
      "claude/claude-haiku-4-5",
      "openai/gpt-5.6-luna",
      "openai/gpt-5.6-terra",
      "routed/some-model",
    ]);
    expect(all.find(c => c.id === "gpt-5.6-luna")?.authSlot).toBe(true);
  });

  test("picker-visible slot model keeps the slot flag (slot wins de-dup)", async () => {
    loginBoth();
    managementRows = [{ provider: "openai", id: "gpt-5.6-luna", disabled: false, native: true }];
    const cfg = config({ providers: { openai: forward, claude: anthropicOAuth } });
    const all = await pickerVisibleSidecarCandidates(cfg, resolveSidecarAuth(cfg));
    expect(all.filter(c => c.id === "gpt-5.6-luna")).toHaveLength(1);
    expect(all.find(c => c.id === "gpt-5.6-luna")?.authSlot).toBe(true);
  });

  test("catalog outage degrades to auth slots only, not a 500", async () => {
    loginBoth();
    managementRows = new Error("catalog down");
    const cfg = config({ providers: { openai: forward, claude: anthropicOAuth } });
    const all = await pickerVisibleSidecarCandidates(cfg, resolveSidecarAuth(cfg));
    expect(all.map(c => c.id).sort()).toEqual(["claude-haiku-4-5", "gpt-5.6-luna"]);
  });

  test("no logins and empty catalog -> empty set", async () => {
    const all = await pickerVisibleSidecarCandidates(config(), resolveSidecarAuth(config()));
    expect(all).toEqual([]);
  });
});

describe("visionSidecarCandidates (rule 2: − provably text-only)", () => {
  test("provably text-only row excluded; unknown stays; slots stay", async () => {
    loginBoth();
    managementRows = [
      { provider: "routed", id: "text-model", disabled: false, inputModalities: ["text"] },
      { provider: "routed", id: "unknown-model", disabled: false },
    ];
    const cfg = config({ providers: { openai: forward, claude: anthropicOAuth } });
    const all = await pickerVisibleSidecarCandidates(cfg, resolveSidecarAuth(cfg));
    const vision = visionSidecarCandidates(cfg, all);
    const ids = vision.map(c => c.id).sort();
    expect(ids).toEqual(["claude-haiku-4-5", "gpt-5.6-luna", "unknown-model"]);
  });

  test("noVisionModels consumer listing beats the slot's advertised modalities", async () => {
    loginBoth();
    const blindLuna: OcxProviderConfig = { ...forward, noVisionModels: ["gpt-5.6-luna"] };
    const cfg = config({ providers: { openai: blindLuna, claude: anthropicOAuth } });
    const all = await pickerVisibleSidecarCandidates(cfg, resolveSidecarAuth(cfg));
    const vision = visionSidecarCandidates(cfg, all);
    expect(vision.map(c => c.id)).not.toContain("gpt-5.6-luna");
    expect(vision.map(c => c.id)).toContain("claude-haiku-4-5");
  });
});

describe("write-gate evidence is NOT pre-filtered (review F1 regression)", () => {
  test("a picker row proving an id text-only still reaches the PUT gate and rejects it", async () => {
    loginBoth();
    managementRows = [
      { provider: "routed", id: "row-proven-blind", disabled: false, inputModalities: ["text"] },
    ];
    const cfg = config({ providers: { openai: forward, claude: anthropicOAuth } });
    const candidates = await visionCandidateRows(cfg);
    // The evidence row must survive into the candidates list...
    expect(candidates.map(c => c.id)).toContain("row-proven-blind");
    // ...so the gate can prove blindness from it (neither vendor table knows this id).
    expect(visionDescriberIsProvablyBlind(cfg, "row-proven-blind", candidates, undefined)).toBe(true);
  });
});
