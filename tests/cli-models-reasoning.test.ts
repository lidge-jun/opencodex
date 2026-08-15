import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReasoningArgs, handleModels } from "../src/cli/models";
import { handleModelsRuntimeCommand } from "../src/cli/models-runtime";

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
  async function editWith(
    patchArgs: string[],
    observed?: { putPath?: string },
    currentRow: Record<string, unknown> = { id: "cm-1" },
  ): Promise<Record<string, unknown>> {
    let capturedBody: Record<string, unknown> | null = null;
    const fetchImpl = async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/custom-models") && !init?.method) {
        return Response.json([currentRow]);
      }
      if (String(url).endsWith("/api/codex-auth/account-target-options")) {
        return Response.json({ targets: [{ target: "@main" }] });
      }
      if (init?.method === "PUT") observed && (observed.putPath = new URL(String(url)).pathname);
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

  test("ordinary unbound edits keep the legacy route and omit the target nonce", async () => {
    const observed: { putPath?: string } = {};
    const body = await editWith(["--display-name", "Renamed"], observed);
    expect(observed.putPath).toBe("/api/custom-models/cm-1");
    expect(body).not.toHaveProperty("codexAccountTargetWriteNonce");
  });

  test("ordinary edits of a retained target use the attested route", async () => {
    const observed: { putPath?: string } = {};
    const body = await editWith(
      ["--display-name", "Renamed"],
      observed,
      { id: "cm-1", codexAccountTarget: "@main" },
    );
    expect(observed.putPath).toBe("/api/custom-models/cm-1/account-target");
    expect(body.codexAccountTargetWriteNonce).toBeString();
  });

  test("Codex account targets map to strings and dash clears with null", async () => {
    expect((await editWith(["--codex-account-target", "@main"])).codexAccountTarget).toBe("@main");
    expect((await editWith(["--codex-account-target", "pool-a"])).codexAccountTarget).toBe("pool-a");
    expect((await editWith(["--codex-account-target", "-"])).codexAccountTarget).toBeNull();
  });

  test("an invalid Codex account target is rejected before the API request", async () => {
    let fetchCalled = false;
    const code = await handleModelsRuntimeCommand(
      "edit",
      ["cm-1", "--codex-account-target", "__main__"],
      {
        baseUrl: "http://127.0.0.1:1",
        fetchImpl: async () => { fetchCalled = true; return Response.json({}); },
      },
    );
    expect(code).toBe(2);
    expect(fetchCalled).toBe(false);
  });

  test("an old server cannot fake support by echoing an unchanged target", async () => {
    let putCalled = false;
    const code = await handleModelsRuntimeCommand(
      "edit",
      ["cm-1", "--codex-account-target", "@main"],
      {
        baseUrl: "http://127.0.0.1:1",
        fetchImpl: async (url, init) => {
          if (String(url).endsWith("/api/custom-models") && !init?.method) {
            return Response.json([{ id: "cm-1", codexAccountTarget: "@main" }]);
          }
          if (String(url).endsWith("/api/codex-auth/account-target-options")) {
            return Response.json({ error: "not found" }, { status: 404 });
          }
          putCalled = init?.method === "PUT";
          return Response.json({ id: "cm-1", codexAccountTarget: "@main" });
        },
      },
    );
    expect(code).toBe(1);
    expect(putCalled).toBe(false);
  });

  test("a downgrade between capability probe and target PUT cannot attest the write", async () => {
    let putCalled = false;
    const code = await handleModelsRuntimeCommand(
      "edit",
      ["cm-1", "--codex-account-target", "@main"],
      {
        baseUrl: "http://127.0.0.1:1",
        fetchImpl: async (url, init) => {
          if (String(url).endsWith("/api/custom-models") && !init?.method) {
            return Response.json([{ id: "cm-1", codexAccountTarget: "@main" }]);
          }
          if (String(url).endsWith("/api/codex-auth/account-target-options")) {
            return Response.json({ targets: [{ target: "@main" }] });
          }
          putCalled = init?.method === "PUT";
          // The old passthrough handler can echo the stored field, but it cannot echo
          // the transient nonce that only the feature-aware mutation handler reads.
          return Response.json({ id: "cm-1", codexAccountTarget: "@main" });
        },
      },
    );
    expect(code).toBe(1);
    expect(putCalled).toBe(true);
  });

  test("an ordinary edit cannot silently keep a target on a downgraded server", async () => {
    let putPath: string | undefined;
    const code = await handleModelsRuntimeCommand(
      "edit",
      ["cm-1", "--display-name", "Renamed"],
      {
        baseUrl: "http://127.0.0.1:1",
        fetchImpl: async (url, init) => {
          if (String(url).endsWith("/api/custom-models") && !init?.method) {
            return Response.json([{ id: "cm-1", codexAccountTarget: "@main" }]);
          }
          putPath = new URL(String(url)).pathname;
          return Response.json({ error: "not found" }, { status: 404 });
        },
      },
    );
    expect(code).toBe(4);
    expect(putPath).toBe("/api/custom-models/cm-1/account-target");
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
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
        },
      },
    }));
  });

  afterAll(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  function readConfig(): {
    customModels?: Array<Record<string, unknown>>;
    codexAccounts?: Array<Record<string, unknown>>;
    providers: Record<string, Record<string, unknown>>;
  } {
    return JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
  }

  test("an ordinary add still creates config.json from fresh-home defaults", async () => {
    const configPath = join(home, "config.json");
    const previous = readFileSync(configPath, "utf8");
    rmSync(configPath, { force: true });
    try {
      await handleModels(["add", "openai", "fresh-home-preview"]);
      const persisted = readConfig();
      expect(persisted.providers.openai).toBeDefined();
      expect(persisted.customModels?.find(model => model.modelId === "fresh-home-preview"))
        .toMatchObject({ provider: "openai" });
    } finally {
      writeFileSync(configPath, previous);
    }
  });

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

  test("a canonical OpenAI custom row stores an explicit Codex account target", async () => {
    await handleModels(
      ["add", "openai", "targeted-preview", "--codex-account-target", "@main"],
      { findLiveProxyImpl: async () => null },
    );
    const entry = readConfig().customModels!.find(model => model.modelId === "targeted-preview")!;
    expect(entry.codexAccountTarget).toBe("@main");
  });

  test("a target-bearing add rebases over a concurrent config edit", async () => {
    await handleModels(
      ["add", "openai", "concurrent-target", "--codex-account-target", "@main"],
      {
        findLiveProxyImpl: async () => {
          const concurrent = readConfig();
          concurrent.providers.deepseek!.note = "preserve-me";
          writeFileSync(join(home, "config.json"), JSON.stringify(concurrent));
          return null;
        },
      },
    );
    const persisted = readConfig();
    expect(persisted.providers.deepseek?.note).toBe("preserve-me");
    expect(persisted.customModels?.find(model => model.modelId === "concurrent-target"))
      .toMatchObject({ codexAccountTarget: "@main" });
  });

  test("a target deleted during capability discovery is revalidated before commit", async () => {
    const seeded = readConfig();
    seeded.codexAccounts = [{ id: "pool-race", email: "race@example.com", isMain: false }];
    writeFileSync(join(home, "config.json"), JSON.stringify(seeded));
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
    try {
      await expect(handleModels(
        ["add", "openai", "deleted-target", "--codex-account-target", "pool-race"],
        {
          findLiveProxyImpl: async () => {
            const concurrent = readConfig();
            concurrent.codexAccounts = [];
            writeFileSync(join(home, "config.json"), JSON.stringify(concurrent));
            return null;
          },
        },
      )).rejects.toThrow("exit:1");
    } finally {
      exitSpy.mockRestore();
    }
    expect(readConfig().customModels?.some(model => model.modelId === "deleted-target")).toBe(false);
  });

  test("a live old proxy is rejected before a target-bearing add writes config", async () => {
    const before = readConfig().customModels?.length ?? 0;
    let requestPath: string | undefined;
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
    try {
      await expect(handleModels(
        ["add", "openai", "old-proxy-target", "--codex-account-target", "@main"],
        {
          findLiveProxyImpl: async () => ({ pid: 123, port: 10100, source: "config" }),
          fetchImpl: async url => {
            requestPath = new URL(String(url)).pathname;
            return Response.json({ error: "not found" }, { status: 404 });
          },
        },
      )).rejects.toThrow("exit:1");
    } finally {
      exitSpy.mockRestore();
    }
    expect(readConfig().customModels?.length ?? 0).toBe(before);
    expect(readConfig().customModels?.some(model => model.modelId === "old-proxy-target")).toBe(false);
    expect(requestPath).toBe("/api/custom-models/account-target");
  });

  test("a live target-bearing add uses the attested route without a local config write", async () => {
    const before = JSON.stringify(readConfig());
    let requestPath: string | undefined;
    let requestBody: Record<string, unknown> | undefined;
    await handleModels(
      ["add", "openai", "live-target", "--codex-account-target", "@main"],
      {
        findLiveProxyImpl: async () => ({ pid: 123, port: 10100, source: "config" }),
        fetchImpl: async (url, init) => {
          requestPath = new URL(String(url)).pathname;
          requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return Response.json({ id: "server-created", ...requestBody }, { status: 201 });
        },
      },
    );
    expect(requestPath).toBe("/api/custom-models/account-target");
    expect(requestBody).toMatchObject({
      provider: "openai",
      modelId: "live-target",
      codexAccountTarget: "@main",
      codexAccountTargetWriteNonce: expect.any(String),
    });
    expect(JSON.stringify(readConfig())).toBe(before);
  });

  test("a live target-bearing add rejects a missing write attestation", async () => {
    const before = JSON.stringify(readConfig());
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit);
    try {
      await expect(handleModels(
        ["add", "openai", "unattested-live-target", "--codex-account-target", "@main"],
        {
          findLiveProxyImpl: async () => ({ pid: 123, port: 10100, source: "config" }),
          fetchImpl: async (_url, init) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            return Response.json({
              id: "old-proxy-row",
              codexAccountTarget: body.codexAccountTarget,
            }, { status: 201 });
          },
        },
      )).rejects.toThrow("exit:1");
    } finally {
      exitSpy.mockRestore();
    }
    expect(JSON.stringify(readConfig())).toBe(before);
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
    expect(table).toContain("CODEX ACCOUNT");
    expect(table).toContain("@main");
    expect(table).toContain("low,high,max");
    expect(table).toContain("-"); // m2 has no ladder -> dash cell
  });
});
