import { expect, test } from "bun:test";
import { runClaudeAuthModeMigration } from "../src/claude/auth-mode-migration";
import type { OcxConfig } from "../src/types";

/**
 * Before auto existed, "Subscription" was stored by DELETING the key. So the upgrade
 * must not read a deliberate subscriber's config as "never chose" and move them onto
 * proxy (devlog 260726_claude_auth_auto/015).
 */

function config(claudeCode?: OcxConfig["claudeCode"]): OcxConfig {
  return { port: 10100, defaultProvider: "openai", providers: {}, ...(claudeCode ? { claudeCode } : {}) } as unknown as OcxConfig;
}

test("a pre-upgrade block without authMode is pinned to subscription", () => {
  const c = config({ enabled: true });
  expect(runClaudeAuthModeMigration(c)).toBe(true);
  expect(c.claudeCode!.authMode).toBe("subscription");
  expect(typeof c.claudeCode!.authModeMigratedAt).toBe("string");
  // The sentinel is an ISO timestamp, not just any truthy value.
  expect(Number.isNaN(Date.parse(c.claudeCode!.authModeMigratedAt!))).toBe(false);
});

test("an existing proxy choice is left alone, but is marked migrated", () => {
  const c = config({ authMode: "proxy" });
  expect(runClaudeAuthModeMigration(c)).toBe(true);
  expect(c.claudeCode!.authMode).toBe("proxy");
  expect(c.claudeCode!.authModeMigratedAt).toBeDefined();
});

test("a config with no claudeCode block is untouched and stays auto", () => {
  const c = config();
  expect(runClaudeAuthModeMigration(c)).toBe(false);
  expect(c.claudeCode).toBeUndefined();
});

test("the migration is idempotent", () => {
  const c = config({ enabled: true });
  expect(runClaudeAuthModeMigration(c)).toBe(true);
  const stamp = c.claudeCode!.authModeMigratedAt;
  expect(runClaudeAuthModeMigration(c)).toBe(false);
  expect(c.claudeCode!.authModeMigratedAt).toBe(stamp);
});

// THE sharpest edge: choosing Auto deletes authMode but keeps the sentinel. If the
// next start re-migrated, it would silently undo the user's choice.
test("choosing auto later is not resurrected into subscription on the next start", () => {
  const c = config({ enabled: true });
  runClaudeAuthModeMigration(c);
  expect(c.claudeCode!.authMode).toBe("subscription");

  // The PUT route's "auto" branch: delete the mode, keep everything else.
  delete c.claudeCode!.authMode;

  expect(runClaudeAuthModeMigration(c)).toBe(false);
  expect(c.claudeCode!.authMode).toBeUndefined();
});

test("an empty-string sentinel is treated as unmigrated, not as done", () => {
  const c = config({ enabled: true, authModeMigratedAt: "" });
  expect(runClaudeAuthModeMigration(c)).toBe(true);
  expect(c.claudeCode!.authMode).toBe("subscription");
});
