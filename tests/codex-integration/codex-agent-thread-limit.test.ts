import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getAgentsMaxThreads, getLogicalMaxThreads, getMaxConcurrentThreads, hasAgentsMaxThreads, transitionMultiAgentV2 } from "../../src/codex/features";
import { handleManagementAPI } from "../../src/server/management-api";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";

function fixtureConfig(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-canonical-limit-"));
  const path = join(dir, "config.toml");
  writeFileSync(path, content);
  return path;
}

describe("canonical [agents] thread-limit compatibility", () => {
  test("canonical-only and old-only configs expose the stored limit", () => {
    for (const key of ["max_concurrent_threads_per_session", "max_threads"]) {
      const path = fixtureConfig(`[agents]\n${key} = 16\n`);
      expect(hasAgentsMaxThreads(path)).toBe(true);
      expect(getAgentsMaxThreads(path)).toBe(16);
      expect(getLogicalMaxThreads(path)).toBe(16);
    }
    const prose = fixtureConfig('[agents]\nhint = """\nmax_concurrent_threads_per_session = 99\n"""\n');
    expect(hasAgentsMaxThreads(prose)).toBe(false);
    expect(getAgentsMaxThreads(prose)).toBe(null);
  });

  test("canonical presence takes precedence even when its value is invalid", () => {
    const conflicting = fixtureConfig("[agents]\nmax_threads = 6\nmax_concurrent_threads_per_session = 16\n");
    expect(getAgentsMaxThreads(conflicting)).toBe(16);
    expect(getLogicalMaxThreads(conflicting)).toBe(16);
    const invalid = fixtureConfig("[agents]\nmax_concurrent_threads_per_session = 0\nmax_threads = 6\n");
    expect(hasAgentsMaxThreads(invalid)).toBe(true);
    expect(getAgentsMaxThreads(invalid)).toBe(null);
  });

  test("V1 edits canonical16 to canonical6 without a misleading legacy6 alias", () => {
    const path = fixtureConfig("[agents]\nmax_concurrent_threads_per_session = 16 # tuned\nmax_depth = 2\n");
    let toggles = 0;
    expect(transitionMultiAgentV2(false, () => { toggles++; }, { configPath: path, threadLimit: 6 }))
      .toEqual({ ok: true, changed: true, threadLimit: 6 });
    const written = readFileSync(path, "utf8");
    expect(Bun.TOML.parse(written).agents).toEqual({ max_concurrent_threads_per_session: 6, max_depth: 2 });
    expect(written).toContain("# tuned");
    expect(getLogicalMaxThreads(path)).toBe(6);
    expect(toggles).toBe(0);
    expect(transitionMultiAgentV2(false, () => { toggles++; }, { configPath: path, threadLimit: 6 }))
      .toEqual({ ok: true, changed: false, threadLimit: 6 });
  });

  test("old-only and identical aliases normalize once, preserving comments and CRLF", () => {
    for (const old of ["max_threads = 6 # old\r\n", "max_threads = 6 # old\r\nmax_concurrent_threads_per_session = 6 # canonical\r\n"]) {
      const path = fixtureConfig(`# keep\r\n[agents]\r\n${old}max_depth = 2\r\n`);
      expect(transitionMultiAgentV2(false, () => {}, { configPath: path })).toMatchObject({ ok: true, threadLimit: 6 });
      const written = readFileSync(path, "utf8");
      expect(Bun.TOML.parse(written).agents).toEqual({ max_concurrent_threads_per_session: 6, max_depth: 2 });
      expect(written).toContain("old");
      if (old.includes("# canonical")) expect(written).toContain("# canonical");
      expect(written.replaceAll("\r\n", "")).not.toContain("\n");
      expect(transitionMultiAgentV2(false, () => {}, { configPath: path })).toMatchObject({ ok: true, changed: false });
    }
  });

  test("conflicting aliases require an explicit replacement before either transition", () => {
    const original = "[agents]\nmax_concurrent_threads_per_session = 16\nmax_threads = 6\n";
    const path = fixtureConfig(original);
    let toggles = 0;
    for (const enabled of [false, true]) {
      expect(transitionMultiAgentV2(enabled, () => { toggles++; }, { configPath: path })).toMatchObject({ ok: false });
      expect(readFileSync(path, "utf8")).toBe(original);
    }
    expect(toggles).toBe(0);
    expect(transitionMultiAgentV2(false, () => { toggles++; }, { configPath: path, threadLimit: 8 }))
      .toMatchObject({ ok: true, threadLimit: 8 });
    expect(Bun.TOML.parse(readFileSync(path, "utf8")).agents).toEqual({ max_concurrent_threads_per_session: 8 });
  });

  test("canonical V1 to V2 round trip retains the existing root-included V2 contract", () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = false\n\n[agents]\nmax_concurrent_threads_per_session = 16 # tuned\n");
    const flip = (enabled: boolean) => writeFileSync(path, readFileSync(path, "utf8").replace(/^enabled = (?:true|false)$/m, `enabled = ${enabled}`));
    expect(transitionMultiAgentV2(true, flip, { configPath: path })).toMatchObject({ ok: true, threadLimit: 17 });
    expect(hasAgentsMaxThreads(path)).toBe(false);
    expect(getMaxConcurrentThreads(path)).toBe(17);
    expect(transitionMultiAgentV2(false, flip, { configPath: path })).toMatchObject({ ok: true, threadLimit: 16 });
    expect(Bun.TOML.parse(readFileSync(path, "utf8")).agents).toEqual({ max_concurrent_threads_per_session: 16 });
    expect(readFileSync(path, "utf8")).toContain("# tuned");
  });

  test("canonical no-op preserves numeric formatting and whitespace; old trailing spaces remain valid", () => {
    const original = "[agents]\n  max_concurrent_threads_per_session=0x10   \n";
    const path = fixtureConfig(original);
    expect(transitionMultiAgentV2(false, () => {}, { configPath: path })).toEqual({ ok: true, changed: false, threadLimit: 16 });
    expect(readFileSync(path, "utf8")).toBe(original);
    const old = fixtureConfig("[agents]\nmax_threads = 6   \n");
    expect(transitionMultiAgentV2(false, () => {}, { configPath: old })).toMatchObject({ ok: true, threadLimit: 6 });
    expect(Bun.TOML.parse(readFileSync(old, "utf8")).agents).toEqual({ max_concurrent_threads_per_session: 6 });
  });

  test.each(["max_concurrent_threads_per_session", '"max_concurrent_threads_per_session"', "max_threads", '"max_threads"'])(
    "unrelated valid 64-bit TOML integer cannot erase the structural limit %s", key => {
      const original = `model_context_window = 9007199254740993\n[agents]\n${key} = 0x10 # tuned\n`;
      const path = fixtureConfig(original);
      expect(() => Bun.TOML.parse(original)).toThrow();
      expect(transitionMultiAgentV2(false, () => {}, { configPath: path })).toMatchObject({ ok: true, threadLimit: 16 });
      expect(hasAgentsMaxThreads(path)).toBe(true);
      expect(getAgentsMaxThreads(path)).toBe(16);
      expect(getLogicalMaxThreads(path)).toBe(16);
      expect(readFileSync(path, "utf8")).toContain("model_context_window = 9007199254740993");
      expect(readFileSync(path, "utf8")).toContain("# tuned");
    },
  );

  test("quoted numeric keys normalize while multiline prose remains byte-identical", () => {
    const prose = 'hint = """\n[pretend]\nmax_threads = 99\n"""\n';
    const path = fixtureConfig(`[agents]\n${prose}"max_concurrent_threads_per_session" = 16\n`);
    expect(transitionMultiAgentV2(false, () => {}, { configPath: path, threadLimit: 6 })).toMatchObject({ ok: true, threadLimit: 6 });
    expect(readFileSync(path, "utf8")).toContain(prose);
    expect(Bun.TOML.parse(readFileSync(path, "utf8")).agents).toMatchObject({ max_concurrent_threads_per_session: 6 });
  });

  test("unsupported or duplicate canonical storage refuses without false success", () => {
    for (const original of [
      "agents.max_concurrent_threads_per_session = 16\n",
      "agents = { max_concurrent_threads_per_session = 16 }\n",
      "[agents]\nmax_concurrent_threads_per_session = 16\nmax_concurrent_threads_per_session = 6\n",
      '[agents]\nmax_concurrent_threads_per_session = """\n16\n"""\n',
    ]) {
      const path = fixtureConfig(original);
      expect(transitionMultiAgentV2(false, () => {}, { configPath: path, threadLimit: 6 })).toMatchObject({ ok: false });
      expect(readFileSync(path, "utf8")).toBe(original);
    }
  });

  test("unsafe limits cannot become scientific-notation writes reported as success", () => {
    const original = "[agents]\nmax_concurrent_threads_per_session = 16\n";
    const path = fixtureConfig(original);
    expect(transitionMultiAgentV2(false, () => {}, { configPath: path, threadLimit: 1e20 })).toMatchObject({ ok: false });
    expect(readFileSync(path, "utf8")).toBe(original);
    const unsafe = "[agents]\nmax_threads = 100000000000000000000\n";
    const stored = fixtureConfig(unsafe);
    expect(transitionMultiAgentV2(false, () => {}, { configPath: stored })).toMatchObject({ ok: false });
    expect(readFileSync(stored, "utf8")).toBe(unsafe);
  });
});

