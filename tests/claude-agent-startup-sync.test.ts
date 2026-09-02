import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  reconcileClientStartupBeforeReady,
  syncClaudeAgentDefsAtProxyStartup,
} from "../src/cli/claude-agent-startup-sync";
import { injectClaudeAgentDefs } from "../src/claude/agents-inject";
import { createReadinessGate } from "../src/server/readiness";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const config = (claudeCode: OcxConfig["claudeCode"] = {}): OcxConfig => ({
  providers: [],
  claudeCode,
} as OcxConfig);

describe("Claude agent roster proxy-start synchronization (#2200)", () => {
  test("keeps readiness pending until the best-effort roster fence settles", async () => {
    const gate = createReadinessGate();
    let releaseRoster!: () => void;
    const rosterPending = new Promise<void>(resolve => { releaseRoster = resolve; });

    const startup = reconcileClientStartupBeforeReady(
      gate,
      async deferredGate => {
        deferredGate.markReady();
        return { ran: true };
      },
      () => rosterPending,
    );

    await Promise.resolve();
    expect(gate.getStatus()).toBe("pending");
    releaseRoster();
    expect(await startup).toEqual({ ran: true });
    expect(gate.getStatus()).toBe("ready");
  });

  test("uses the live proxy context-window map for an enabled roster", async () => {
    const calls: Array<{ port: number; windows?: Record<string, number> }> = [];
    const result = await syncClaudeAgentDefsAtProxyStartup(config(), 10100, {
      fetchContextWindows: async (_cfg, port) => {
        calls.push({ port });
        return { "google/gemini-3.7-flash": 1_000_000 };
      },
      injectAgentDefs: (_cfg, windows) => {
        calls.push({ port: 0, windows });
        return ["ocx-google-gemini-3-7-flash.md"];
      },
    });

    expect(result).toEqual(["ocx-google-gemini-3-7-flash.md"]);
    expect(calls).toEqual([
      { port: 10100 },
      { port: 0, windows: { "google/gemini-3.7-flash": 1_000_000 } },
    ]);
  });

  test("disabled integration prunes owned definitions without touching discovery", async () => {
    let fetched = false;
    let injected: Record<string, number> | undefined;
    const result = await syncClaudeAgentDefsAtProxyStartup(config({ injectAgents: false }), 10100, {
      fetchContextWindows: async () => {
        fetched = true;
        return { stale: 1_000_000 };
      },
      injectAgentDefs: (_cfg, windows) => {
        injected = windows;
        return [];
      },
    });

    expect(result).toEqual([]);
    expect(fetched).toBe(false);
    expect(injected).toEqual({});
  });

  test("catalog failure still runs the real injector with an unmarked roster", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-startup-roster-"));
    try {
      const configured = {
        providers: [],
        subagentModels: ["gpt-5.6-sol"],
        claudeCode: { model: "gpt-5.6-sol" },
      } as OcxConfig;
      const result = await syncClaudeAgentDefsAtProxyStartup(configured, 10100, {
        fetchContextWindows: async () => { throw new Error("catalog unavailable"); },
        injectAgentDefs: (cfg, windows) => injectClaudeAgentDefs(cfg, windows, dir),
      });

      expect(result?.sort()).toEqual(["ocx-gpt-5-6-sol.md", "ocx-self.md"]);
      expect(readdirSync(join(dir, "agents")).sort()).toEqual(result?.sort());
      for (const file of result ?? []) {
        const body = readFileSync(join(dir, "agents", file), "utf8");
        expect(body).toContain("generated-by: opencodex");
        expect(body).not.toContain("[1m]");
      }
    } finally {
      removeTreeWithRetry(dir);
    }
  });

  test("write failures are warned and never fail proxy startup", async () => {
    const warnings: string[] = [];
    const result = await syncClaudeAgentDefsAtProxyStartup(config(), 10100, {
      fetchContextWindows: async () => ({}),
      injectAgentDefs: () => { throw new Error("permission denied"); },
      warn: message => warnings.push(message),
    });

    expect(result).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("permission denied");
  });
});
