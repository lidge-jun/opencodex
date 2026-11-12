import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { withCredentialPublicationFenceAsync } from "../../src/local-credentials/publication-fence";

const configDir = process.env.OPENCODEX_HOME!;
const codexHome = process.env.CODEX_HOME!;
const fixtureRoot = process.env.NATIVE_PROFILE_HEALTHZ_ROOT;
if (!fixtureRoot || configDir !== join(fixtureRoot, "opencodex") || codexHome !== join(fixtureRoot, "codex")) {
  throw new Error("Profile-health helper requires its isolated fixture homes");
}

if (process.argv[2] === "hold") {
  const released = new Promise<void>(resolve => {
    process.on("message", message => { if (message === "release") resolve(); });
  });
  await withCredentialPublicationFenceAsync(configDir, async () => {
    process.send?.("locked");
    await released;
  });
  process.exit(0);
}

const { NativeProfileManager } = await import("../../src/codex/native-profile-manager");
const { saveConfig } = await import("../../src/config");
const { startServer } = await import("../../src/server");
const { waitForNativeMainStartupGate } = await import("../../src/codex/native-profile-startup");
const { nativeOwnerRestartService } = await import("./native-owner-restart-service");

/** Opaque fixture credentials use the real encrypted profile/vault persistence. */
const envelope = (accountId: string) => JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { account_id: accountId, id_token: "fixture-id", access_token: "fixture-access", refresh_token: "fixture-refresh" },
});
writeFileSync(join(codexHome, "config.toml"), 'cli_auth_credentials_store = "file"\n');
writeFileSync(join(codexHome, "auth.json"), envelope("health-source"));
const key = () => ({ keyRef: "memory:healthz-fixture", key: Buffer.alloc(32, 7) });
const manager = new NativeProfileManager({
  codexHome, configDir,
  keyProvider: { get: async () => key(), create: async () => key() },
  hardenPath: async () => {},
  processProbe: async () => ({ status: "clear", count: 0 }),
});
await manager.register("source");
const stage = await manager.prepareStage();
writeFileSync(join(stage.stagingCodexHome, "auth.json"), envelope("health-target"));
const target = await manager.finishStage(stage.stageId, stage.writerToken, "target");
saveConfig({ port: 0, hostname: "127.0.0.1", defaultProvider: "test", providers: {
  test: { adapter: "openai-chat", baseUrl: "https://example.test/v1", disabled: true },
} });
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    return Promise.reject(new Error("External fetch is disabled in the profile-health fixture"));
  }
  return nativeFetch(input, init);
}) as typeof fetch;

const server = startServer(0, {
  inspectNativeCodexOwnership: () => ({ ownership: "owned", reason: "isolated profile-health fixture" }),
  nativeMainStartup: { manager, owner: { retryMs: 25, hardenPath: async () => {} } },
  managementApi: { nativeProfileApi: { manager }, codexRestartService: nativeOwnerRestartService },
});
await waitForNativeMainStartupGate();

// Observe entry without replacing the production writer, publication fence, or route.
// The original call runs in the same turn after IPC, so a blocking writer cannot
// service the parent's subsequent health probe before that parent releases the lock.
let armed = false;
const originalWrite = Reflect.get(manager, "atomicWrite") as (path: string, content: string) => Promise<void>;
Reflect.set(manager, "atomicWrite", (path: string, content: string) => {
  if (armed) { armed = false; process.send?.("publication-entered"); }
  return originalWrite(path, content);
});
process.on("message", async message => {
  if (message === "arm") { armed = true; process.send?.("armed"); }
  if (message === "stop") { await server.stop(true); process.exit(0); }
});
process.send?.({ port: server.port, targetId: target.profile.id });
