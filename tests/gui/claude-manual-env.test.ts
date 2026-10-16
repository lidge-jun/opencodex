import { expect, test } from "bun:test";
import { buildManualEnv, type ClaudeManualEnvState } from "../../gui/src/pages/claude-manual-env";

const CONDITIONAL_FLAG_LINE = '[ -z "${CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST+x}" ] && export CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1';

function state(overrides: Partial<ClaudeManualEnvState> = {}): ClaudeManualEnvState {
  return {
    authMode: "subscription",
    maxContextTokens: null,
    autoContext: true,
    autoCompactWindow: null,
    effectiveModelEnv: {},
    port: 10100,
    ...overrides,
  };
}

test("proxy mode emits the dummy token plus the conditional host-managed flag", () => {
  const env = buildManualEnv(state({ authMode: "proxy" }));
  expect(env).toContain("export ANTHROPIC_AUTH_TOKEN=opencodex-proxy");
  expect(env).toContain("export ANTHROPIC_BASE_URL=http://127.0.0.1:10100");
  // Conditional form (audit R2 #1): pasting the block into a shell that already
  // exported =0 must keep the user's opt-out.
  expect(env).toContain(CONDITIONAL_FLAG_LINE);
  expect(env).not.toContain("\nexport CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=1");
});

test("subscription mode keeps the login comment without asserting host-managed auth", () => {
  const env = buildManualEnv(state());
  expect(env).toContain("# no ANTHROPIC_AUTH_TOKEN: your claude.ai login (and connectors) stay active");
  expect(env).not.toContain("export ANTHROPIC_AUTH_TOKEN=");
  expect(env).not.toContain(CONDITIONAL_FLAG_LINE);
});

test("model env slots and auto-compact window are appended before the claude launch line", () => {
  const env = buildManualEnv(state({
    effectiveModelEnv: { ANTHROPIC_MODEL: "mock/test-model" },
    autoCompactWindow: 400_000,
  }));
  const lines = env.split("\n");
  expect(lines).toContain("export ANTHROPIC_MODEL=mock/test-model");
  expect(lines).toContain("export CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000");
  expect(lines.at(-1)).toBe("claude");
});

test("the 200k opt-in pastes no compact window, matching what the runtime injects", () => {
  expect(buildManualEnv(state())).toContain("export CLAUDE_CODE_AUTO_COMPACT_WINDOW=829800");
  expect(buildManualEnv(state({ contextAccounting: "200k" }))).not.toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
});

test("a 200k draft drops automatic 1M marks and keeps one explicit marker", () => {
  const env = buildManualEnv(state({
    contextAccounting: "200k",
    servedContextAccounting: "1m",
    model: "ocx-claude-native--gpt-5.6-sol",
    tierModels: { opus: "combo/tev-auto[1m]" },
    effectiveModelEnv: {
      ANTHROPIC_MODEL: "ocx-claude-native--gpt-5.6-sol[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "combo/tev-auto[1m]",
      ANTHROPIC_DEFAULT_SONNET_MODEL: "claude-sonnet-5[1m]",
      ANTHROPIC_DEFAULT_FABLE_MODEL: "claude-fable-5-1[1m]",
    },
  }));
  expect(env).not.toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  expect(env).toContain("export ANTHROPIC_MODEL=ocx-claude-native--gpt-5.6-sol\n");
  expect(env).not.toContain("ocx-claude-native--gpt-5.6-sol[1m]");
  expect(env).toContain("export ANTHROPIC_DEFAULT_OPUS_MODEL=combo/tev-auto[1m]");
  expect(env).not.toContain("ANTHROPIC_DEFAULT_SONNET_MODEL");
  expect(env).not.toContain("ANTHROPIC_DEFAULT_FABLE_MODEL");
});

test("a 200k draft without slot evidence still strips automatic marks", () => {
  const env = buildManualEnv(state({
    contextAccounting: "200k",
    servedContextAccounting: "1m",
    effectiveModelEnv: {
      ANTHROPIC_MODEL: "mock/test-model[1m]",
      ANTHROPIC_DEFAULT_OPUS_MODEL: "claude-opus-5-5[1m]",
    },
  }));
  expect(env).toContain("export ANTHROPIC_MODEL=mock/test-model\n");
  expect(env).not.toContain("[1m]");
  expect(env).not.toContain("ANTHROPIC_DEFAULT_OPUS_MODEL");
  expect(env).not.toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
});

test("switching back to 1M does not add a compact window beside a 200k model snapshot", () => {
  const env = buildManualEnv(state({
    contextAccounting: "1m",
    servedContextAccounting: "200k",
    model: "ocx-claude-native--gpt-5.6-sol",
    effectiveModelEnv: { ANTHROPIC_MODEL: "ocx-claude-native--gpt-5.6-sol" },
  }));
  expect(env).not.toContain("CLAUDE_CODE_AUTO_COMPACT_WINDOW");
  expect(env).toContain("export ANTHROPIC_MODEL=ocx-claude-native--gpt-5.6-sol\n");
  expect(env).not.toContain("[1m]");
});
