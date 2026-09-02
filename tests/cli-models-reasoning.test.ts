import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReasoningArgs, handleModels } from "../src/cli/models";
import { handleModelsRuntimeCommand } from "../src/cli/models-runtime";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * The API validates reasoning ladders (9 tests in catalog-input-modality-enum.test.ts),
 * but the CLI paths carry their own parsing and validation copies: `ocx models add`
 * validates offline before writing config.json, and `ocx models edit` maps flags onto
 * the PUT body ("-" -> null). These tests pin that mapping so CLI and API cannot drift.
 */
describe("ocx models add --reasoning-efforts parsing", () => {
  test("a valid ladder is canonicalized into Codex order and deduped", () => {
    expect(parseReasoningArgs("max,low,high,low", undefined)).toEqual({
      reasoningEfforts: ["low", "high", "max"],
    });
  });

  test("the none sentinel is accepted and canonicalized first", () => {
    expect(parseReasoningArgs("low,none,max", undefined)).toEqual({
      reasoningEfforts: ["none", "low", "max"],
    });
  });

  test("an unknown effort is rejected and names the offending value", () => {
    const parsed = parseReasoningArgs("low,deep", undefined);
    expect(parsed.error).toContain("deep");
    expect(parsed.reasoningEfforts).toBeUndefined();
  });

  test('an empty string is the explicit no-reasoning ladder; malformed CSV is rejected', () => {
    expect(parseReasoningArgs("", undefined)).toEqual({ reasoningEfforts: [] });
    expect(parseReasoningArgs("low,,high", undefined)?.error).toContain("comma-separated");
    expect(parseReasoningArgs(",,", undefined)?.error).toContain("comma-separated");
  });

  test("a default still cannot ride on an explicit empty ladder", () => {
    expect(parseReasoningArgs("", "low")?.error).toContain("requires --reasoning-efforts");
  });

  test('"-" omits the field (inherit) exactly like the API null-clear', () => {
    expect(parseReasoningArgs("-", undefined)).toEqual({});
    expect(parseReasoningArgs(undefined, "-")).toEqual({});
  });

  test("a default must be a ladder member", () => {
    const parsed = parseReasoningArgs("low,high", "max");
    expect(parsed.error).toContain("max");
    expect(parsed.error).toContain("not in the declared reasoning efforts");
  });

  test("a default requires a ladder", () => {
    expect(parseReasoningArgs(undefined, "high")?.error).toContain("requires --reasoning-efforts");
  });

  test("a member default is accepted", () => {
    expect(parseReasoningArgs("low,high", "high")).toEqual({
      reasoningEfforts: ["low", "high"],
      defaultReasoningEffort: "high",
    });
  });
});

describe("ocx models edit reasoning flag mapping onto the PUT body", () => {
  async function editWith(patchArgs: string[]): Promise<Record<string, unknown>> {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ id: "cm-1", ...capturedBody }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const code = await handleModelsRuntimeCommand("edit", ["cm-1", ...patchArgs], {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });
    expect(code).toBe(0);
    return capturedBody ?? {};
  }

  test('"--reasoning-efforts -" maps to null (restore inheritance)', async () => {
    const body = await editWith(["--reasoning-efforts", "-"]);
    expect(body.reasoningEfforts).toBeNull();
  });

  test('"--reasoning-efforts \"\"" stores an explicit empty ladder (no-reasoning override)', async () => {
    const body = await editWith(["--reasoning-efforts", ""]);
    expect(body.reasoningEfforts).toEqual([]);
  });

  test("embedded blank CSV members are rejected without touching the API", async () => {
    let fetchCalled = false;
    const fetchImpl = async () => { fetchCalled = true; return new Response("{}", { status: 200 }); };
    const code = await handleModelsRuntimeCommand("edit", ["cm-1", "--reasoning-efforts", "low,,high"], {
      baseUrl: "http://127.0.0.1:1",
      fetchImpl,
    });
    // runCliAction turns CliUsageError into exit code 2 without touching the API.
    expect(code).toBe(2);
    expect(fetchCalled).toBe(false);
  });

  test("a csv ladder maps to an array", async () => {
    const body = await editWith(["--reasoning-efforts", "low,high"]);
    expect(body.reasoningEfforts).toEqual(["low", "high"]);
  });

  test('"--default-reasoning-effort -" maps to null', async () => {
    const body = await editWith(["--default-reasoning-effort", "-"]);
    expect(body.defaultReasoningEffort).toBeNull();
  });

  test("a member default maps to its string", async () => {
    const body = await editWith(["--reasoning-efforts", "low,high", "--default-reasoning-effort", "high"]);
    expect(body.reasoningEfforts).toEqual(["low", "high"]);
    expect(body.defaultReasoningEffort).toBe("high");
  });
});

describe("ocx models add persists reasoning metadata into config.json", () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-cli-test-"));
  const previousHome = process.env.OPENCODEX_HOME;

  beforeAll(() => {
    process.env.OPENCODEX_HOME = home;
    writeFileSync(join(home, "config.json"), JSON.stringify({
      providers: {
        deepseek: { adapter: "openai-chat", baseUrl: "https://example.invalid/v1", authMode: "key" },
      },
    }));
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    removeTreeWithRetry(home);
  });

  function readConfig(): { customModels?: Array<Record<string, unknown>> } {
    return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  }

  test("a ladder with a member default is stored canonicalized", async () => {
    await handleModels(["add", "deepseek", "m1", "--reasoning-efforts", "max,low,high", "--default-reasoning-effort", "high"]);
    const entry = readConfig().customModels!.find(model => model.modelId === "m1")!;
    expect(entry.reasoningEfforts).toEqual(["low", "high", "max"]);
    expect(entry.defaultReasoningEffort).toBe("high");
  });

  test('"-" omits the reasoning fields entirely (inherit)', async () => {
    await handleModels(["add", "deepseek", "m2", "--reasoning-efforts", "-"]);
    const entry = readConfig().customModels!.find(model => model.modelId === "m2")!;
    expect(entry.reasoningEfforts).toBeUndefined();
    expect(entry.defaultReasoningEffort).toBeUndefined();
  });

  test("list-custom renders the stored ladder columns", async () => {
    const lines: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    try {
      await handleModels(["list-custom"]);
    } finally {
      console.log = originalLog;
    }
    const table = lines.join("\n");
    expect(table).toContain("EFFORTS");
    expect(table).toContain("low,high,max");
    expect(table).toContain("-"); // m2 has no ladder -> dash cell
  });
});
