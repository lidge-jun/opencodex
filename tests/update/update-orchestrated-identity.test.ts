import { expect, test } from "bun:test";
import { inspectOrchestratedServingIdentity } from "../../src/update/orchestrated-identity";
import { inspectLiveOrchestratedIdentity } from "../../src/update/orchestrated-live-identity";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_ATTESTATION_CHALLENGE_HEADER, LOCAL_ATTESTATION_PROOF_HEADER, createLocalAttestationProof } from "../../src/lib/local-management-attestation";

const command = ["/fixture/bun", "/fixture/install/src/cli/index.ts"];
const record = JSON.stringify({ pid: 22, port: 10101, hostname: "127.0.0.1", attestationSecret: "a".repeat(43), command });
const base = {
  readRecord: () => ({ kind: "record" as const, raw: record }),
  prove: async () => "proven" as const,
  probeConfigured: async () => "dead" as const,
  realpath: (path: string) => path,
};

test("identity requires a stable, attested runtime record", async () => {
  expect(await inspectOrchestratedServingIdentity(base)).toMatchObject({ kind: "live", servingRoot: "/fixture/install", runtime: { pid: 22, command } });
  for (const proof of ["refuted", "indeterminate"] as const) {
    expect(await inspectOrchestratedServingIdentity({ ...base, prove: async () => proof })).toEqual({ kind: "unknown" });
  }
  let count = 0;
  expect(await inspectOrchestratedServingIdentity({ ...base, readRecord: () => ({ kind: "record", raw: ++count === 1 ? record : record + " " }) })).toEqual({ kind: "unknown" });
  expect(await inspectOrchestratedServingIdentity({ ...base, readRecord: () => ({ kind: "record", raw: JSON.stringify({ pid: 22, port: 10101, hostname: "127.0.0.1", command }) }) })).toEqual({ kind: "unknown" });
});

test("only a missing record plus a dead configured listener proves absence", async () => {
  const absent = { ...base, readRecord: () => ({ kind: "missing" as const }) };
  expect(await inspectOrchestratedServingIdentity(absent)).toEqual({ kind: "absent" });
  expect(await inspectOrchestratedServingIdentity({ ...absent, probeConfigured: async () => "unknown" })).toEqual({ kind: "unknown" });
  expect(await inspectOrchestratedServingIdentity({ ...absent, probeConfigured: async () => "live" })).toEqual({ kind: "unknown" });
  expect(await inspectOrchestratedServingIdentity({ ...base, readRecord: () => ({ kind: "unreadable" }) })).toEqual({ kind: "unknown" });
});

test("an attested legacy record refuses a proven executable mismatch without guessing its install root", async () => {
  const legacy = JSON.stringify({ pid: 22, port: 10101, hostname: "127.0.0.1", attestationSecret: "a".repeat(43) });
  const deps = { ...base, readRecord: () => ({ kind: "record" as const, raw: legacy }) };
  expect(await inspectOrchestratedServingIdentity({ ...deps, legacyExecutableDiffers: async () => true })).toEqual({ kind: "mismatch" });
  expect(await inspectOrchestratedServingIdentity({ ...deps, legacyExecutableDiffers: async () => false })).toEqual({ kind: "unknown" });
});

test("a real temporary listener proves its record and a replacement record is refused", async () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-orchestrated-identity-"));
  const source = join(root, "install", "src", "cli", "index.ts");
  mkdirSync(join(root, "install", "src", "cli"), { recursive: true });
  writeFileSync(source, "fixture");
  const secret = "a".repeat(43), recordPath = join(root, "runtime-port.json");
  let replace = false;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const challenge = request.headers.get(LOCAL_ATTESTATION_CHALLENGE_HEADER);
    if (replace) writeFileSync(recordPath, JSON.stringify({ pid: process.pid, port: server.port, hostname: "127.0.0.1", attestationSecret: secret, command: [process.execPath, source], changed: true }));
    const proof = challenge ? createLocalAttestationProof(secret, challenge, process.pid, server.port!) : null;
    return Response.json({ service: "opencodex", status: "ok", pid: process.pid, version: "2.0.0" }, { headers: proof ? { [LOCAL_ATTESTATION_PROOF_HEADER]: proof } : {} });
  } });
  try {
    writeFileSync(recordPath, JSON.stringify({ pid: process.pid, port: server.port, hostname: "127.0.0.1", attestationSecret: secret, command: [process.execPath, source] }));
    expect(await inspectLiveOrchestratedIdentity(root, { port: server.port!, hostname: "127.0.0.1" })).toMatchObject({ kind: "live", runtime: { pid: process.pid } });
    replace = true;
    expect(await inspectLiveOrchestratedIdentity(root, { port: server.port!, hostname: "127.0.0.1" })).toEqual({ kind: "unknown" });
  } finally { server.stop(true); rmSync(root, { recursive: true, force: true }); }
});
