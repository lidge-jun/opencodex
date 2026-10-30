import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

const scopes: Record<string, string[]> = {
  "src/config/initialize.ts": ["identifiesDescriptor"],
  "src/service/state-lock.ts": ["readLockSnapshot"],
  "src/oauth/store.ts": ["snapshot", "createOAuthFileLock"],
  "src/claude/intercept/proxy-auth.ts": ["assertSameNode", "readPinnedToken", "ensurePrivateDirectory", "ensureClaudeInterceptProxyToken"],
  "src/claude/desktop-remote-store-io.ts": ["read"],
  "src/server/persistent-gui-session.ts": ["readRecords"],
  "src/lib/spend-pool-alias-validation.ts": ["readExistingSpendSalt"],
  "src/integrations/droid-settings.ts": ["assertDroidSettingsUnambiguous"],
  "src/integrations/aside-profile-context.ts": ["storeGuard"],
  "src/integrations/hermes-profiles.ts": ["lstatOrNull"],
  "src/providers/cc-switch-import-source.ts": ["readSourceRows"],
  "src/adapters/command-code-project-context.ts": ["openedFileIsConfined"],
  "src/codex/catalog/write-audit.ts": ["appendCatalogWriteAudit"],
};

function inspect(source: string, names: string[], droid = false): string[] {
  const problems: string[] = [];
  for (const name of names) {
    const start = source.search(new RegExp(`\\b${name}\\s*\\(`));
    if (start < 0) { problems.push(`missing scope: ${name}`); continue; }
    const end = source.indexOf(name === "read" ? "\n  }" : "\n}", start);
    const body = source.slice(start, end < 0 ? undefined : end);
    for (const match of body.matchAll(/\b(?:lstatSync|fstatSync|statSync|lstat|stat|handle\.stat)\s*\(([^()]*)\)/g)) {
      if (droid && /^lstatSync\(root\)$/.test(match[0])) continue;
      if (!/\{\s*bigint\s*:\s*true\s*\}/.test(match[1]!)) problems.push(`numeric stat: ${match[0]}`);
    }
  }
  if (/\bNumber\s*\([^)]*\.(?:ino|dev)\b/.test(source)) problems.push("numeric identity");
  return problems;
}

describe("file identity caller stats", () => {
  test("detects a numeric identity observation", () => {
    expect(inspect("function check() { const s = lstatSync(path); return s.ino === 1; }", ["check"]))
      .toEqual(["numeric stat: lstatSync(path)"]);
    expect(inspect("function check() { const s = lstatSync(path, { bigint: true }); return Number(s.ino); }", ["check"]))
      .toEqual(["numeric identity"]);
  });
  for (const [path, names] of Object.entries(scopes)) {
    test(path, () => expect(inspect(readFileSync(repoPath(path), "utf8"), names, path.endsWith("droid-settings.ts"))).toEqual([]));
  }
});