describe("canonical management API thread limits", () => {
  test.each([Number.MAX_SAFE_INTEGER + 1, 1e20])("unsafe API limit %s returns 400 before combined mutations", async limit => {
    const original = "[features.multi_agent_v2]\nenabled = false\n\n[agents]\nmax_concurrent_threads_per_session = 16\n";
    const path = fixtureConfig(original);
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOcxHome = process.env.OPENCODEX_HOME;
    const ocxHome = mkdtempSync(join(tmpdir(), "ocx-unsafe-limit-"));
    process.env.CODEX_HOME = dirname(path);
    process.env.OPENCODEX_HOME = ocxHome;
    const config = { providers: [], multiAgentMode: "v1" } as never;
    let toggles = 0;
    let convergences = 0;
    try {
      const request = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { Host: "localhost", "content-type": "application/json" },
        body: JSON.stringify({ enabled: true, multiAgentMode: "v2", agentsEnabled: true, maxConcurrentThreadsPerSession: limit }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), config, {
        toggleCodexMultiAgentV2: () => { toggles++; },
        createManagementConvergeCodex: catalogConvergenceFactory(() => { convergences++; }),
      });
      expect(response?.status).toBe(400);
      expect(await response?.json()).toEqual({ error: "body.maxConcurrentThreadsPerSession must be a safe integer >= 1" });
      expect(toggles).toBe(0);
      expect(convergences).toBe(0);
      expect(config).toEqual({ providers: [], multiAgentMode: "v1" });
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readdirSync(dirname(path))).toEqual(["config.toml"]);
      expect(readdirSync(ocxHome)).toEqual([]);
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
      if (oldOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldOcxHome;
    }
  });

  test.each([false, true])("API accepts the largest safe backend limit with V2 enabled=%s", async enabled => {
    const path = fixtureConfig(`[features.multi_agent_v2]\nenabled = ${enabled}\n`);
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOcxHome = process.env.OPENCODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-safe-limit-"));
    let toggles = 0;
    try {
      const request = new Request("http://localhost/api/v2", {
        method: "PUT", headers: { Host: "localhost", "content-type": "application/json" },
        body: JSON.stringify({ maxConcurrentThreadsPerSession: Number.MAX_SAFE_INTEGER }),
      });
      const response = await handleManagementAPI(request, new URL(request.url), { providers: [] } as never, {
        toggleCodexMultiAgentV2: () => { toggles++; }, createManagementConvergeCodex: catalogConvergenceFactory(),
      });
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({ enabled, maxConcurrentThreadsPerSession: Number.MAX_SAFE_INTEGER });
      expect(getLogicalMaxThreads(path)).toBe(Number.MAX_SAFE_INTEGER);
      expect(toggles).toBe(0);
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
      if (oldOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldOcxHome;
    }
  });

  test("hybrid GET and limit-only PUT use canonical agents storage without enabling global V2", async () => {
    const path = fixtureConfig("[features.multi_agent_v2]\nenabled = false\nmax_concurrent_threads_per_session = 17\n\n[agents]\nmax_concurrent_threads_per_session = 16\n");
    const oldCodexHome = process.env.CODEX_HOME;
    const oldOcxHome = process.env.OPENCODEX_HOME;
    process.env.CODEX_HOME = dirname(path);
    process.env.OPENCODEX_HOME = mkdtempSync(join(tmpdir(), "ocx-canonical-hybrid-"));
    const config = { providers: [], multiAgentMode: "v2", keepNativeChatGptOnV1: true } as never;
    let toggles = 0;
    const deps = { toggleCodexMultiAgentV2: () => { toggles++; }, createManagementConvergeCodex: catalogConvergenceFactory() };
    try {
      const get = new Request("http://localhost/api/v2", { headers: { Host: "localhost" } });
      expect(await (await handleManagementAPI(get, new URL(get.url), config, deps))?.json())
        .toMatchObject({ enabled: false, multiAgentMode: "v2", keepNativeChatGptOnV1: true, maxConcurrentThreadsPerSession: 16 });
      const put = new Request(get.url, {
        method: "PUT", headers: { Host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ maxConcurrentThreadsPerSession: 6 }),
      });
      const response = await handleManagementAPI(put, new URL(put.url), config, deps);
      expect(response?.status).toBe(200);
      expect(await response?.json()).toMatchObject({ enabled: false, multiAgentMode: "v2", keepNativeChatGptOnV1: true, maxConcurrentThreadsPerSession: 6 });
      expect(Bun.TOML.parse(readFileSync(path, "utf8")).agents).toEqual({ max_concurrent_threads_per_session: 6 });
      expect(getMaxConcurrentThreads(path)).toBe(null);
      expect(toggles).toBe(0);
      const reread = await handleManagementAPI(get, new URL(get.url), config, deps);
      expect(await reread?.json()).toMatchObject({ maxConcurrentThreadsPerSession: 6 });
    } finally {
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldCodexHome;
      if (oldOcxHome === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = oldOcxHome;
    }
  });

});
