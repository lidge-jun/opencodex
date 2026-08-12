import { existsSync, writeFileSync } from "node:fs";

import { NativeProfileManager } from "../../src/codex/native-profile-manager";
import { NativeProfileError } from "../../src/codex/native-profile-types";

const codexHome = process.env.NATIVE_PROFILE_TEST_CODEX_HOME;
const configDir = process.env.NATIVE_PROFILE_TEST_CONFIG_DIR;
const readyPath = process.env.NATIVE_PROFILE_TEST_READY;
const releasePath = process.env.NATIVE_PROFILE_TEST_RELEASE;
const contentionPath = process.env.NATIVE_PROFILE_TEST_CONTENTION;
const probeResultPath = process.env.NATIVE_PROFILE_TEST_PROBE_RESULT;

if (!codexHome || !configDir) {
  throw new Error("native-profile lock child is missing required test paths");
}

if (probeResultPath) {
  const probe = new NativeProfileManager({
    codexHome,
    configDir,
    hardenPath: async () => {},
    lockWaitMs: 0,
  });
  try {
    await probe.recover(false);
    writeFileSync(probeResultPath, "acquired");
  } catch (error) {
    if (!(error instanceof NativeProfileError) || error.code !== "NATIVE_PROFILE_BUSY") throw error;
    writeFileSync(probeResultPath, "busy");
  }
} else {
  if (!readyPath || !releasePath) {
    throw new Error("native-profile lock child is missing required holder paths");
  }
  const manager = new NativeProfileManager({
    codexHome,
    configDir,
    hardenPath: async () => {},
    lockWaitMs: 5_000,
    sleep: async ms => {
      if (contentionPath) writeFileSync(contentionPath, "contended");
      await Bun.sleep(ms);
    },
    onLockAcquired: async () => {
      writeFileSync(readyPath, "ready");
      if (process.env.NATIVE_PROFILE_TEST_CRASH === "1") process.exit(87);
      while (!existsSync(releasePath)) await Bun.sleep(10);
    },
  });

  await manager.recover(false);
}
