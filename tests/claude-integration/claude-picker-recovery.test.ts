// INV-PICKER-02: the outgoing public picker CA survives process replacement until a confirmed untrust clears it.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDesktopPickerController } from "../../src/claude/desktop-picker";
import { createCertificateAuthority } from "../../src/claude/intercept/local-ca";
import {
  ensurePickerCa, pickerCaCertPath, pickerCaFingerprints, pickerCaPendingUntrustPath,
  readPendingPickerCaUntrust, PICKER_CA_COMMON_NAME, PICKER_HOST,
} from "../../src/claude/intercept/picker-ca";
import type { PickerRuntime } from "../../src/claude/intercept/picker-runtime";
import type { OcxConfig } from "../../src/types";

const runtimeUrl = pathToFileURL(join(import.meta.dir, "../../src/claude/intercept/runtime.ts")).href;
const proxyUrl = pathToFileURL(join(import.meta.dir, "../../src/claude/intercept/connect-proxy.ts")).href;
const caUrl = pathToFileURL(join(import.meta.dir, "../../src/claude/intercept/picker-ca.ts")).href;

// Logical configured ports are asserted separately from kernel-owned allocations.
const REQUESTED_PROXY_PORT = 10234;

function replacement(root: string, port: number, fail: boolean, fingerprints: string[]) {
  const source = `
    import { readFileSync } from "node:fs";
    import { startClaudeIntercept, getClaudePickerRuntime } from ${JSON.stringify(runtimeUrl)};
    import { startConnectProxy } from ${JSON.stringify(proxyUrl)};
    import { pickerCaFingerprints } from ${JSON.stringify(caUrl)};
    const root = ${JSON.stringify(root)};
    const trusted = new Set(${JSON.stringify(fingerprints)});
    const attempts = [];
    const security = async args => {
      if (args[0] === "find-certificate") return { code: 0, stdout: [...trusted].map(sha => "SHA-1 hash: " + sha).join("\\n"), stderr: "" };
      if (args[0] === "remove-trusted-cert") {
        const sha = pickerCaFingerprints(readFileSync(args[1], "utf8")).sha1;
        attempts.push(sha);
        if (${fail}) return { code: 1, stdout: "", stderr: "" };
        trusted.delete(sha);
      }
      if (args[0] === "delete-certificate" && !${fail}) trusted.delete(args[2]);
      return { code: ${fail} && args[0] === "delete-certificate" ? 1 : 0, stdout: "", stderr: "" };
    };
    const requestedPorts = [];
    let created = false;
    const handle = await startClaudeIntercept({
      config: { port: 10100, providers: {}, defaultProvider: "openai", claudeCode: { intercept: { port: ${port} } } },
      publicPort: 10100, configDir: root, dispatch: async () => new Response("unused"),
      loadPickerRoutes: async () => ({ nativeSlugs: [], routedModels: [] }),
      createPicker: () => { created = true; return { selectTunnel: () => ({ kind: "blind" }), start: async () => {}, stop: async () => {} }; },
      pickerSecurity: security, pickerPlatform: "darwin",
      // Bind real proxies on port 0; probing and releasing a port does not reserve its neighbour.
      startProxy: async (requestedPort, options) => {
        requestedPorts.push(requestedPort);
        return startConnectProxy(0, options);
      },
    });
    const result = { created, active: getClaudePickerRuntime() !== null, attempts, requestedPorts,
      pickerPort: handle?.pickerProxyPort ?? null, proxyPort: handle?.proxyPort ?? null, listenerPort: handle?.listener.port ?? null };
    await handle?.stop();
    process.stdout.write(JSON.stringify(result));
  `;
  const child = Bun.spawnSync({
    cmd: [process.execPath, "-e", source],
    cwd: root,
    env: { ...process.env, HOME: root, OPENCODEX_HOME: root, CODEX_HOME: join(root, "codex"), TMPDIR: root },
    stdout: "pipe", stderr: "pipe",
  });
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  return JSON.parse(child.stdout.toString()) as { created: boolean; active: boolean; attempts: string[]; requestedPorts: number[];
    pickerPort: number | null; proxyPort: number | null; listenerPort: number | null };
}

