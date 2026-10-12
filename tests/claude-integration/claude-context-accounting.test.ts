/**
 * `claudeCode.contextAccounting: "200k"` opt-in (devlog/_plan/261009_claude_1m_default/030): no
 * automatic [1m] anywhere, no compact-window injection, explicit 1M choices kept.
 */
import { describe, expect, test } from "bun:test";
import {
  ACCOUNTING_200K,
  AUTO_COMPACT_WINDOW_DEFAULT,
  effectiveModelEnv,
  resolveAutoContext,
} from "../../src/claude/context-windows";
import { buildPickerModels } from "../../src/claude/intercept/picker-models";
import { buildAnthropicModelInfos } from "../../src/claude/model-info";
import { desktop3pModelOptions, generateDesktop3pModels } from "../../src/claude/desktop-3p";
import { withSubagentContextMarker } from "../../src/claude/subagent-model";
import { buildClaudeEnv as buildClaudeEnvWithIo } from "../../src/cli/claude";
import { handleClaudeConfigCommand } from "../../src/cli/integrations";
import type { OcxConfig } from "../../src/types";

const ASTRA = "native/gpt-6-astra";
const LONG_WINDOWS = { [ASTRA]: 872_000, "mock/huge": 1_000_000 };

describe("resolveAutoContext", () => {
  test("200k wins over every other lever, a user-exported compact window included", () => {
    expect(resolveAutoContext({ contextAccounting: "200k" })).toBe(ACCOUNTING_200K);
    expect(resolveAutoContext({ contextAccounting: "200k", autoCompactWindow: 400_000 }, "500000")).toBe(ACCOUNTING_200K);
    expect(ACCOUNTING_200K.enabled).toBe(false);
  });

  test("1m and unknown values read as the default", () => {
    for (const contextAccounting of ["1m", "bogus", undefined]) {
      expect(resolveAutoContext({ contextAccounting })).toEqual({ enabled: true, compactWindow: AUTO_COMPACT_WINDOW_DEFAULT });
    }
  });
});

describe("launch env", () => {
  test("model slots are not marked under 200k, are by default, and a typed [1m] survives", () => {
    expect(effectiveModelEnv({ model: ASTRA }, LONG_WINDOWS).ANTHROPIC_MODEL).toBe(`${ASTRA}[1m]`);
    expect(effectiveModelEnv({ model: ASTRA, contextAccounting: "200k" }, LONG_WINDOWS).ANTHROPIC_MODEL).toBe(ASTRA);
    expect(effectiveModelEnv({ model: "mock/huge", contextAccounting: "200k" }, LONG_WINDOWS).ANTHROPIC_MODEL).toBe("mock/huge");
    expect(effectiveModelEnv({ model: `${ASTRA}[1m]`, contextAccounting: "200k" }, LONG_WINDOWS).ANTHROPIC_MODEL).toBe(`${ASTRA}[1m]`);
  });

  test("no compact window is injected under 200k", () => {
    const config = (claudeCode: OcxConfig["claudeCode"]) => ({
      port: 10100, defaultProvider: "mock", providers: { mock: { adapter: "openai-chat", baseUrl: "http://x/v1" } }, claudeCode,
    } as OcxConfig);
    const build = (claudeCode: OcxConfig["claudeCode"]) => buildClaudeEnvWithIo(config(claudeCode), 10100, {}, {}, {
      authDetect: { readClaudeJson: () => undefined, credentialsFileExists: () => false, keychainProbe: () => "absent" as const },
    });
    expect(build({}).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe("829800");
    expect(build({ contextAccounting: "200k" }).CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeUndefined();
  });
});

describe("surfaces", () => {
  test("pickers leave 872k and 1M rows unmarked under 200k", () => {
    const rows = buildPickerModels({
      nativeSlugs: ["gpt-6-astra"], routedModels: [{ provider: "example", id: "huge", contextWindow: 1_000_000 }],
      nativeContextCap: { modelWindows: { "gpt-6-astra": 872_000 } }, auto: ACCOUNTING_200K,
    });
    expect(rows.some(row => row.id.endsWith("[1m]"))).toBe(false);
  });

  test("Desktop 3P keeps 1M selectable but drops the default under 200k", () => {
    const options = desktop3pModelOptions({ contextAccounting: "200k" });
    const [astra] = generateDesktop3pModels(["gpt-6-astra"], [], undefined, { modelWindows: { "gpt-6-astra": 872_000 } }, options);
    expect(astra!.supports1m).toBe(true);
    expect(astra!.prefer1m).toBeUndefined();
    expect(desktop3pModelOptions({})).toEqual({ preferOneMillion: true });
  });

  test("discovery keeps genuine 1M variants as a choice and drops widened ones under 200k", () => {
    const infos = buildAnthropicModelInfos(["gpt-6-astra"], [{ provider: "example", id: "huge", contextWindow: 1_000_000 }],
      ACCOUNTING_200K, "readable", undefined, { modelWindows: { "gpt-6-astra": 872_000 } });
    const variants = infos.filter(info => info.id.endsWith("[1m]")).map(info => info.display_name);
    expect(variants).toEqual(["huge (example) · 1M"]);
  });

  test("subagents: unmarked stays bare under 200k, an explicit marker follows its safety rule", () => {
    const alias = "ocx-claude-native--gpt-6-astra";
    const windows = { [alias]: 872_000 };
    expect(withSubagentContextMarker(alias, windows, true)).toBe(alias);
    expect(withSubagentContextMarker(`${alias}[1m]`, windows, true)).toBe(`${alias}[1m]`);
    expect(withSubagentContextMarker(`${alias}[1m]`, { [alias]: 262_144 }, true)).toBe(alias);
    expect(withSubagentContextMarker(alias, windows)).toBe(`${alias}[1m]`);
  });
});

describe("CLI", () => {
  for (const [value, expected] of [["200k", "200k"], ["1M", "1m"]] as const) {
    test(`--context-accounting ${value} sends ${expected}`, async () => {
      const requests: unknown[] = [];
      const code = await handleClaudeConfigCommand(["set", "--context-accounting", value], {
        baseUrl: "http://127.0.0.1:1",
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)));
          return Response.json({ ok: true });
        },
      });
      expect(code).toBe(0);
      expect(requests).toEqual([{ contextAccounting: expected }]);
    });
  }

  test("an unknown value is a usage error and sends nothing", async () => {
    let sent = 0;
    const code = await handleClaudeConfigCommand(["set", "--context-accounting", "500k"], {
      baseUrl: "http://127.0.0.1:1", fetchImpl: async () => { sent++; return Response.json({ ok: true }); },
    });
    expect(code).toBe(2);
    expect(sent).toBe(0);
  });
});
