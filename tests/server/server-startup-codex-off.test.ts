import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../../src/config";
import { startServer } from "../../src/server";
import { installIsolatedCodexHome } from "../helpers/isolated-codex-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

test("Codex OFF starts without service-manager probes or native-main preparation", async () => {
  const priorHome = process.env.OPENCODEX_HOME;
  const home = mkdtempSync(join(tmpdir(), "ocx-start-codex-off-"));
  const codex = installIsolatedCodexHome("ocx-start-codex-off-client-");
  process.env.OPENCODEX_HOME = home;
  let inspections = 0;
  let preparations = 0;
  let server: ReturnType<typeof startServer> | undefined;
  try {
    saveConfig({
      providers: { fixture: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", allowPrivateNetwork: true } },
      defaultProvider: "fixture", port: 0, hostname: "127.0.0.1",
      clientIntegrations: { codex: false }, checkForUpdates: false,
      syncResumeHistory: false, claudeCode: { intercept: { enabled: false } },
    });
    server = startServer(0, {
      inspectNativeCodexOwnership: () => {
        inspections++;
        return { ownership: "owned", reason: "unused Codex OFF probe" };
      },
      nativeMainStartup: {
        get manager() {
          preparations++;
          throw new Error("Codex OFF must not prepare a native manager");
        },
      },
    });
    expect(inspections).toBe(0);
    expect(preparations).toBe(0);
    expect((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status).toBe(200);
  } finally {
    await server?.stop(true);
    codex.restore();
    if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = priorHome;
    removeTreeWithRetry(home);
  }
});
