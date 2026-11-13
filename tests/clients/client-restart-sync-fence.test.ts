/**
 * A failed client restart must not let a sync admitted before it commit afterwards (#8416).
 *
 * The bound restart drains the listener and starts a replacement; when the replacement fails, this
 * runtime serves again. A Home sync already past admission used to keep writing client files while
 * the listener closed, and could then commit an obsolete Home decision into the runtime that rolled
 * back, because the rollback republished an identical runtime record. Everything here is the real
 * runtime and the real sync guard; only the replacement start is replaced, and it fails.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { repoPath } from "../helpers/repo-root";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { watchdogMs } from "../helpers/ci-watchdog";

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = server.port!;
  server.stop(true);
  return port;
}

test("a failed restart fences syncs admitted before it and admits new ones after the rollback", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-client-restart-sync-fence-"));
  for (const dir of ["ocx", "codex", "home"]) mkdirSync(join(root, dir), { recursive: true });
  const token = `ocx_data_${"c".repeat(40)}`;
  const client = {
    serverUrl: "http://127.0.0.1:34567", managementUrl: "http://127.0.0.1:34567", managementTransport: "direct",
    transport: "link", link: { tunnelPort: 34567, linkId: "lnk_0123456789abcdef" }, selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "key-1", tokenFingerprint: serviceApiTokenFingerprint(token),
    protocolVersion: 1, connectedAt: "2026-09-25T00:00:00.000Z",
  };
  const source = `
    import { mock } from "bun:test";
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { getDefaultConfig, saveConfig } from ${JSON.stringify(repoPath("src/config.ts"))};
    import { clientSyncRuntimeGuard } from ${JSON.stringify(repoPath("src/client/sync-runtime.ts"))};
    import { createLocalAttestationChallenge } from ${JSON.stringify(repoPath("src/lib/local-management-attestation.ts"))};
    import { createSystemRestartCapability, SYSTEM_RESTART_CAPABILITY_HEADER,
      SYSTEM_RESTART_EXPECTED_PID_HEADER, SYSTEM_RESTART_NONCE_HEADER, SYSTEM_RESTART_PATH
    } from ${JSON.stringify(repoPath("src/lib/system-restart-contract.ts"))};
    const recordPath = join(process.env.OPENCODEX_HOME, "runtime-port.json");
    const readRecord = () => JSON.parse(readFileSync(recordPath, "utf8"));
    const verdict = check => { try { check(); return "committed"; } catch (error) { return error.code ?? String(error); } };
    let admittedBefore = () => { throw new Error("not admitted"); };
    let during = null;
    let replacementFailed;
    const failed = new Promise(resolve => { replacementFailed = resolve; });
    const replacement = await import(${JSON.stringify(repoPath("src/server/restart-replacement.ts"))});
    mock.module(${JSON.stringify(repoPath("src/server/restart-replacement.ts"))}, () => ({
      ...replacement,
      spawnReplacementStart: async () => {
        // No runtime serves now: the drained record is marked, and the admitted sync stands down.
        during = { stopping: readRecord().clientStopping === true, sync: verdict(admittedBefore) };
        replacementFailed();
        throw new Error("fixture replacement failed");
      },
    }));
    const { startClientRuntime } = await import(${JSON.stringify(repoPath("src/client/runtime.ts"))});
    const config = getDefaultConfig();
    config.port = ${freePort()};
    config.runtimeRole = "client";
    config.client = ${JSON.stringify(client)};
    saveConfig(config);
    await startClientRuntime({ block: false }, { restartSupervisor: async () => null });
    const before = readRecord();
    // A sync already past admission when the restart arrives.
    admittedBefore = clientSyncRuntimeGuard();
    const nonce = createLocalAttestationChallenge();
    const response = await fetch("http://127.0.0.1:" + before.port + SYSTEM_RESTART_PATH, {
      method: "POST", headers: {
        Connection: "close",
        [SYSTEM_RESTART_EXPECTED_PID_HEADER]: String(process.pid),
        [SYSTEM_RESTART_NONCE_HEADER]: nonce,
        [SYSTEM_RESTART_CAPABILITY_HEADER]: createSystemRestartCapability(before.attestationSecret, nonce, "POST", SYSTEM_RESTART_PATH, process.pid, before.port),
      },
    });
    await response.arrayBuffer();
    if (response.status !== 202) throw new Error("restart refused: " + response.status);
    await failed;
    let after = readRecord();
    for (let attempt = 0; attempt < 400 && (after.clientStopping || after.servingGeneration === before.servingGeneration); attempt++) {
      await Bun.sleep(10);
      after = readRecord();
    }
    writeFileSync(join(process.env.OPENCODEX_HOME, "fence.json"), JSON.stringify({
      during,
      rolledBack: after.pid === process.pid && after.port === before.port && after.clientStopping === undefined,
      newGeneration: typeof after.servingGeneration === "string" && after.servingGeneration !== before.servingGeneration,
      admittedBefore: verdict(admittedBefore),
      admittedAfter: verdict(clientSyncRuntimeGuard()),
    }));
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    cwd: root,
    env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), CODEX_HOME: join(root, "codex"),
      OPENCODEX_HOME: join(root, "ocx"), OCX_SERVICE_MANAGED: "0", OCX_SERVICE: "", OCX_DESKTOP_SUPERVISED: "" },
    stdout: "ignore", stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  try {
    const exit = await child.exited;
    const stderr = await errors;
    expect({ exit, fence: existsSync(join(root, "ocx", "fence.json")) }).toEqual({ exit: 0, fence: true });
    expect(JSON.parse(readFileSync(join(root, "ocx", "fence.json"), "utf8"))).toEqual({
      during: { stopping: true, sync: "client_runtime_stopping" },
      rolledBack: true,
      newGeneration: true,
      admittedBefore: "client_runtime_changed",
      admittedAfter: "committed",
    });
    void stderr;
  } finally {
    if (child.exitCode === null) child.kill();
    removeTreeWithRetry(root);
  }
}, watchdogMs(60_000));

test("a restart whose sync fence cannot be written abandons the restart before the listener closes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-client-restart-fence-failed-"));
  for (const dir of ["ocx", "codex", "home"]) mkdirSync(join(root, dir), { recursive: true });
  const token = `ocx_data_${"c".repeat(40)}`;
  const client = {
    serverUrl: "http://127.0.0.1:34567", managementUrl: "http://127.0.0.1:34567", managementTransport: "direct",
    transport: "link", link: { tunnelPort: 34567, linkId: "lnk_0123456789abcdef" }, selectedClients: ["codex"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN", apiKeyId: "key-1", tokenFingerprint: serviceApiTokenFingerprint(token),
    protocolVersion: 1, connectedAt: "2026-09-25T00:00:00.000Z",
  };
  const source = `
    import { mock } from "bun:test";
    import { readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    import { getDefaultConfig, saveConfig } from ${JSON.stringify(repoPath("src/config.ts"))};
    import { createLocalAttestationChallenge } from ${JSON.stringify(repoPath("src/lib/local-management-attestation.ts"))};
    import { createSystemRestartCapability, SYSTEM_RESTART_CAPABILITY_HEADER,
      SYSTEM_RESTART_EXPECTED_PID_HEADER, SYSTEM_RESTART_NONCE_HEADER, SYSTEM_RESTART_PATH
    } from ${JSON.stringify(repoPath("src/lib/system-restart-contract.ts"))};
    const recordPath = join(process.env.OPENCODEX_HOME, "runtime-port.json");
    const readRecord = () => JSON.parse(readFileSync(recordPath, "utf8"));
    let fenceAttempted;
    const attempted = new Promise(resolve => { fenceAttempted = resolve; });
    let replacementStarted = false;
    // The mark cannot be written, as when the config lock stays busy through every retry.
    const syncRuntime = await import(${JSON.stringify(repoPath("src/client/sync-runtime.ts"))});
    mock.module(${JSON.stringify(repoPath("src/client/sync-runtime.ts"))}, () => ({
      ...syncRuntime,
      markClientRuntimeStoppingWithRetry: async () => { fenceAttempted(); return false; },
    }));
    const replacement = await import(${JSON.stringify(repoPath("src/server/restart-replacement.ts"))});
    mock.module(${JSON.stringify(repoPath("src/server/restart-replacement.ts"))}, () => ({
      ...replacement,
      spawnReplacementStart: async () => { replacementStarted = true; throw new Error("must not start"); },
    }));
    const { startClientRuntime } = await import(${JSON.stringify(repoPath("src/client/runtime.ts"))});
    const config = getDefaultConfig();
    config.port = ${freePort()};
    config.runtimeRole = "client";
    config.client = ${JSON.stringify(client)};
    saveConfig(config);
    await startClientRuntime({ block: false }, { restartSupervisor: async () => null });
    const before = readRecord();
    const nonce = createLocalAttestationChallenge();
    const response = await fetch("http://127.0.0.1:" + before.port + SYSTEM_RESTART_PATH, {
      method: "POST", headers: {
        Connection: "close",
        [SYSTEM_RESTART_EXPECTED_PID_HEADER]: String(process.pid),
        [SYSTEM_RESTART_NONCE_HEADER]: nonce,
        [SYSTEM_RESTART_CAPABILITY_HEADER]: createSystemRestartCapability(before.attestationSecret, nonce, "POST", SYSTEM_RESTART_PATH, process.pid, before.port),
      },
    });
    await response.arrayBuffer();
    if (response.status !== 202) throw new Error("restart refused: " + response.status);
    await attempted;
    // The abandoned restart returns right after the failed fence; one turn lets it settle.
    await Bun.sleep(50);
    const health = await fetch("http://127.0.0.1:" + before.port + "/healthz", { headers: { Connection: "close" } });
    await health.arrayBuffer();
    writeFileSync(join(process.env.OPENCODEX_HOME, "fence.json"), JSON.stringify({
      replacementStarted,
      stillServing: health.status === 200,
      recordUnchanged: JSON.stringify(readRecord()) === JSON.stringify(before),
    }));
    process.exit(0);
  `;
  const child = Bun.spawn([process.execPath, "-e", source], {
    cwd: root,
    env: { ...process.env, HOME: join(root, "home"), USERPROFILE: join(root, "home"), CODEX_HOME: join(root, "codex"),
      OPENCODEX_HOME: join(root, "ocx"), OCX_SERVICE_MANAGED: "0", OCX_SERVICE: "", OCX_DESKTOP_SUPERVISED: "" },
    stdout: "ignore", stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  try {
    const exit = await child.exited;
    const stderr = await errors;
    expect({ exit, fence: existsSync(join(root, "ocx", "fence.json")), stderr: exit === 0 ? "" : stderr }).toEqual({ exit: 0, fence: true, stderr: "" });
    expect(JSON.parse(readFileSync(join(root, "ocx", "fence.json"), "utf8"))).toEqual({
      replacementStarted: false, stillServing: true, recordUnchanged: true,
    });
  } finally {
    if (child.exitCode === null) child.kill();
    removeTreeWithRetry(root);
  }
}, watchdogMs(60_000));
