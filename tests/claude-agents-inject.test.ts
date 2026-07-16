import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClaudeAgentDefs, injectClaudeAgentDefs, syncClaudeAgentDefs } from "../src/claude/agents-inject";
import type { OcxConfig } from "../src/types";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ocx-agents-"));
  dirs.push(d);
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return { port: 10100, defaultProvider: "mock", providers: {}, ...extra } as OcxConfig;
}

function generatedBodies(config: OcxConfig, dir: string): string[] {
  const defs = buildClaudeAgentDefs(config, {}, dir);
  syncClaudeAgentDefs(defs, dir);
  return defs.map(def => readFileSync(join(dir, "agents", def.file), "utf8"));
}

describe("buildClaudeAgentDefs (devlog 070 + audit 071)", () => {
  test("roster + pinned self from settings.json; [1m] marking; name collision suffix", () => {
    const windows = { "claude-ocx-native--gpt-5.6-sol": 372_000, "claude-ocx-cursor--gpt-5.6-sol": 1_000_000 };
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ocx-native--gpt-5.6-sol[1m]" }));
    const defs = buildClaudeAgentDefs(cfg({
      subagentModels: ["gpt-5.6-sol", "cursor/gpt-5.6-sol"],
      claudeCode: {},
    }), windows, dir);
    const byName = Object.fromEntries(defs.map(d => [d.name, d]));
    expect(byName["ocx-gpt-5-6-sol"]!.model).toBe("claude-ocx-native--gpt-5.6-sol[1m]"); // 372k >= 350k default
    expect(byName["ocx-gpt-5-6-sol-2"]!.model).toBe("claude-ocx-cursor--gpt-5.6-sol[1m]"); // collision suffix
    // Self pins the picker-saved default (inherit disproven live — devlog 072).
    expect(byName["ocx-self"]!.model).toBe("claude-ocx-native--gpt-5.6-sol[1m]");
    expect(defs).toHaveLength(3);
    // Dispatcher directive (live repro: model:"fable" override broke inherit).
    for (const d of defs) expect(d.description).toContain("`model` argument is ignored");
  });

  test("unset roster seeds the defaults; explicit [] respected; no default model -> no self", () => {
    const dir = tempDir(); // empty: no settings.json, no claudeCode.model
    const seeded = buildClaudeAgentDefs(cfg(), {}, dir);
    expect(seeded.length).toBe(5); // 5 defaults, no self (unresolvable)
    const explicit = buildClaudeAgentDefs(cfg({ subagentModels: [], claudeCode: { model: "mock/big" } }), {}, dir);
    expect(explicit.map(d => d.name)).toEqual(["ocx-self"]);
    expect(explicit[0]!.model).toBe("mock/big"); // config fallback when settings absent
  });

  test("rendered frontmatter quotes every scalar and parses back", () => {
    const dir = tempDir();
    const [def] = buildClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    syncClaudeAgentDefs([def!], dir);
    const body = readFileSync(join(dir, "agents", def!.file), "utf8");
    const fm = body.split("---")[1]!;
    const fields: Record<string, string> = {};
    for (const line of fm.trim().split("\n")) {
      const idx = line.indexOf(": ");
      fields[line.slice(0, idx)] = JSON.parse(line.slice(idx + 2));
    }
    expect(fields.name).toBe(def!.name);
    expect(fields.model).toBe(def!.model);
    expect(typeof fields.description).toBe("string");
    expect(body).toContain("generated-by: opencodex");
    expect(body).toContain(`ocx-route: ${def!.model}`);
    expect(body).toContain("IDENTITY: your ACTUAL underlying model");
  });

  test("generated routed agents refuse the default blocked skill before its bundle expands", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ocx-native--gpt-5.6-sol" }));
    const bodies = generatedBodies(cfg({ subagentModels: ["gpt-5.6-sol"] }), dir);
    expect(bodies).toHaveLength(2); // roster + ocx-self
    for (const body of bodies) {
      expect(body).toContain("Do not invoke blocked Claude Code skills");
      expect(body).toContain(JSON.stringify("claude-api"));
    }
  });

  test("generated blocked-skill guard mirrors custom names and honors explicit opt-out", () => {
    const customDir = tempDir();
    writeFileSync(join(customDir, "settings.json"), JSON.stringify({ model: "claude-ocx-native--gpt-5.6-sol" }));
    const customBodies = generatedBodies(cfg({
      subagentModels: ["gpt-5.6-sol"],
      claudeCode: { blockedSkills: [" My-Skill "] },
    }), customDir);
    expect(customBodies).toHaveLength(2);
    for (const body of customBodies) {
      expect(body).toContain("Do not invoke blocked Claude Code skills");
      expect(body).toContain(JSON.stringify("my-skill"));
      expect(body).not.toContain(JSON.stringify("claude-api"));
    }

    const offDir = tempDir();
    writeFileSync(join(offDir, "settings.json"), JSON.stringify({ model: "claude-ocx-native--gpt-5.6-sol" }));
    const offBodies = generatedBodies(cfg({
      subagentModels: ["gpt-5.6-sol"],
      claudeCode: { blockedSkills: [] },
    }), offDir);
    expect(offBodies).toHaveLength(2);
    for (const body of offBodies) expect(body).not.toContain("Do not invoke blocked Claude Code skills");
  });

  test("blocked-skill names cannot inject Markdown structure into generated agents", () => {
    const dir = tempDir();
    const hostile = "My\"\n```<!-- injected -->`";
    const [body] = generatedBodies(cfg({
      subagentModels: ["gpt-5.6-sol"],
      claudeCode: { blockedSkills: [hostile] },
    }), dir);
    expect(body).toContain("\"my\\\"\\n\\u0060\\u0060\\u0060\\u003c!-- injected --\\u003e\\u0060\"");
    expect(body).not.toContain(hostile.toLowerCase());
  });

  test("native Claude self keeps skills; a modelMap-claimed Claude self gets the routed guard", () => {
    const nativeDir = tempDir();
    writeFileSync(join(nativeDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-5" }));
    const [nativeBody] = generatedBodies(cfg({ subagentModels: [] }), nativeDir);
    expect(nativeBody).not.toContain("Do not invoke blocked Claude Code skills");

    const routedDir = tempDir();
    writeFileSync(join(routedDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-5" }));
    const [routedBody] = generatedBodies(cfg({
      subagentModels: [],
      claudeCode: { modelMap: { "claude-sonnet-5": "anthropic/claude-sonnet-5" } },
    }), routedDir);
    expect(routedBody).toContain("Do not invoke blocked Claude Code skills");
  });

  test("direct provider self and disabled native passthrough keep the routed guard", () => {
    const directDir = tempDir();
    const [directBody] = generatedBodies(cfg({
      subagentModels: [],
      claudeCode: { model: "mock/big" },
    }), directDir);
    expect(directBody).toContain("Do not invoke blocked Claude Code skills");

    const disabledDir = tempDir();
    writeFileSync(join(disabledDir, "settings.json"), JSON.stringify({ model: "claude-sonnet-5" }));
    const [disabledBody] = generatedBodies(cfg({
      subagentModels: [],
      claudeCode: { nativePassthrough: false },
    }), disabledDir);
    expect(disabledBody).toContain("Do not invoke blocked Claude Code skills");
  });
});

describe("syncClaudeAgentDefs ownership contract (audit 071 #2/#3)", () => {
  test("writes, overwrites, and prunes ONLY marker-verified ocx files", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ocx-native--gpt-5.6-sol" }));
    const defs = buildClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    expect(syncClaudeAgentDefs(defs, dir)!.length).toBe(2);
    const agentsDir = join(dir, "agents");
    // User-authored file with our prefix but no marker: untouched by prune AND by write.
    writeFileSync(join(agentsDir, "ocx-custom.md"), "---\nname: ocx-custom\n---\nuser file");
    writeFileSync(join(agentsDir, "ocx-gpt-5-6-sol.md"), "user replaced this — no marker");
    const second = syncClaudeAgentDefs(buildClaudeAgentDefs(cfg({ subagentModels: [] }), {}, dir), dir)!;
    expect(second).toEqual(["ocx-self.md"]);
    const remaining = readdirSync(agentsDir).sort();
    // ocx-self rewritten; unowned ocx-custom + user-replaced sol file both preserved.
    expect(remaining).toEqual(["ocx-custom.md", "ocx-gpt-5-6-sol.md", "ocx-self.md"]);
    expect(readFileSync(join(agentsDir, "ocx-gpt-5-6-sol.md"), "utf8")).toBe("user replaced this — no marker");
  });

  // Capability probe: Windows without elevated symlink rights throws EPERM. Detect once
  // so the test reports a visible skip instead of a silent pass-shaped early return.
  const canSymlink = (() => {
    const dir = tempDir();
    try {
      symlinkSync(join(dir, "probe-target"), join(dir, "probe-link"));
      return true;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "EPERM") return false;
      throw e;
    }
  })();

  test.skipIf(!canSymlink)("symlinks are never followed or pruned", () => {
    const dir = tempDir();
    const agentsDir = join(dir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    const victim = join(dir, "victim.md");
    writeFileSync(victim, "precious");
    try {
      symlinkSync(victim, join(agentsDir, "ocx-linked.md"));
    } catch (err) {
      // Windows without Developer Mode / elevated privileges cannot create symlinks.
      if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") {
        return;
      }
      throw err;
    }
    syncClaudeAgentDefs([], dir); // prune pass
    expect(readFileSync(victim, "utf8")).toBe("precious");
    expect(readdirSync(agentsDir)).toContain("ocx-linked.md");
  });

  test("injectClaudeAgentDefs prunes owned files when disabled (audit 071 #3)", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ model: "claude-ocx-native--gpt-5.6-sol" }));
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    expect(readdirSync(join(dir, "agents")).length).toBe(2);
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"], claudeCode: { injectAgents: false } }), {}, dir);
    expect(readdirSync(join(dir, "agents"))).toEqual([]);
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"] }), {}, dir);
    injectClaudeAgentDefs(cfg({ subagentModels: ["gpt-5.6-sol"], claudeCode: { enabled: false } }), {}, dir);
    expect(readdirSync(join(dir, "agents"))).toEqual([]);
  });
});
