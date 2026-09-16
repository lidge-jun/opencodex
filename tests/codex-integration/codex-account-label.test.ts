import { describe, expect, test } from "bun:test";
import {
  CODEX_ACCOUNT_LOG_LABEL_RE,
  ACCOUNT_LOG_LABEL_RE,
  apiKeyAccountLogLabel,
  codexAccountLogLabel,
  createCodexAccountLogLabel,
  fallbackCodexAccountLogLabel,
  withCodexAccountLogLabel,
} from "../../src/codex/account-label";

describe("codex account privacy labels", () => {
  test("key labels follow the shared consumer contract and isolate provider, slot and reference", () => {
    expect(apiKeyAccountLogLabel("test-provider", { entryId: "slot-a", reference: "test-key-a" }))
      .toBe("k35f7c109222440212853c90de03e7df5");
    expect(apiKeyAccountLogLabel("test-provider", { entryId: "slot-b", reference: "test-key-b" }))
      .toBe("kae34539c9f0b302367a033166800ae47");
    expect(apiKeyAccountLogLabel("test-provider", { reference: "test-key-a" }))
      .toBe("ke4869182d193d18777b6ce175baaa41a");
    expect(apiKeyAccountLogLabel("other-provider", { entryId: "slot-a", reference: "test-key-a" }))
      .toBe("k98c6a69a98c5537c6acd344f116e7579");
    expect(apiKeyAccountLogLabel("test-provider", undefined)).toBeUndefined();
    expect(apiKeyAccountLogLabel("test-provider", { reference: "" })).toBeUndefined();
    expect(apiKeyAccountLogLabel("test-provider", { reference: "env:MISSING_SYNTHETIC_KEY" }))
      .toMatch(ACCOUNT_LOG_LABEL_RE);
    expect(ACCOUNT_LOG_LABEL_RE.test("kabc123")).toBe(false);
    expect(ACCOUNT_LOG_LABEL_RE.test("k" + "a".repeat(33))).toBe(false);
  });
  test("generates non-PII log labels", () => {
    expect(createCodexAccountLogLabel()).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
  });

  test("avoids existing log labels", () => {
    const existing = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const label = createCodexAccountLogLabel(existing);
      expect(existing.has(label)).toBe(false);
      existing.add(label);
    }
  });

  test("preserves an existing valid label", () => {
    const labelled = withCodexAccountLogLabel(
      { id: "pool-a", email: "pool-a@example.test", isMain: false, logLabel: "pabc123" },
      [],
    );
    expect(labelled.logLabel).toBe("pabc123");
  });

  test("adds a label to new account records", () => {
    const labelled = withCodexAccountLogLabel(
      { id: "pool-a", email: "pool-a@example.test", isMain: false },
      [],
    );
    expect(labelled.logLabel).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
  });

  test("fallback label is stable and does not include the raw account id", () => {
    const accountId = "raw-local-account-id";
    const first = fallbackCodexAccountLogLabel(accountId);
    const second = fallbackCodexAccountLogLabel(accountId);

    expect(first).toBe(second);
    expect(first).toMatch(CODEX_ACCOUNT_LOG_LABEL_RE);
    expect(first).not.toContain(accountId);
    expect(codexAccountLogLabel({ id: accountId, email: "raw@example.test", isMain: false })).toBe(first);
  });
});
