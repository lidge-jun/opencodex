import { describe, expect, test } from "bun:test";
import {
  CODEX_ACCOUNT_LOG_LABEL_RE,
  codexAccountLogLabel,
  createCodexAccountLogLabel,
  fallbackCodexAccountLogLabel,
  withCodexAccountLogLabel,
} from "../src/codex/account-label";

describe("codex account privacy labels", () => {
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
