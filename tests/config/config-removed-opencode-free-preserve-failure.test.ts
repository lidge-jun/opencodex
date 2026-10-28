import { expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { getConfigPath, getDefaultConfig, saveConfig } from "../../src/config";
import { readRawConfigJson } from "../../src/config/persist-unlocked";
import { readCredentialGeneration } from "../../src/local-credentials/generation";
import { createTempHome } from "../helpers/temp-home";

// A parseable document deep enough that retired-provider pruning overflows the stack.
function deepDisk(extra: Record<string, unknown>): string {
  const raw = JSON.stringify({ ...getDefaultConfig(), ...extra });
  const deep = '{"next":'.repeat(32000) + "0" + "}".repeat(32000);
  return raw.slice(0, -1) + ',"modelMetadata":' + deep + "}";
}

function withDeepDisk(extra: Record<string, unknown>, action: (bytes: string, warn: ReturnType<typeof spyOn>) => void): void {
  const home = createTempHome("ocx-retired-preserve-failure-");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const bytes = deepDisk(extra);
    writeFileSync(getConfigPath(), bytes);
    action(bytes, warn);
  } finally {
    warn.mockRestore();
    home.remove();
  }
}

test("a failed retired-entry check keeps the parsed snapshot for the save guards", () => {
  withDeepDisk({ runtimeRole: "client", client: { hubUrl: "malformed" } }, (bytes, warn) => {
    expect(readRawConfigJson("preserve-only")?.runtimeRole).toBe("client");
    expect(() => saveConfig(getDefaultConfig())).toThrow("malformed or mismatched remote client state");
    expect(readFileSync(getConfigPath(), "utf8")).toBe(bytes);
    const messages = warn.mock.calls.map(call => String(call[0]));
    expect(messages.some(message => message.includes("no recovery copy was made"))).toBe(true);
    expect(messages.some(message => message.includes(getConfigPath()))).toBe(false);
  });
});

test("a failed retired-entry check keeps old OS-store references across the save", () => {
  withDeepDisk({ providers: {
    ...getDefaultConfig().providers,
    "opencode-free": { apiKey: "keychain:synthetic-exception-account", baseUrl: "https://example.test/v1" },
  } }, () => {
    saveConfig(getDefaultConfig());
    expect(readCredentialGeneration()?.keyAccounts ?? []).toContain("synthetic-exception-account");
  });
});
