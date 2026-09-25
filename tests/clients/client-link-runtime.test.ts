import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDefaultConfig, saveConfig } from "../../src/config";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { startClientRuntime } from "../../src/client/runtime";

test("link runtime refuses a busy configured port instead of selecting an ephemeral port", async () => {
  const home = mkdtempSync(join(tmpdir(), "ocx-client-link-runtime-"));
  const holder = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("held") });
  const previousHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = home;
  try {
    const token = `ocx_data_${"c".repeat(40)}`;
    const config = getDefaultConfig();
    config.port = holder.port!;
    config.runtimeRole = "client";
    config.client = {
      serverUrl: "http://127.0.0.1:34567",
      managementUrl: "http://127.0.0.1:34567",
      managementTransport: "direct",
      transport: "link",
      link: { tunnelPort: 34567, linkId: "lnk_0123456789abcdef" },
      selectedClients: ["codex"],
      tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
      apiKeyId: "key-1",
      tokenFingerprint: serviceApiTokenFingerprint(token),
      protocolVersion: 1,
      connectedAt: "2026-09-25T00:00:00.000Z",
    };
    saveConfig(config);
    await expect(startClientRuntime({ block: false })).rejects.toThrow(`link mode needs port ${holder.port}`);
  } finally {
    holder.stop(true);
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  }
});
