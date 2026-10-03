import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { handleModelsRuntimeCommand } from "../../src/cli/models-runtime";
import { handleRoutePolicyCommand } from "../../src/cli/route-policy";
import type { RuntimeApiDeps } from "../../src/cli/runtime-api";
import { repoPath } from "../helpers/repo-root";
import { createTempHome } from "../helpers/temp-home";
import { printSubcommandUsage } from "../../src/cli/help";

// Execute complete documented argv through real parsers, with transport replaced.
// Fixtures are independent wire expectations, not capability metadata or prose assertions.
// Only owned temporary input files are written; no live proxy, user credential or upstream request is used.
const sources = [
  "skills/ocx/references/03_recipes.md",
  "docs-site/src/content/docs/reference/cli/providers-accounts.md",
  "docs-site/src/content/docs/reference/cli/agents.md",
];
const preset = { mode: "preset", availableVersion: 3, appliedVersion: 2, presetCount: 2, totalCount: 4 };
const profile = { id: "reliable", model: "policy/reliable", revision: "fixture-revision" };
const arrivals = { anthropic: [{ id: "new-model", at: "2026-01-01T00:00:00Z", state: "off" }] };
const editableProfile = { candidates: [{ provider: "anthropic", model: "existing" }], require: {},
  optimize: { latency: 0, health: 0, cost: 1, quota: 0 }, limits: {},
  unknownEvidence: { capability: "allow", health: "allow", quota: "allow", cost: "allow" } };
const updatedProfile = { ...profile, alias: null, ...editableProfile, revision: "fixture-next-revision" };
const updatedReceipt = { success: true, id: "reliable", model: "policy/reliable", profile: updatedProfile,
  catalogRefresh: { status: "committed", changed: true, degraded: false, notices: [] } };
type Fixture = { help?: boolean; prefix: string; path: string; method?: string; body?: unknown; response: unknown; output?: unknown };
const fixtures: Fixture[] = [
  { prefix: "ocx route policy update --help", help: true, path: "", response: null },
  { prefix: "ocx route policy update reliable", path: "/api/routing-profiles", method: "PUT", body: { id: "reliable", mode: "update", profile: editableProfile, expectedRevision: "fixture-revision" }, response: updatedReceipt },
  { prefix: "ocx models preset show", path: "/api/model-presets", response: { providers: { anthropic: preset } }, output: preset },
  { prefix: "ocx models preset apply", path: "/api/model-presets", method: "PUT", body: { provider: "anthropic", mode: "preset" }, response: { selected: ["existing"], fallback: "preset-empty" } },
  { prefix: "ocx models selected", path: "/api/selected-models", response: { selected: { anthropic: ["existing"] }, available: { anthropic: ["existing", "new-model"] } }, output: { provider: "anthropic", selected: ["existing"], available: ["existing", "new-model"] } },
  { prefix: "ocx models new-policy off", path: "/api/model-discovery", method: "PUT", body: { policy: "off", provider: "anthropic" }, response: { policy: "off", baselineBootstrapped: true } },
  { prefix: "ocx models new-policy --provider", path: "/api/model-discovery", response: { policy: "on", providers: { anthropic: "off" } }, output: { provider: "anthropic", policy: "off" } },
  { prefix: "ocx models new-arrivals", path: "/api/model-discovery", response: { recentArrivals: arrivals }, output: arrivals },
  { prefix: "ocx route policy list", path: "/api/routing-profiles", response: { profiles: [profile] } },
  { prefix: "ocx route policy show", path: "/api/routing-profiles", response: { profiles: [profile] }, output: profile },
  { prefix: "ocx route policy dry-run", path: "/api/routing-profiles/dry-run", method: "POST", body: { profile: "reliable", evidence: { contextWindow: 128000, toolsRequired: true, imageInputRequired: true, structuredOutputRequired: true } }, response: { ok: true, selected: { provider: "anthropic", model: "existing" } } },
];

