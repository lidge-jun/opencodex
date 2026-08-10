import { existsSync, writeFileSync } from "node:fs";

import {
  NativeProfileManager,
  type NativeProfileSwitchBoundary,
} from "../../src/codex/native-profile-manager";
import type { NativeProfileKey, NativeProfileKeyProvider } from "../../src/codex/native-profile-types";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`missing ${name}`);
  return value;
};

const keyBytes = Buffer.from(required("NATIVE_SWITCH_KEY"), "base64");
const resultPath = required("NATIVE_SWITCH_RESULT");
const markerPath = process.env.NATIVE_SWITCH_MARKER;
const releasePath = process.env.NATIVE_SWITCH_RELEASE;
const contentionPath = process.env.NATIVE_SWITCH_CONTENTION;
const crashBoundary = process.env.NATIVE_SWITCH_CRASH_BOUNDARY as NativeProfileSwitchBoundary | undefined;

class EnvKeyProvider implements NativeProfileKeyProvider {
  async get(): Promise<NativeProfileKey> { return { keyRef: "memory:switch-test", key: Buffer.from(keyBytes) }; }
  async create(): Promise<NativeProfileKey> { return { keyRef: "memory:switch-test", key: Buffer.from(keyBytes) }; }
}

const manager = new NativeProfileManager({
  codexHome: required("NATIVE_SWITCH_CODEX_HOME"),
  configDir: required("NATIVE_SWITCH_CONFIG_DIR"),
  keyProvider: new EnvKeyProvider(),
  hardenPath: async () => {},
  processProbe: async () => ({ status: "clear", count: 0 }),
  sleep: async ms => {
    if (contentionPath) writeFileSync(contentionPath, "contended");
    await Bun.sleep(ms);
  },
  onLockAcquired: async () => {
    if (markerPath && !crashBoundary) writeFileSync(markerPath, "lock-acquired");
    if (releasePath && !crashBoundary) while (!existsSync(releasePath)) await Bun.sleep(10);
  },
  onSwitchBoundary: async boundary => {
    if (boundary !== crashBoundary) return;
    if (markerPath) writeFileSync(markerPath, boundary);
    process.exit(86);
  },
});

try {
  const result = await manager.switch("target", true);
  writeFileSync(resultPath, JSON.stringify({ ok: true, result }));
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({
    ok: false,
    code: error && typeof error === "object" && "code" in error ? String(error.code) : null,
    message: error instanceof Error ? error.message : String(error),
  }));
}
