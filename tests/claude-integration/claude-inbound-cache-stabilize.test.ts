import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { OcxConfig, OcxClaudeCodeConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import { stabilizeClaudeInstructionsForPromptCache } from "../../src/claude/inbound-cache-stabilize";
import { anthropicToResponsesTranslation } from "../../src/claude/inbound";

const TASKCREATE_NUDGE = [
  "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking, consider using TaskCreate to add them.",
  "Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
].join(" ");

/** Claude Code 2.1.263+ wording (hitrate tip0847 / FREEZE-DIFF S/T4). */
const TASKCREATE_NUDGE_CC_2_1_263 = [
  "The task tools haven't been used recently. If you're working on tasks that would benefit from tracking progress, consider using TaskCreate to add new tasks and TaskUpdate to update task status (set to in_progress when starting, completed when done).",
  "Also consider cleaning up the task list if it has become stale.",
  "Only use these if relevant to the current work. This is just a gentle reminder - ignore if not applicable.",
].join(" ");

function footer(used: number): string {
  return `<total_tokens>${used} tokens left</total_tokens>`;
}

function translate(
  system: string,
  options?: { user_id?: string; stabilizePromptCache?: boolean },
) {
  return anthropicToResponsesTranslation(
    {
      model: "m",
      max_tokens: 1,
      system,
      messages: [{ role: "user", content: "hi" }],
      ...(options?.user_id ? { metadata: { user_id: options.user_id } } : {}),
    },
    options?.stabilizePromptCache === undefined
      ? undefined
      : { stabilizePromptCache: options.stabilizePromptCache },
  );
}

function translateHarness(system: string, metadata?: { user_id: string }) {
  return anthropicToResponsesTranslation(
    {
      model: "m",
      max_tokens: 1,
      system,
      messages: [{ role: "user", content: "hi" }],
      ...(metadata ? { metadata } : {}),
    },
    { stabilizePromptCache: true },
  );
}

function userTurns(body: { input: unknown }) {
  return body.input as Array<Record<string, unknown>>;
}

describe("stabilizeClaudeInstructionsForPromptCache", () => {
  test("empty input is a no-op", () => {
    expect(stabilizeClaudeInstructionsForPromptCache("")).toEqual({
      instructions: "",
      dynamicNotice: null,
    });
  });

  test("stable instructions without dynamics pass through", () => {
    const instructions = "You are Claude Code.\n\nPrefer terse answers.";
    expect(stabilizeClaudeInstructionsForPromptCache(instructions)).toEqual({
      instructions,
      dynamicNotice: null,
    });
  });

  test("no-match whitespace is returned byte-for-byte", () => {
    const instructions = "You are Claude Code.\n\n\nPrefer terse answers.\n";
    expect(stabilizeClaudeInstructionsForPromptCache(instructions)).toEqual({
      instructions,
      dynamicNotice: null,
    });
  });

  test("whitespace-only system without a footer is unchanged", () => {
    const instructions = "  \n\n  ";
    expect(stabilizeClaudeInstructionsForPromptCache(instructions)).toEqual({
      instructions,
      dynamicNotice: null,
    });
  });

  test("three trailing total_tokens footers keep only the latest in the notice", () => {
    const stable = "You are Claude Code.";
    const first = footer(1000);
    const second = footer(4000);
    const third = footer(8000);
    const result = stabilizeClaudeInstructionsForPromptCache(
      [stable, first, second, third].join("\n\n"),
    );
    expect(result.instructions).toBe(stable);
    expect(result.instructions).not.toContain("<total_tokens>");
    expect(result.dynamicNotice).toBe(third);
  });

  test("real Claude Code 15000000 tokens left trailing footer peels", () => {
    const stable = "You are Claude Code.";
    const harness = footer(15_000_000);
    const result = stabilizeClaudeInstructionsForPromptCache(`${stable}\n\n${harness}`);
    expect(result.instructions).toBe(stable);
    expect(result.dynamicNotice).toBe("<total_tokens>15000000 tokens left</total_tokens>");
  });

  test("bare numeric total_tokens without tokens left is not a harness footer", () => {
    const docs = "You are Claude Code.\n\n<total_tokens>123</total_tokens>";
    const result = stabilizeClaudeInstructionsForPromptCache(docs);
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBeNull();
  });

  test("mid-document total_tokens stays; only the trailing harness footer relocates", () => {
    const result = stabilizeClaudeInstructionsForPromptCache(
      `System.\n${footer(1)}\nMore system.\n${footer(3)}`,
    );
    expect(result.instructions).toBe(`System.\n${footer(1)}\nMore system.`);
    expect(result.dynamicNotice).toBe(footer(3));
  });

  test("TaskCreate nudge is stripped from instructions and kept in the notice", () => {
    const stable = "You are Claude Code.";
    const result = stabilizeClaudeInstructionsForPromptCache(
      `${stable}\n\n${TASKCREATE_NUDGE}`,
    );
    expect(result.instructions).toBe(stable);
    expect(result.instructions).not.toContain("TaskCreate");
    expect(result.dynamicNotice).toBe(TASKCREATE_NUDGE);
  });

  test("Claude Code 2.1.263 TaskCreate nudge peels and unpins older tokens-left footers", () => {
    const stable = "You are Claude Code.";
    const older = footer(15_000_000);
    const mid = footer(14_980_071);
    const latest = footer(14_997_176);
    const result = stabilizeClaudeInstructionsForPromptCache(
      [stable, older, mid, TASKCREATE_NUDGE_CC_2_1_263, latest].join("\n\n"),
    );
    expect(result.instructions).toBe(stable);
    expect(result.instructions).not.toContain("<total_tokens>");
    expect(result.instructions).not.toContain("TaskCreate");
    expect(result.dynamicNotice).toBe(`${latest}\n\n${TASKCREATE_NUDGE_CC_2_1_263}`);
  });

  test("latest footer and latest nudge both surface in the notice", () => {
    const stable = "Stay stable.";
    const older = footer(10);
    const latest = footer(50);
    const result = stabilizeClaudeInstructionsForPromptCache(
      [stable, older, TASKCREATE_NUDGE, latest].join("\n\n"),
    );
    expect(result.instructions).toBe(stable);
    expect(result.dynamicNotice).toBe(`${latest}\n\n${TASKCREATE_NUDGE}`);
  });

  test("legacy and 2.1.263 nudges both leave the same stable instructions prefix", () => {
    const stable = "Stay stable.";
    const a = stabilizeClaudeInstructionsForPromptCache(
      [stable, footer(1), TASKCREATE_NUDGE, footer(2)].join("\n\n"),
    );
    const b = stabilizeClaudeInstructionsForPromptCache(
      [stable, footer(1), TASKCREATE_NUDGE_CC_2_1_263, footer(9)].join("\n\n"),
    );
    expect(a.instructions).toBe(stable);
    expect(b.instructions).toBe(stable);
  });

  test("inline documentation of total_tokens tags stays in instructions", () => {
    const docs = "The harness may emit a <total_tokens>123</total_tokens> footer; do not invent one.";
    const result = stabilizeClaudeInstructionsForPromptCache(docs);
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBeNull();
  });

  test("TaskCreate mentioned in docs is not treated as the harness nudge", () => {
    const docs = "The task tools haven't been used recently. You may mention TaskCreate in docs without the reminder.";
    const result = stabilizeClaudeInstructionsForPromptCache(docs);
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBeNull();
  });

  test("fenced standalone total_tokens example stays byte-for-byte", () => {
    const docs = ["You are a docs bot.", "```", footer(123), "```", ""].join("\n");
    const result = stabilizeClaudeInstructionsForPromptCache(docs);
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBeNull();
  });

  test("docs plus a real trailing footer keep the docs and move only the latest footer", () => {
    const docs = "Describe <total_tokens>0</total_tokens> in the protocol guide.";
    const latest = footer(8000);
    const result = stabilizeClaudeInstructionsForPromptCache(
      [docs, footer(1), latest].join("\n\n"),
    );
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBe(latest);
  });

  test("fenced example plus a trailing harness footer moves only the footer", () => {
    const docs = ["Docs:", "```", footer(123), "```"].join("\n");
    const latest = footer(8000);
    const result = stabilizeClaudeInstructionsForPromptCache(`${docs}\n\n${latest}`);
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBe(latest);
  });

  test("unclosed fence through EOF is not a harness suffix", () => {
    const docs = ["You are a docs bot.", "```", footer(123)].join("\n");
    const result = stabilizeClaudeInstructionsForPromptCache(docs);
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBeNull();
  });

  test("a fence line with an info string does not close an open fence", () => {
    const docs = ["```", footer(123), "```xml"].join("\n");
    const result = stabilizeClaudeInstructionsForPromptCache(docs);
    expect(result.instructions).toBe(docs);
    expect(result.dynamicNotice).toBeNull();
  });
});

describe("linear canonical notice extraction", () => {
  for (const separator of ["\n", "\r\n", "\t", "\f", "  "]) {
    test(`noncanonical inner separator ${JSON.stringify(separator)} is preserved`, () => {
      const system = `System.\n\n<total_tokens>123${separator}tokens left</total_tokens>`;
      expect(stabilizeClaudeInstructionsForPromptCache(system)).toEqual({ instructions: system, dynamicNotice: null });
      const body = translateHarness(system).body;
      expect(body.instructions).toBe(system);
      expect(body.input).toHaveLength(1);
    });
  }

  test("retains prefix trailing spaces after a successful peel and failed next candidate", () => {
    expect(stabilizeClaudeInstructionsForPromptCache(`System.  \n\n${footer(1)}`)).toEqual({
      instructions: "System.  ", dynamicNotice: footer(1),
    });
  });
  test("CRLF separators and horizontal padding retain the canonical notice", () => {
    expect(stabilizeClaudeInstructionsForPromptCache(`System.\r\n\r\n \t${footer(1)}\t \r\n`)).toEqual({
      instructions: "System.", dynamicNotice: footer(1),
    });
  });
  test("malformed notice before a valid suffix remains byte-for-byte", () => {
    const prefix = `System.  \n<total_tokens>123\ntokens left</total_tokens>  `;
    expect(stabilizeClaudeInstructionsForPromptCache(`${prefix}\n${footer(2)}`)).toEqual({
      instructions: prefix, dynamicNotice: footer(2),
    });
  });
  test("a whitespace-only trailing line and lone CR are not canonical separators", () => {
    for (const system of [`System.\n${footer(1)}\n \n`, `System.\n${footer(1)}\r`]) {
      expect(stabilizeClaudeInstructionsForPromptCache(system)).toEqual({ instructions: system, dynamicNotice: null });
    }
  });
  test("twenty thousand notices after many fences keep only the latest without repeated prefix scans", () => {
    const prefix = "System.\n" + ("```xml\nexample\n```\n").repeat(2_000) + "Stable.  ";
    const notices = Array.from({ length: 20_000 }, (_, index) => footer(index));
    expect(stabilizeClaudeInstructionsForPromptCache(`${prefix}\n\n${notices.join("\n")}`)).toEqual({
      instructions: prefix, dynamicNotice: footer(19_999),
    });
  });
});

describe("anthropicToResponsesTranslation cache-stabilize wire-in", () => {
  test("ordinary caller with the exact unfenced suffix keeps instructions and input unchanged", () => {
    const latest = footer(15_000_000);
    const system = ["You are Claude Code.", latest].join("\n\n");
    const { body } = translate(system);
    expect(body.instructions).toBe(system);
    expect(userTurns(body)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  test("ordinary caller with the exact TaskCreate paragraph keeps instructions and input unchanged", () => {
    const system = ["You are Claude Code.", TASKCREATE_NUDGE].join("\n\n");
    const { body } = translate(system);
    expect(body.instructions).toBe(system);
    expect(userTurns(body)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  test("opted-in harness relocates the latest total_tokens footer onto a trailing input user message", () => {
    const first = footer(1000);
    const latest = footer(8000);
    const { body } = translateHarness(["You are Claude Code.", first, latest].join("\n\n"));
    expect(body.instructions).toBe("You are Claude Code.");
    expect(String(body.instructions)).not.toContain("<total_tokens>");
    const input = userTurns(body);
    const last = input[input.length - 1]!;
    expect(last).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: latest }],
    });
    expect(input.some(item => item.role === "user" && item !== last)).toBe(true);
  });

  test("opted-in peel does not require metadata.user_id", () => {
    const latest = footer(14_980_071);
    const { body } = translateHarness(["You are Claude Code.", latest].join("\n\n"));
    expect(body.instructions).toBe("You are Claude Code.");
    const input = userTurns(body);
    expect(input[input.length - 1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: latest }],
    });
  });

  test("fenced standalone total_tokens example is a translator no-op when opted in", () => {
    const system = ["You are a docs bot.", "```", footer(123), "```", ""].join("\n");
    const { body } = translateHarness(system);
    expect(body.instructions).toBe(system);
    expect(userTurns(body)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  test("open fence to EOF with a trailing total_tokens tag is not relocated", () => {
    const system = ["You are a docs bot.", "```", footer(123)].join("\n");
    const { body } = translateHarness(system);
    expect(body.instructions).toBe(system);
    expect(userTurns(body)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  test("real footer after a closed fence still relocates when opted in", () => {
    const docs = ["Docs:", "```", footer(123), "```"].join("\n");
    const latest = footer(8000);
    const { body } = translateHarness(`${docs}\n\n${latest}`);
    expect(body.instructions).toBe(docs);
    const input = userTurns(body);
    expect(input[input.length - 1]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: latest }],
    });
  });

  test("whitespace-only system without a footer is preserved byte-for-byte", () => {
    const system = "  \n\n  ";
    const { body } = translate(system);
    expect(body.instructions).toBe(system);
    expect(userTurns(body)).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
    ]);
  });

  test("Claude Code session prompt_cache_key is unchanged across trailing footers", () => {
    const stable = "You are Claude Code.";
    const keyOf = (system: string) =>
      translateHarness(system, { user_id: "user-abc" }).body.prompt_cache_key as string;
    const stableKey = keyOf(stable);
    expect(stableKey).toMatch(/^[0-9a-f]{32}$/);
    expect(keyOf([stable, footer(1000), footer(8000)].join("\n\n"))).toBe(stableKey);
    expect(keyOf([stable, footer(99999)].join("\n\n"))).toBe(stableKey);
  });

  test("outside opt-in, Desktop prompt_cache_key hashes raw systemParts including footers", () => {
    const stable = "You are Claude Code.";
    const keyOf = (system: string) => translate(system).body.prompt_cache_key as string;
    const stableKey = keyOf(stable);
    expect(stableKey).toMatch(/^[0-9a-f]{32}$/);
    expect(keyOf(stable)).toBe(stableKey);
    expect(keyOf([stable, footer(8000)].join("\n\n"))).not.toBe(stableKey);
  });

  test("opted-in Desktop prompt_cache_key hashes stabilized instructions, not total_tokens footers", () => {
    const stable = "You are Claude Code.";
    const keyOf = (system: string) => translateHarness(system).body.prompt_cache_key as string;
    const stableKey = keyOf(stable);
    expect(stableKey).toMatch(/^[0-9a-f]{32}$/);
    expect(keyOf([stable, footer(1000), footer(8000)].join("\n\n"))).toBe(stableKey);
    expect(keyOf([stable, footer(99999)].join("\n\n"))).toBe(stableKey);
  });

  test("outside opt-in, a no-match Desktop key differs from the opted-in instructions-string key", () => {
    const system = "You are Claude Code.\n\nPrefer terse answers.";
    const rawKey = translate(system).body.prompt_cache_key as string;
    const optedInKey = translateHarness(system).body.prompt_cache_key as string;
    expect(rawKey).toMatch(/^[0-9a-f]{32}$/);
    expect(optedInKey).toMatch(/^[0-9a-f]{32}$/);
    expect(rawKey).not.toBe(optedInKey);
  });

});

describe("Messages operator opt-in at the outbound boundary", () => {
  const originalFetch = globalThis.fetch;
  let isolatedHome: IsolatedCodexHome | undefined;
  let previousHome: string | undefined;
  let configHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    isolatedHome = installIsolatedCodexHome("ocx-prefix-contract-");
    configHome = mkdtempSync(join(tmpdir(), "ocx-prefix-config-"));
    process.env.OPENCODEX_HOME = configHome;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    isolatedHome?.restore();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    if (configHome) removeTreeWithRetry(configHome);
  });

  async function outbound(system: string, enabled?: boolean) {
    const captured: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://prefix.example/v1/responses");
      captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: "resp_prefix", object: "response", status: "completed",
        output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }] }],
        usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } });
    }) as typeof fetch;
    const config = {
      providers: { prefix: { adapter: "openai-responses", authMode: "key", baseUrl: "https://prefix.example/v1", apiKey: "test-key", models: ["m"] } },
      ...(enabled === undefined ? {} : { claudeCode: { stabilizePromptCache: enabled } }),
    } as OcxConfig;
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "prefix/m", max_tokens: 32, system,
        messages: [{ role: "user", content: "hi" }], stream: false }),
    }), config, { model: "", provider: "" });
    await response.text();
    expect(response.status).toBe(200);
    expect(captured).toHaveLength(1);
    return captured[0]!;
  }

  for (const enabled of [undefined, false]) {
    test(`ordinary HTTP caller preserves exact footer with setting ${enabled}`, async () => {
      const system = `System.\n\n${footer(15_000_000)}`;
      const wire = await outbound(system, enabled);
      expect(wire.instructions).toBe(system);
      expect(wire.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }]);
      // Independent historical key vector: canonical JSON keys in sorted order, raw system array.
      const expectedKey = createHash("sha256").update(JSON.stringify({ model: "prefix/m", system: [system], tools: [], version: 2 })).digest("hex").slice(0, 32);
      expect(wire.prompt_cache_key).toBe(expectedKey);
    });
  }

  for (const notice of [footer(15_000_000), TASKCREATE_NUDGE, TASKCREATE_NUDGE_CC_2_1_263]) {
    test(`explicit HTTP opt-in relocates supported notice ${notice.slice(0, 35)}`, async () => {
      const wire = await outbound(`System.\n\n${notice}`, true);
      expect(wire.instructions).toBe("System.");
      expect(wire.input).toEqual([
        { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] },
        { type: "message", role: "user", content: [{ type: "input_text", text: notice }] },
      ]);
    });
  }

  test("opted-in HTTP caller preserves an open fenced example", async () => {
    const system = `Docs:\n\x60\x60\x60xml\n${footer(1)}`;
    const wire = await outbound(system, true);
    expect(wire.instructions).toBe(system);
    expect(wire.input).toHaveLength(1);
  });

  test("explicit setting survives actual config save/load without enabling other configs", () => {
    const config = loadConfig();
    config.claudeCode = { ...config.claudeCode, stabilizePromptCache: true };
    saveConfig(config);
    expect(loadConfig().claudeCode?.stabilizePromptCache).toBe(true);
    config.claudeCode.stabilizePromptCache = false;
    saveConfig(config);
    expect(loadConfig().claudeCode?.stabilizePromptCache).toBe(false);
  });

  test("malformed truthy configuration never activates relocation", () => {
    const system = `System.\n\n${footer(1)}`;
    const config = JSON.parse('{"stabilizePromptCache":"true"}') as OcxClaudeCodeConfig;
    const { body } = anthropicToResponsesTranslation({ model: "m", system, messages: [{ role: "user", content: "hi" }] }, config);
    expect(body.instructions).toBe(system);
    expect(body.input).toHaveLength(1);
  });
});
