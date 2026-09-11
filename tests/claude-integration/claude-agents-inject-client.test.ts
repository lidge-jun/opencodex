/**
 * The Claude Code spawn surface on a CONNECTED client (#4236).
 *
 * Two defects met here. `cmdClaude` gated the roster writer on `typeof route === "number"`,
 * which is false on a connected client, so `~/.claude/agents/ocx-*.md` stayed whatever a
 * previous standalone run had left — and even when it did run, it built the roster from local
 * `config.subagentModels`, the list this machine had before it joined the hub. The visible
 * symptom was five delegable native models on a client whose hub serves grok, with nothing in
 * the output admitting the roster described a different machine.
 *
 * So the cases below prove the roster can come from the hub, that a hub model whose provider is
 * absent from local config still yields a def instead of aborting the whole sync, that the
 * announced fallback is announced, and that none of this weakened the ownership marker — the one
 * invariant that keeps a user-authored `ocx-*.md` from being overwritten.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeAgentDefs, injectClaudeAgentDefs } from "../../src/claude/agents-inject";
import { resolveHubRosterForClaude } from "../../src/cli/claude";
import { syncClaudeAgentDefsAtProxyStartup } from "../../src/cli/claude-agent-startup-sync";
import type { HubStateResolution } from "../../src/client/hub-state";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ocx-agents-client-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) removeTreeWithRetry(d); });

const CONNECTION = {
  serverUrl: "https://hub.example.test:8443",
  apiKeyId: "client-one",
  connectedAt: "2026-09-01T00:00:00.000Z",
};

function clientConfig(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "mock",
    // Empty on purpose: a client stores no provider credentials, which is why a hub model's
    // provider is routinely absent from local config.
    providers: {},
    runtimeRole: "client",
    subagentModels: ["gpt-5.6-sol"],
    ...extra,
  } as OcxConfig;
}

describe("a hub-sourced roster drives the generated defs", () => {
  test("the hub's models become ocx-*.md even when their provider is absent locally", () => {
    const dir = tempDir();
    const defs = buildClaudeAgentDefs(clientConfig(), {}, dir, ["xai/grok-4.6", "gpt-5.6-sol"]);
    const names = defs.map(def => def.name);
    // The exact model the operator was told the hub could not serve.
    expect(names).toContain("ocx-grok-4-6");
    expect(names).toContain("ocx-gpt-5-6-sol");
    // No local `xai` provider means no routed-id decode, and the raw id must survive rather
    // than throwing and aborting the sync for every other model too.
    const grok = defs.find(def => def.name === "ocx-grok-4-6");
    expect(grok?.model).toContain("grok-4.6");
    expect(grok?.description).toContain("(xai)");
  });

  test("the local roster is ignored entirely when a hub roster is supplied", () => {
    const dir = tempDir();
    const defs = buildClaudeAgentDefs(
      clientConfig({ subagentModels: ["gpt-5.5", "gpt-5.6-terra"] }),
      {},
      dir,
      ["xai/grok-4.6"],
    );
    expect(defs.map(def => def.name)).toEqual(["ocx-grok-4-6"]);
  });

  test("an empty hub roster is honoured as empty, not read as 'no answer'", () => {
    const dir = tempDir();
    expect(buildClaudeAgentDefs(clientConfig(), {}, dir, [])).toEqual([]);
  });

  test("no override still means local config, byte for byte", () => {
    const dir = tempDir();
    const withoutOverride = buildClaudeAgentDefs(clientConfig(), {}, dir);
    const withLocalList = buildClaudeAgentDefs(clientConfig(), {}, dir, ["gpt-5.6-sol"]);
    expect(withoutOverride).toEqual(withLocalList);
  });

  test("the picker's five-row cap still applies to a longer hub roster", () => {
    const dir = tempDir();
    const defs = buildClaudeAgentDefs(clientConfig(), {}, dir, [
      "xai/grok-4.6", "a/one", "b/two", "c/three", "d/four", "e/five-should-not-appear",
    ]);
    expect(defs).toHaveLength(5);
    expect(defs.map(def => def.name)).not.toContain("ocx-five-should-not-appear");
  });
});

describe("injectClaudeAgentDefs on a client", () => {
  test("writes the hub roster and keeps the ownership marker", () => {
    const dir = tempDir();
    const written = injectClaudeAgentDefs(clientConfig(), {}, dir, ["xai/grok-4.6"]);
    expect(written).toEqual(["ocx-grok-4-6.md"]);
    const body = readFileSync(join(dir, "agents", "ocx-grok-4-6.md"), "utf8");
    expect(body).toContain("generated-by: opencodex");
  });

  test("a user-authored ocx-* file without the marker is never overwritten or pruned", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "agents"), { recursive: true });
    const mine = join(dir, "agents", "ocx-grok-4-6.md");
    writeFileSync(mine, "---\nname: ocx-grok-4-6\n---\nmy own agent\n");
    const stale = join(dir, "agents", "ocx-handwritten.md");
    writeFileSync(stale, "---\nname: ocx-handwritten\n---\nalso mine\n");
    injectClaudeAgentDefs(clientConfig(), {}, dir, ["xai/grok-4.6"]);
    expect(readFileSync(mine, "utf8")).toContain("my own agent");
    expect(readFileSync(stale, "utf8")).toContain("also mine");
  });

  test("injectAgents false still prunes owned files, roster override notwithstanding", () => {
    const dir = tempDir();
    injectClaudeAgentDefs(clientConfig(), {}, dir, ["xai/grok-4.6"]);
    expect(readdirSync(join(dir, "agents"))).toContain("ocx-grok-4-6.md");
    const pruned = injectClaudeAgentDefs(
      clientConfig({ claudeCode: { injectAgents: false } }),
      {},
      dir,
      ["xai/grok-4.6"],
    );
    expect(pruned).toEqual([]);
    expect(existsSync(join(dir, "agents", "ocx-grok-4-6.md"))).toBe(false);
  });
});

describe("resolveHubRosterForClaude", () => {
  function resolution(overrides: Partial<HubStateResolution>): HubStateResolution {
    return {
      stateSource: "hub",
      state: {
        schemaVersion: 1,
        runtimeRole: "hub",
        hubVersion: "2.51.0",
        origin: null,
        providers: [],
        oauth: [],
        subagentModels: ["xai/grok-4.6"],
        claudeCode: { enabled: true },
      },
      ...overrides,
    };
  }

  test("a live read hands back the hub's roster with no warning", async () => {
    const warnings: string[] = [];
    const roster = await resolveHubRosterForClaude(CONNECTION, "ocx_data_x", {
      resolve: async () => resolution({}),
      warn: message => { warnings.push(message); },
    });
    expect(roster).toEqual(["xai/grok-4.6"]);
    expect(warnings).toEqual([]);
  });

  test("an unreadable hub falls back to local config but SAYS so", async () => {
    // An unannounced fallback is the whole defect: a locally sourced roster is indistinguishable
    // from a hub-sourced one in the output.
    const warnings: string[] = [];
    const roster = await resolveHubRosterForClaude(CONNECTION, "ocx_data_x", {
      resolve: async () => ({ stateSource: "unavailable", state: null, reason: "the hub is unreachable" }),
      warn: message => { warnings.push(message); },
    });
    expect(roster).toBeUndefined();
    expect(warnings.join("\n")).toContain("Hub roster unavailable (the hub is unreachable)");
    expect(warnings.join("\n")).toContain("local subagentModels");
  });

  test("a cached roster is used and labelled as cached", async () => {
    const warnings: string[] = [];
    const roster = await resolveHubRosterForClaude(CONNECTION, "ocx_data_x", {
      resolve: async () => resolution({ stateSource: "cache", ageSeconds: 120, reason: "the hub is unreachable" }),
      warn: message => { warnings.push(message); },
    });
    expect(roster).toEqual(["xai/grok-4.6"]);
    expect(warnings.join("\n")).toContain("cached read 120s old");
  });

  test("a thrown resolver never takes the launch down with it", async () => {
    const warnings: string[] = [];
    const roster = await resolveHubRosterForClaude(CONNECTION, "ocx_data_x", {
      resolve: async () => { throw new Error("boom"); },
      warn: message => { warnings.push(message); },
    });
    expect(roster).toBeUndefined();
    expect(warnings.join("\n")).toContain("boom");
  });
});

describe("the proxy-startup roster sync", () => {
  test("uses the cached hub roster on a client and makes no network call", async () => {
    const dir = tempDir();
    let fetchedWindows = false;
    const written = await syncClaudeAgentDefsAtProxyStartup(clientConfig(), 10100, {
      fetchContextWindows: async () => { fetchedWindows = true; return {}; },
      readHubRoster: () => ["xai/grok-4.6"],
      injectAgentDefs: (config, windows, _configDir, roster) => injectClaudeAgentDefs(config, windows, dir, roster),
    });
    expect(written).toEqual(["ocx-grok-4-6.md"]);
    // The context-window read is the only live call this path has ever made; the roster itself
    // comes off disk so an offline hub cannot stand in the way of a local proxy start.
    expect(fetchedWindows).toBe(true);
  });

  test("a hub machine still writes nothing", async () => {
    const written = await syncClaudeAgentDefsAtProxyStartup(
      clientConfig({ runtimeRole: "hub", client: undefined }),
      10100,
      { readHubRoster: () => ["xai/grok-4.6"], injectAgentDefs: () => ["should-not-happen.md"] },
    );
    expect(written).toBeNull();
  });
});
