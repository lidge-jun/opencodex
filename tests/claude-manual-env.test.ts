import { expect, test } from "bun:test";
import { buildManualEnv, type ClaudeManualEnvState } from "../gui/src/pages/claude-manual-env";

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