test("a replacement process retries the recorded predecessor before rotating and arming", { timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-picker-recovery-"));
  // Keep the logical picker port occupied to prove the child owns separate real allocations.
  const occupied = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("occupied") });
  try {
    mkdirSync(join(root, "codex"));
    const foreign = createCertificateAuthority({ commonName: PICKER_CA_COMMON_NAME, permittedDnsNames: [PICKER_HOST] });
    const stateDir = join(root, "claude-picker");
    await Bun.write(join(stateDir, "ca.pem"), foreign.certPem);
    const foreignSha1 = pickerCaFingerprints(foreign.certPem).sha1;
    const port = occupied.port - 1;
    const first = replacement(root, port, true, [foreignSha1]);
    expect(first).toMatchObject({ created: false, active: false, attempts: [foreignSha1] });
    expect(readPendingPickerCaUntrust(root)?.sha1).toBe(foreignSha1);
    const firstProcessSha1 = pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8")).sha1;
    expect(firstProcessSha1).not.toBe(foreignSha1);
    const second = replacement(root, port, false, [foreignSha1, firstProcessSha1]);
    expect(second).toMatchObject({ created: true, active: true, attempts: [foreignSha1, firstProcessSha1] });
    expect(second.requestedPorts).toEqual([port, port + 1]);
    const boundPorts = [second.listenerPort, second.proxyPort, second.pickerPort];
    expect(boundPorts.every(value => typeof value === "number" && Number.isInteger(value) && value > 0)).toBe(true);
    expect(new Set(boundPorts).size).toBe(boundPorts.length);
    expect(readPendingPickerCaUntrust(root)).toBeNull();
  } finally {
    occupied.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test("controller enable with pending cleanup does not request trust", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-picker-pending-enable-"));
  try {
    const ca = ensurePickerCa(root);
    writeFileSync(pickerCaPendingUntrustPath(root), JSON.stringify({ certPem: ca.certPem, ...pickerCaFingerprints(ca.certPem) }));
    const calls: string[] = [];
    const runtime = { status: () => ({
      desired: true, supported: true, trust: "untrusted", listenerReady: false, effective: false,
      latched: false, reason: "trust_untrusted", models: 0, snapshotAt: null, lastBootstrapAt: null,
    }), rearm: async () => { throw new Error("must not rearm"); } } as unknown as PickerRuntime;
    const current = { port: 10100, providers: {}, defaultProvider: "openai",
      clientIntegrations: { "claude-desktop": true }, claudeCode: { desktopMode: "first-party", intercept: { picker: true } },
    } as OcxConfig;
    const controller = createDesktopPickerController({
      runtime, readConfig: () => current, persistPreference: () => true, proxyPort: () => 10201,
      configDir: root, platform: "darwin", security: async args => {
        calls.push(args[0]!);
        return { code: 0, stdout: "", stderr: "" };
      },
    });
    expect((await controller.enable({ persist: false, context: "server" })).effective).toBe(false);
    expect(calls).toEqual([]);
    expect(readPendingPickerCaUntrust(root)).not.toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("replacement defers a pending certificate still published by a live owner", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-picker-live-owner-"));
  try {
    mkdirSync(join(root, "codex"));
    const ca = ensurePickerCa(root);
    const pending = { certPem: ca.certPem, ...pickerCaFingerprints(ca.certPem) };
    writeFileSync(pickerCaPendingUntrustPath(root), JSON.stringify(pending));
    const port = REQUESTED_PROXY_PORT;
    const peer = replacement(root, port, false, [pending.sha1]);
    expect(peer).toMatchObject({ created: false, active: false, attempts: [] });
    expect(readPendingPickerCaUntrust(root)).toEqual(pending);
    expect(pickerCaFingerprints(readFileSync(pickerCaCertPath(root), "utf8")).sha1).toBe(pending.sha1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