function documentedWorkflows(): Array<{ file: string; command: string }> {
  return sources.flatMap(file => {
    const markdown = readFileSync(repoPath(file), "utf8");
    return [...markdown.matchAll(/```bash\n([\s\S]*?)```/g)].flatMap(block =>
      block[1]!.split("\n").map(line => line.split(/\s+#/)[0]!.trim())
        .filter(command => /^ocx (?:models (?:preset|new-policy|new-arrivals)\b|route policy\b)/.test(command)
          || command === "ocx models selected anthropic --json")
        .map(command => ({ file, command })),
    );
  });
}

async function invoke(command: string, response: unknown, status = 200) {
  // Recognize this recipe's redirection/placeholder syntax; never evaluate a shell.
  const [invocation, redirect] = command.split(/\s+>\s+/);
  if (redirect !== undefined) expect(redirect).toBe("profile.observed.json");
  const [binary, family, sub, ...args] = invocation!.split(/\s+/).map(token =>
    token === "'<exact-revision-from-observed-show>'" ? "fixture-revision" : token);
  const home = createTempHome("ocx-doc-workflow-");
  const input = home.path("profile.next.json");
  writeFileSync(input, JSON.stringify(editableProfile));
  const fileIndex = args.indexOf("--file");
  if (fileIndex >= 0) {
    expect(args[fileIndex + 1]).toBe("profile.next.json");
    args[fileIndex + 1] = input;
  }
  expect(binary).toBe("ocx");
  const calls: Array<{ path: string; method: string; body: unknown }> = [];
  const output = spyOn(console, "log").mockImplementation(() => {});
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const previousToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "skill-workflow-fixture-no-live-authority";
  const deps: RuntimeApiDeps = {
    baseUrl: "http://cli-fixture.invalid",
    fetchImpl: async (url, init) => {
      calls.push({ path: new URL(String(url)).pathname, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : null });
      return Response.json(response, { status });
    },
  };
  try {
    let code: number | null;
    if (args.includes("--help")) {
      printSubcommandUsage(family!, [family!, sub!, ...args.filter(arg => arg !== "--help")]);
      code = 0;
    }
    else if (family === "models" && sub) code = await handleModelsRuntimeCommand(sub, args, deps);
    else if (family === "route" && sub === "policy") code = await handleRoutePolicyCommand(args, deps);
    else throw new Error(`Unsupported fixture family: ${family}`);
    return { code, calls, stdout: output.mock.calls.flat().join("\n"), stderr: errors.mock.calls.flat().join("\n") };
  } finally {
    if (previousToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousToken;
    output.mockRestore();
    errors.mockRestore();
    home.remove();
  }
}

const examples = documentedWorkflows();
describe("documented model and routing workflows", () => {
  test("the extracted code values cover the independent handler fixtures", () => {
    const exercised = new Set(examples.map(({ command }) => fixtures.find(f => (command === f.prefix || command.startsWith(`${f.prefix} `)))?.prefix));
    expect([...exercised].sort()).toEqual(fixtures.map(f => f.prefix).sort());
  });
  for (const { file, command } of examples) {
    test(`${file}: ${command}`, async () => {
      const fixture = fixtures.find(f => (command === f.prefix || command.startsWith(`${f.prefix} `)));
      if (!fixture) throw new Error(`No independent wire fixture for: ${command}`);
      const result = await invoke(command, fixture.response);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      if (fixture.help) {
        expect(result.calls).toEqual([]);
        expect(result.stdout).toContain("Usage: ocx route policy update");
        expect(result.stdout).toContain("--expected-revision");
        return;
      }
      expect(result.calls).toEqual([{ path: fixture.path, method: fixture.method ?? "GET", body: fixture.body ?? null }]);
      expect(JSON.parse(result.stdout)).toEqual(fixture.output ?? fixture.response);
    });
  }
  test("bad nested operand/flag grammar is rejected before transport", async () => {
    for (const command of [
      "ocx models preset apply --json",
      "ocx models new-policy off --provider --json",
      "ocx route policy dry-run reliable --model-context-ms 128000 --json",
    ]) {
      const result = await invoke(command, {});
      expect(result.code).toBe(2);
      expect(result.calls).toEqual([]);
      expect(result.stdout).toBe("");
    }
  });
  test("JSON output requests preserve prose stderr and conflict exit semantics", async () => {
    const result = await invoke("ocx models preset apply anthropic --json", { error: "changed", reason: "stale_revision", hint: "read back" }, 409);
    expect(result.code).toBe(5);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("Error: changed\nreason: stale_revision\nhint: read back");
  });
});

test("routing evaluation recipes disclose enabled automation activation beside the example", () => {
  for (const file of [sources[0]!, sources[2]!]) {
    const text = readFileSync(repoPath(file), "utf8");
    const example = text.indexOf("ocx route policy dry-run reliable");
    expect(example).toBeGreaterThan(-1);
    const adjacent = text.slice(example, example + 650);
    expect(adjacent).toContain("authority to activate Lab");
    expect(adjacent).toContain("upstream probes");
  }
});
