// Hold only the real Grok startup caller's catalog result. Earlier Desktop/Claude
// catalog consumers must complete normally, or the test misses the post-await check.
import { mock } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { syncGrokConfig } from "../../src/grok/sync";
import { injectGrokConfig } from "../../src/grok/inject";
import { fetchAllModels } from "../../src/server/management/shared";

const entered = process.env.OCX_TEST_GROK_ENTERED_FILE;
const release = process.env.OCX_TEST_GROK_RELEASE_FILE;
if (!entered || !release) throw new Error("Grok discovery fixture requires its owned markers");
const actualSync = syncGrokConfig;
mock.module("../../src/grok/sync", () => ({
  syncGrokConfig: (...args: Parameters<typeof actualSync>) => actualSync(args[0], args[1], args[2], {
    injectGrokConfig,
    fetchAllModels: async config => {
      const models = await fetchAllModels(config);
      writeFileSync(entered, "grok-catalog-ready\n");
      const deadline = Date.now() + Number(process.env.OCX_TEST_GROK_HOLD_MS ?? 60_000);
      while (!existsSync(release)) {
        if (Date.now() >= deadline) throw new Error("Grok discovery fixture release timeout");
        await Bun.sleep(10);
      }
      return models;
    },
  }),
}));

// Invoke the child's installed handler instead of Windows TerminateProcess.
const signal = process.env.OCX_TEST_STARTUP_SIGNAL_FILE;
if (signal) {
  const poller = setInterval(() => {
    if (!existsSync(signal)) return;
    clearInterval(poller);
    process.emit("SIGINT", "SIGINT");
  }, 10);
  poller.unref();
}
