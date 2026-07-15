/**
 * v2 / ultra catalog tests: ultra is always advertised regardless of v2 toggle.
 * The v2 toggle controls the multi-agent surface only, not ultra visibility.
 * config.toml reader + max_concurrent_threads_per_session writer fixtures.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { buildCatalogEntries, mergeCatalogEntriesForSync, nativeEffortClamp, type MultiAgentMode } from "../src/codex/catalog";
import {
  getAgentsMaxThreads,
  getLogicalMaxThreads,
  getMaxConcurrentThreads,
  hasAgentsMaxThreads,
  isMultiAgentV2Enabled,
  setMaxConcurrentThreads,
  transitionMultiAgentV2,
} from "../src/codex/features";
import { cmdV2, codexFeaturesInvocation, v2StatusLine, multiAgentModeLine } from "../src/cli/v2";
import { handleManagementAPI } from "../src/server/management-api";

function template(): Record<string, unknown> {
  return {
    slug: "gpt-5.5",
    display_name: "gpt-5.5",
    description: "Native GPT model",
    priority: 1,
    visibility: "list",
    base_instructions: "You are Codex, a coding agent based on GPT-5.\nUse tools carefully.",
    model_messages: { instructions_template: "You are Codex, a coding agent based on GPT-5." },
    tool_mode: "code",
    supported_reasoning_levels: [
      { effort: "low", description: "l" }, { effort: "medium", description: "m" },
      { effort: "high", description: "h" }, { effort: "xhigh", description: "x" },
    ],
    default_reasoning_level: "medium",
  };
}

function efforts(entry: { supported_reasoning_levels?: unknown }): string[] {
  return (entry.supported_reasoning_levels as Array<{ effort: string }> ?? []).map(l => l.effort);
}

function fixtureConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-v2-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, content);
  return path;
}

describe("catalog ultra (always-on)", () => {
  const routed = [{ id: "glm-5.2", provider: "opencode-go", reasoningEfforts: ["low", "medium", "high", "xhigh"] }];

  test("routed + old natives always advertise mock max AND ultra", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.5"], routed as never, [], false);
    const native = entries.find(e => e.slug === "gpt-5.5")!;
    const glm = entries.find(e => e.slug === "opencode-go/glm-5.2")!;
    expect(efforts(native)).toContain("ultra");
    expect(efforts(native)).toContain("max");
    expect(efforts(glm)).toContain("ultra");
    expect(efforts(glm)).toContain("max"); // mock max: adapters/wire clamp keep it honest
  });

  test("gpt-5.6-sol keeps native ultra + max; luna has max but no native ultra (upstream ladder)", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna"], [], [], false);
    const sol = entries.find(e => e.slug === "gpt-5.6-sol")!;
    const luna = entries.find(e => e.slug === "gpt-5.6-luna")!;
    expect(efforts(sol)).toContain("max");
    expect(efforts(sol)).toContain("ultra");
    expect(efforts(luna)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  test("sync preserves genuine native entries with ultra intact", () => {
    const diskSol = {
      ...template(),
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      supported_reasoning_levels: [
        { effort: "high", description: "h" }, { effort: "max", description: "m" }, { effort: "ultra", description: "u" },
      ],
      default_reasoning_level: "ultra",
    };
    const merged = mergeCatalogEntriesForSync([diskSol as never], [], new Map(), [], false);
    const sol = merged.find(e => e.slug === "gpt-5.6-sol")!;
    expect(efforts(sol)).toContain("ultra");
    expect(efforts(sol)).toContain("max");
    expect(sol.default_reasoning_level).toBe("ultra"); // preserved as-is
  });
});

describe("features.ts config reader", () => {
  test("table form: [features.multi_agent_v2] enabled = true", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 1000\n"))).toBe(true);
    expect(isMultiAgentV2Enabled(fixtureConfig("[features.multi_agent_v2]\nenabled = false\n"))).toBe(false);
  });

  test("boolean form under [features]", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent = true\nmulti_agent_v2 = true\n"))).toBe(true);
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent_v2 = false\n"))).toBe(false);
    // sibling key must not leak (multi_agent vs multi_agent_v2)
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent = true\n"))).toBe(false);
  });

  test("inline table form + absent file/key -> false", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features]\nmulti_agent_v2 = { enabled = true, tool_namespace = \"agents\" }\n"))).toBe(true);
    expect(isMultiAgentV2Enabled(fixtureConfig("model = \"gpt-5.5\"\n"))).toBe(false);
    expect(isMultiAgentV2Enabled("/nonexistent/config.toml")).toBe(false);
  });

  test("table detection stops at the next header (no bleed into later tables)", () => {
    expect(isMultiAgentV2Enabled(fixtureConfig("[features.multi_agent_v2]\n[notice]\nenabled = true\n"))).toBe(false);
  });

  test("hasAgentsMaxThreads detects the boot-conflict key", () => {
    expect(hasAgentsMaxThreads(fixtureConfig("[agents]\nmax_threads = 1000\n"))).toBe(true);
    expect(hasAgentsMaxThreads(fixtureConfig("[features.multi_agent_v2]\nenabled = true\n"))).toBe(false);
  });
});

describe("max_concurrent_threads_per_session reader/writer", () => {
  const TABLE = "# keep me\n[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 1000 # tuned\n\n[notice]\nhide = true\n";

  test("reader: present, absent key, absent table", () => {
    expect(getMaxConcurrentThreads(fixtureConfig(TABLE))).toBe(1000);
    expect(getMaxConcurrentThreads(fixtureConfig("[features.multi_agent_v2]\nenabled = true\n"))).toBe(null);
    expect(getMaxConcurrentThreads(fixtureConfig("[features]\nmulti_agent_v2 = true\n"))).toBe(null);
  });

  test("writer replaces in place, preserving comments and neighbors", () => {
    const path = fixtureConfig(TABLE);
    const result = setMaxConcurrentThreads(64, path);
    expect(result).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain("max_concurrent_threads_per_session = 64 # tuned");
    expect(out).toContain("# keep me");
    expect(out).toContain("[notice]\nhide = true");
    expect(getMaxConcurrentThreads(path)).toBe(64);
  });

  test("writer is idempotent: equal value -> no write, changed:false", () => {
    const path = fixtureConfig(TABLE);
    expect(setMaxConcurrentThreads(1000, path)).toEqual({ ok: true, changed: false });
    expect(readFileSync(path, "utf8")).toBe(TABLE); // byte-identical, no touch
  });

  test("writer inserts under the header when the key is absent", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\n\n[notice]\n");
    expect(setMaxConcurrentThreads(32, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out.indexOf("max_concurrent_threads_per_session = 32")).toBeGreaterThan(out.indexOf("[features.multi_agent_v2]"));
    expect(out.indexOf("max_concurrent_threads_per_session = 32")).toBeLessThan(out.indexOf("[notice]"));
  });

  test("writer upgrades the boolean form and rejects invalid values", () => {
    const booleanPath = fixtureConfig("[features]\nmulti_agent_v2 = true\n");
    expect(setMaxConcurrentThreads(8, booleanPath)).toEqual({ ok: true, changed: true });
    expect(getMaxConcurrentThreads(booleanPath)).toBe(8);
    expect(setMaxConcurrentThreads(0, fixtureConfig(TABLE)).ok).toBe(false);
    expect(setMaxConcurrentThreads(2.5, fixtureConfig(TABLE)).ok).toBe(false);
  });

  test("writer preserves CRLF files", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\r\nenabled = true\r\nmax_concurrent_threads_per_session = 4\r\n");
    expect(setMaxConcurrentThreads(8, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain("max_concurrent_threads_per_session = 8\r\n");
    expect(out).not.toMatch(/[^\r]\n/);
  });

  test("reader/writer supports the inline feature form emitted around CLI toggles", () => {
    const path = fixtureConfig("[features]\nmulti_agent_v2 = { enabled = true, max_concurrent_threads_per_session = 8 } # keep\n");
    expect(getMaxConcurrentThreads(path)).toBe(8);
    expect(setMaxConcurrentThreads(32, path)).toEqual({ ok: true, changed: true });
    expect(readFileSync(path, "utf8")).toContain("max_concurrent_threads_per_session = 32");
    expect(readFileSync(path, "utf8")).toContain("# keep");
  });

  test("inline writer does not mutate a neighboring prefixed key", () => {
    const path = fixtureConfig("[features]\nmulti_agent_v2 = { enabled = true, backup_max_concurrent_threads_per_session = 7 }\n");
    expect(setMaxConcurrentThreads(32, path)).toEqual({ ok: true, changed: true });
    const out = readFileSync(path, "utf8");
    expect(out).toContain("backup_max_concurrent_threads_per_session = 7");
    expect(out).toContain("max_concurrent_threads_per_session = 32");
  });

  test("boolean/inline migration preserves feature and limit comments without treating a prefix as the real key", () => {
    const path = fixtureConfig("[features]\nmulti_agent_v2 = false # keep feature\n\n[agents]\nmax_threads = 100 # tuned limit\n");
    const flipInlineFlag = (enabled: boolean) => {
      const content = readFileSync(path, "utf8");
      writeFileSync(path, content.replace(/enabled\s*=\s*(?:true|false)/, `enabled = ${enabled}`));
    };
    expect(transitionMultiAgentV2(true, flipInlineFlag, { configPath: path }).ok).toBe(true);
    const migrated = readFileSync(path, "utf8");
    expect(migrated).toContain("# keep feature; tuned limit");

    const prefixOnly = fixtureConfig("[features]\nmulti_agent_v2 = { enabled = false, backup_max_concurrent_threads_per_session = 7 } # keep\n\n[agents]\nmax_threads = 100\n");
    const flipPrefixFlag = (enabled: boolean) => {
      const content = readFileSync(prefixOnly, "utf8");
      writeFileSync(prefixOnly, content.replace(/enabled\s*=\s*(?:true|false)/, `enabled = ${enabled}`));
    };
    expect(transitionMultiAgentV2(true, flipPrefixFlag, { configPath: prefixOnly }).ok).toBe(true);
    expect(readFileSync(prefixOnly, "utf8")).toContain("backup_max_concurrent_threads_per_session = 7");
    expect(getMaxConcurrentThreads(prefixOnly)).toBe(100);
  });
});

describe("thread-limit-preserving v1/v2 transition", () => {
  const flipTableFlag = (path: string) => (enabled: boolean) => {
    const content = readFileSync(path, "utf8");
    writeFileSync(path, content.replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`));
  };

  test("off -> on carries the active legacy value and removes the boot conflict", () => {
    const path = fixtureConfig("# keep\n[agents]\nmax_threads = 100\nmax_depth = 2\n");
    const result = transitionMultiAgentV2(true, flipTableFlag(path), { configPath: path });
    expect(result).toEqual({ ok: true, changed: true, threadLimit: 100 });
    expect(isMultiAgentV2Enabled(path)).toBe(true);
    expect(getMaxConcurrentThreads(path)).toBe(100);
    expect(getAgentsMaxThreads(path)).toBe(null);
    expect(readFileSync(path, "utf8")).toContain("max_depth = 2");
    expect(readFileSync(path, "utf8")).toContain("# keep");
  });

  test("on -> off carries the active v2 value and removes v2 limit storage", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 64\n\n[agents]\nmax_depth = 2\n");
    const result = transitionMultiAgentV2(false, flipTableFlag(path), { configPath: path });
    expect(result).toEqual({ ok: true, changed: true, threadLimit: 64 });
    expect(isMultiAgentV2Enabled(path)).toBe(false);
    expect(getAgentsMaxThreads(path)).toBe(64);
    expect(getMaxConcurrentThreads(path)).toBe(null);
  });

  test("migration carries the active limit comment in both directions", () => {
    const path = fixtureConfig("[agents]\nmax_threads = 100 # tuned\n");
    expect(transitionMultiAgentV2(true, flipTableFlag(path), { configPath: path }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("max_concurrent_threads_per_session = 100 # tuned");
    expect(transitionMultiAgentV2(false, flipTableFlag(path), { configPath: path }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("max_threads = 100 # tuned");
  });

  test("same-state repair prefers active storage when duplicate values disagree", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = true\nmax_concurrent_threads_per_session = 32\n\n[agents]\nmax_threads = 100\n");
    let calls = 0;
    const result = transitionMultiAgentV2(true, () => { calls++; }, { configPath: path });
    expect(result).toEqual({ ok: true, changed: true, threadLimit: 32 });
    expect(calls).toBe(0);
    expect(getLogicalMaxThreads(path)).toBe(32);
    expect(getAgentsMaxThreads(path)).toBe(null);
  });

  test("target-only, equal duplicate, and disabled same-state cases converge", () => {
    const targetOnly = fixtureConfig("[features.multi_agent_v2]\nenabled = false\nmax_concurrent_threads_per_session = 32\n");
    expect(transitionMultiAgentV2(true, flipTableFlag(targetOnly), { configPath: targetOnly })).toMatchObject({ ok: true, threadLimit: 32 });
    expect(getLogicalMaxThreads(targetOnly)).toBe(32);

    const equal = fixtureConfig("[features.multi_agent_v2]\nenabled = false\nmax_concurrent_threads_per_session = 64\n\n[agents]\nmax_threads = 64\n");
    expect(transitionMultiAgentV2(true, flipTableFlag(equal), { configPath: equal })).toMatchObject({ ok: true, threadLimit: 64 });
    expect(getAgentsMaxThreads(equal)).toBe(null);

    const disabled = fixtureConfig("[features.multi_agent_v2]\nenabled = false\nmax_concurrent_threads_per_session = 32\n\n[agents]\nmax_threads = 100\n");
    let calls = 0;
    expect(transitionMultiAgentV2(false, () => { calls++; }, { configPath: disabled })).toMatchObject({ ok: true, threadLimit: 100 });
    expect(calls).toBe(0);
    expect(getAgentsMaxThreads(disabled)).toBe(100);
    expect(getMaxConcurrentThreads(disabled)).toBe(null);
  });

  test("explicit logical limit overrides both stored values", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = false\nmax_concurrent_threads_per_session = 32\n\n[agents]\nmax_threads = 100\n");
    const result = transitionMultiAgentV2(true, flipTableFlag(path), { configPath: path, threadLimit: 256 });
    expect(result).toEqual({ ok: true, changed: true, threadLimit: 256 });
    expect(getLogicalMaxThreads(path)).toBe(256);
  });

  test("unset limits stay unset in both directions", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = false\n");
    expect(transitionMultiAgentV2(true, flipTableFlag(path), { configPath: path }).ok).toBe(true);
    expect(getLogicalMaxThreads(path)).toBe(null);
    expect(transitionMultiAgentV2(false, flipTableFlag(path), { configPath: path }).ok).toBe(true);
    expect(getLogicalMaxThreads(path)).toBe(null);
  });

  test("throwing and ineffective feature commands restore the original bytes", () => {
    const original = "# exact\r\n[agents]\r\nmax_threads = 100 # tuned\r\n";
    const throwingPath = fixtureConfig(original);
    const thrown = transitionMultiAgentV2(true, () => { throw new Error("boom"); }, { configPath: throwingPath });
    expect(thrown.ok).toBe(false);
    expect(readFileSync(throwingPath, "utf8")).toBe(original);

    const noopPath = fixtureConfig(original);
    const ineffective = transitionMultiAgentV2(true, () => {}, { configPath: noopPath });
    expect(ineffective.ok).toBe(false);
    expect(readFileSync(noopPath, "utf8")).toBe(original);
  });

  test("ambiguous duplicate definitions are rejected before mutation", () => {
    const original = "[features]\nmulti_agent_v2 = false\n\n[features.multi_agent_v2]\nenabled = false\n\n[agents]\nmax_threads = 100\n";
    const path = fixtureConfig(original);
    let toggles = 0;
    const result = transitionMultiAgentV2(true, () => { toggles++; }, { configPath: path });
    expect(result.ok).toBe(false);
    expect(toggles).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});

describe("management API logical v1/v2 switching", () => {
  test("mode-only switches preserve the logical limit in both directions", async () => {
    const path = fixtureConfig("[agents]\nmax_threads = 100\nmax_depth = 2\n");
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOcxHome = process.env.OPENCODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-api-config-"));
    const config = { providers: [] } as never;
    const toggle = (enabled: boolean) => {
      const content = readFileSync(path, "utf8");
      writeFileSync(path, content.replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`));
    };
    const deps = { toggleCodexMultiAgentV2: toggle, refreshCodexCatalog: async () => {} };
    try {
      const toV2 = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ multiAgentMode: "v2" }),
      });
      const v2Response = await handleManagementAPI(toV2, new URL(toV2.url), config, deps);
      expect(v2Response?.status).toBe(200);
      expect(await v2Response?.json()).toMatchObject({ enabled: true, multiAgentMode: "v2", maxConcurrentThreadsPerSession: 100 });
      expect(getMaxConcurrentThreads(path)).toBe(100);
      expect(getAgentsMaxThreads(path)).toBe(null);

      const getV2 = new Request("http://localhost/api/v2");
      const getV2Response = await handleManagementAPI(getV2, new URL(getV2.url), config, deps);
      expect(await getV2Response?.json()).toMatchObject({ enabled: true, maxConcurrentThreadsPerSession: 100 });

      const toV1 = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ multiAgentMode: "v1" }),
      });
      const v1Response = await handleManagementAPI(toV1, new URL(toV1.url), config, deps);
      expect(v1Response?.status).toBe(200);
      expect(await v1Response?.json()).toMatchObject({ enabled: false, multiAgentMode: "v1", maxConcurrentThreadsPerSession: 100 });
      expect(getAgentsMaxThreads(path)).toBe(100);
      expect(getMaxConcurrentThreads(path)).toBe(null);

      const setV1Threads = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ maxConcurrentThreadsPerSession: 88 }),
      });
      expect((await handleManagementAPI(setV1Threads, new URL(setV1Threads.url), config, deps))?.status).toBe(200);
      expect(getAgentsMaxThreads(path)).toBe(88);

      const setV2Threads = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ multiAgentMode: "v2", maxConcurrentThreadsPerSession: 77 }),
      });
      expect((await handleManagementAPI(setV2Threads, new URL(setV2Threads.url), config, deps))?.status).toBe(200);
      expect(getMaxConcurrentThreads(path)).toBe(77);

      const defaultWithFlag = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ multiAgentMode: "default", enabled: false }),
      });
      const defaultResponse = await handleManagementAPI(defaultWithFlag, new URL(defaultWithFlag.url), config, deps);
      expect(await defaultResponse?.json()).toMatchObject({ enabled: false, multiAgentMode: "default", maxConcurrentThreadsPerSession: 77 });

      const get = new Request("http://localhost/api/v2");
      const getResponse = await handleManagementAPI(get, new URL(get.url), config, deps);
      expect(await getResponse?.json()).toMatchObject({ enabled: false, maxConcurrentThreadsPerSession: 77 });
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
      if (oldOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldOcxHome;
    }
  });

  test("contradictory mode and flag are rejected before config writes", async () => {
    const path = fixtureConfig("[agents]\nmax_threads = 100\n");
    const original = readFileSync(path, "utf8");
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    let toggles = 0;
    try {
      const req = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ multiAgentMode: "v2", enabled: false }),
      });
      const response = await handleManagementAPI(req, new URL(req.url), { providers: [] } as never, {
        toggleCodexMultiAgentV2: () => { toggles++; }, refreshCodexCatalog: async () => {},
      });
      expect(response?.status).toBe(400);
      expect(toggles).toBe(0);
      expect(readFileSync(path, "utf8")).toBe(original);

      const opposite = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ multiAgentMode: "v1", enabled: true }),
      });
      expect((await handleManagementAPI(opposite, new URL(opposite.url), { providers: [] } as never, {
        toggleCodexMultiAgentV2: () => { toggles++; }, refreshCodexCatalog: async () => {},
      }))?.status).toBe(400);
      expect(toggles).toBe(0);
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
    }
  });
});

describe("cli surface", () => {
  test("status lines describe the multi-agent surface", () => {
    expect(v2StatusLine(true)).toContain("ON");
    expect(v2StatusLine(false)).toContain("OFF");
  });

  test("codexFeaturesInvocation: POSIX passthrough; win32 .cmd routed through cmd.exe (devlog 260715 020)", () => {
    expect(codexFeaturesInvocation("enable", "darwin", { env: {} }))
      .toEqual({ file: "codex", args: ["features", "enable", "multi_agent_v2"], options: {} });
    // Explicit CODEX_CLI_PATH pointing at a .cmd (npm-only Windows Codex install).
    const inv = codexFeaturesInvocation("disable", "win32", {
      env: { CODEX_CLI_PATH: "C:\\npm\\codex.cmd", ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" },
      exists: () => { throw new Error("explicit path must not probe PATH"); },
    });
    expect(inv.file).toBe("C:\\WINDOWS\\system32\\cmd.exe");
    expect(inv.args).toEqual(["/d", "/s", "/c", '"C:\\npm\\codex.cmd ^"features^" ^"disable^" ^"multi_agent_v2^""']);
    expect(inv.options).toEqual({ windowsVerbatimArguments: true });
    // Bare `codex` resolving to codex.exe stays a direct spawn.
    const exe = codexFeaturesInvocation("enable", "win32", {
      env: { PATH: "C:\\bin" },
      exists: (p: string) => p === "C:\\bin\\codex.exe",
    });
    expect(exe).toEqual({ file: "C:\\bin\\codex.exe", args: ["features", "enable", "multi_agent_v2"], options: {} });
  });

  test("mode v2/v1 preserves the same logical limit", async () => {
    const path = fixtureConfig("[agents]\nmax_threads = 100\n");
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOcxHome = process.env.OPENCODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-cli-config-"));
    const logs: string[] = [];
    const deps = {
      execFile: (_file: string, args: string[]) => {
        // POSIX: ["features", "enable|disable", ...]; win32 .cmd: ["/d","/s","/c","...enable..."]
        const joined = args.join(" ");
        const enabled = args[1] === "enable" || /\benable\b/.test(joined);
        const content = readFileSync(path, "utf8");
        writeFileSync(path, content.replace(/^enabled\s*=\s*(?:true|false)$/m, `enabled = ${enabled}`));
      },
      sync: async () => {},
      log: { log: (message?: unknown) => { logs.push(String(message)); }, error: (message?: unknown) => { logs.push(String(message)); } },
    };
    try {
      expect(await cmdV2(["mode", "v2"], deps)).toBe(0);
      expect(isMultiAgentV2Enabled(path)).toBe(true);
      expect(getLogicalMaxThreads(path)).toBe(100);
      expect(await cmdV2(["threads", "77"], deps)).toBe(0);
      expect(getLogicalMaxThreads(path)).toBe(77);
      expect(await cmdV2(["off"], deps)).toBe(0);
      expect(isMultiAgentV2Enabled(path)).toBe(false);
      expect(getLogicalMaxThreads(path)).toBe(77);
      expect(await cmdV2(["on"], deps)).toBe(0);
      expect(isMultiAgentV2Enabled(path)).toBe(true);
      expect(getLogicalMaxThreads(path)).toBe(77);
      expect(await cmdV2(["mode", "v1"], deps)).toBe(0);
      expect(isMultiAgentV2Enabled(path)).toBe(false);
      expect(getLogicalMaxThreads(path)).toBe(77);
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
      if (oldOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldOcxHome;
    }
  });
});

describe("mock-max wire clamp (nativeEffortClamp)", () => {
  test("gpt-5.5 max/ultra clamp to its real top rung (xhigh)", () => {
    expect(nativeEffortClamp("gpt-5.5", "max")).toBe("xhigh");
    expect(nativeEffortClamp("gpt-5.5", "ultra")).toBe("xhigh");
  });

  test("real-max natives are untouched", () => {
    expect(nativeEffortClamp("gpt-5.6-sol", "max")).toBe(null);
    expect(nativeEffortClamp("gpt-5.6-luna", "max")).toBe(null);
  });

  test("ordinary efforts and routed slugs pass through; unknown BARE natives clamp conservatively", () => {
    expect(nativeEffortClamp("gpt-5.5", "high")).toBe(null);
    expect(nativeEffortClamp("gpt-5.5", undefined)).toBe(null);
    expect(nativeEffortClamp("opencode-go/glm-5.2", "max")).toBe(null);
    // off-snapshot bare native = old low..xhigh ladder -> clamp; future 5.6 variants stay free
    expect(nativeEffortClamp("gpt-totally-unknown", "max")).toBe("xhigh");
    expect(nativeEffortClamp("gpt-5.6-future", "max")).toBe(null);
  });
});

describe("3-state multi-agent mode", () => {
  test("mode v1: ALL entries get multi_agent_version = v1 (overrides upstream pins)", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"], [], [], false, "v1");
    for (const e of entries) {
      expect(e.multi_agent_version).toBe("v1");
    }
  });

  test("mode v2: ALL entries get multi_agent_version = v2 (overrides upstream pins)", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"], [], [], false, "v2");
    for (const e of entries) {
      expect(e.multi_agent_version).toBe("v2");
    }
  });

  test("mode default: upstream pins preserved (sol=v2, luna=v1, others=null)", () => {
    const entries = buildCatalogEntries(template(), ["gpt-5.6-sol", "gpt-5.6-luna", "gpt-5.5"], [], [], false, "default");
    const sol = entries.find(e => e.slug === "gpt-5.6-sol")!;
    const luna = entries.find(e => e.slug === "gpt-5.6-luna")!;
    const native = entries.find(e => e.slug === "gpt-5.5")!;
    expect(sol.multi_agent_version).toBe("v2");
    expect(luna.multi_agent_version).toBe("v1");
    // gpt-5.5 follows codex flag (null in catalog → codex decides)
    expect(native.multi_agent_version).toBeUndefined();
  });

  test("mode v1 in mergeCatalogEntriesForSync overrides preserved genuine native", () => {
    const diskSol = {
      ...template(),
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6 Sol",
      multi_agent_version: "v2",
    };
    const merged = mergeCatalogEntriesForSync(
      [diskSol as never], [], new Map(), [], false,
      new Set(), null, new Set(), new Set(), "v1",
    );
    const sol = merged.find(e => e.slug === "gpt-5.6-sol")!;
    expect(sol.multi_agent_version).toBe("v1");
  });

  test("cli multiAgentModeLine describes each state", () => {
    expect(multiAgentModeLine("v1")).toContain("v1");
    expect(multiAgentModeLine("default")).toContain("default");
    expect(multiAgentModeLine("v2")).toContain("v2");
  });

  test("mode default restores upstream pins after a prior forced v2 (stale-clear regression)", () => {
    // Simulate: disk entries were synced while mode=v2 (all entries stamped v2),
    // then mode switched to default. mergeCatalogEntriesForSync must clear the
    // stale forced value and restore upstream pins.
    const diskSol = { ...template(), slug: "gpt-5.6-sol", display_name: "GPT-5.6 Sol", multi_agent_version: "v2" };
    const diskLuna = { ...template(), slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", multi_agent_version: "v2" }; // was forced
    const diskNative = { ...template(), slug: "gpt-5.5", display_name: "gpt-5.5", multi_agent_version: "v2" }; // was forced
    const merged = mergeCatalogEntriesForSync(
      [diskSol as never, diskLuna as never, diskNative as never],
      [], new Map(), [], false, new Set(), null, new Set(), new Set(), "default",
    );
    const sol = merged.find(e => e.slug === "gpt-5.6-sol")!;
    const luna = merged.find(e => e.slug === "gpt-5.6-luna")!;
    const native = merged.find(e => e.slug === "gpt-5.5")!;
    // sol upstream pin is v2 — restored
    expect(sol.multi_agent_version).toBe("v2");
    // luna upstream pin is v1 — restored from snapshot, NOT stale v2
    expect(luna.multi_agent_version).toBe("v1");
    // gpt-5.5 has no upstream pin — cleared (codex flag decides)
    expect(native.multi_agent_version).toBeUndefined();
  });
});
