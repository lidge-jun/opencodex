import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleLabCommand } from "../src/cli/lab";
import { purgeSensitiveEvidence } from "../src/lab/ledger/purge";
import {
  ensureLabDirs,
  labCommunityDir,
  labPublicOriginDir,
  labPublicPublisherKeyPath,
} from "../src/lab/paths";
import {
  createPublicEvidenceRevocation,
  importCommunityEvidenceBundle,
  listCommunityEvidence,
  publicEvidenceId,
  recordLocalPublicOrigin,
  signPublicEvidenceBundle,
  writePublicEvidenceBundle,
  type PublicEvidenceRecordV1,
} from "../src/lab/public";
import {
  publicEvidenceMutationLockIsReclaimableForTests,
  publicEvidenceTryReclaimMutationLockForTests,
} from "../src/lab/public/mutation-lock";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function configDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function record(day = "2026-08-12"): PublicEvidenceRecordV1 {
  const subject = {
    subjectKind: "protocol" as const,
    compatibilityVersion: "2.13.0",
    adapterFamily: "openai-chat" as const,
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-chat",
    surface: "responses-http",
  };
  const subjectId = publicEvidenceId("subject", subject);
  const body = {
    subjectId,
    evidenceLayer: "protocol_conformance" as const,
    suiteId: "responses-core",
    suiteVersion: "1.0.0",
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1.0.0",
    verdict: "VERIFIED" as const,
    observedDayUtc: day,
    subject,
    assertions: [
      { id: "method", required: true, passed: true },
      { id: "message", required: true, passed: true },
      { id: "temperature", required: true, passed: true },
    ],
  };
  return { recordId: publicEvidenceId("record", body), ...body };
}

function bundle(home: string, records = [record()]) {
  return signPublicEvidenceBundle({
    records,
    artifacts: [],
    createdDayUtc: "2026-08-14",
    configDir: home,
  });
}

async function captureCli(argv: string[], home: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => { stdout.push(args.join(" ")); };
  console.error = (...args: unknown[]) => { stderr.push(args.join(" ")); };
  try {
    return {
      code: await handleLabCommand(argv, { configDir: home }),
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("ancient live-PID mutation owner becomes reclaimable after the absolute ceiling", () => {
  const home = configDir("ocx-cl10-lock-owner-ceiling-");
  ensureLabDirs(home);
  const lockPath = join(labCommunityDir(home), ".mutation-lock");
  mkdirSync(lockPath, { mode: 0o700 });
  const now = Date.now();
  writeFileSync(
    join(lockPath, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000000",
      createdAt: now - (8 * 24 * 60 * 60 * 1000),
    }),
    { mode: 0o600 },
  );

  expect(publicEvidenceMutationLockIsReclaimableForTests(home, now)).toBe(true);
});

test("ancient live-PID reclaim claim cannot block stale lock recovery forever", () => {
  const home = configDir("ocx-cl10-lock-claim-ceiling-");
  ensureLabDirs(home);
  const lockPath = join(labCommunityDir(home), ".mutation-lock");
  mkdirSync(lockPath, { mode: 0o700 });
  const now = Date.now();
  const old = now - (8 * 24 * 60 * 60 * 1000);
  writeFileSync(
    join(lockPath, "owner.json"),
    JSON.stringify({
      pid: process.pid,
      token: "00000000-0000-4000-8000-000000000000",
      createdAt: old,
    }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(lockPath, ".reclaim.json"),
    JSON.stringify({
      pid: process.pid,
      token: "11111111-1111-4111-8111-111111111111",
      createdAt: old,
    }),
    { mode: 0o600 },
  );

  expect(publicEvidenceTryReclaimMutationLockForTests(home, now)).toBe(true);
  expect(existsSync(lockPath)).toBe(false);
});

test("foreign origin-directory entries do not consume marker quota", () => {
  const home = configDir("ocx-cl10-origin-foreign-quota-");
  ensureLabDirs(home);
  const dir = labPublicOriginDir(home);
  for (let index = 0; index < 1024; index += 1) {
    writeFileSync(join(dir, `foreign-${String(index).padStart(4, "0")}`), "x", { mode: 0o600 });
  }
  const identity = {
    publisherKeyId: publicEvidenceId("publisher_key", { seed: "quota-publisher" }),
    bundleId: publicEvidenceId("bundle", { seed: "quota-bundle" }),
  };

  expect(() => recordLocalPublicOrigin(identity, home)).not.toThrow();
  expect(existsSync(join(dir, `origin-${identity.publisherKeyId}-${identity.bundleId}.json`))).toBe(true);
});

test("corrupt origin classification makes export purge report incomplete instead of clean success", () => {
  const home = configDir("ocx-cl10-origin-purge-incomplete-");
  const signed = bundle(home);
  const exportPath = writePublicEvidenceBundle(signed, home);
  importCommunityEvidenceBundle(signed, home);
  const originDir = labPublicOriginDir(home);
  const marker = readdirSync(originDir).find((name) => name.startsWith("origin-"));
  if (!marker) throw new Error("expected local origin marker");
  writeFileSync(join(originDir, marker), "{", { mode: 0o600 });
  // Remove the two fallback provenance sources so the corrupt marker is the only
  // evidence that can classify the matching community copy as locally originated.
  writeFileSync(exportPath, "{", { mode: 0o600 });
  unlinkSync(labPublicPublisherKeyPath(home));

  expect(() => purgeSensitiveEvidence({
    configDir: home,
    purgeActions: ["export"],
    recordedAt: Date.UTC(2026, 7, 14, 19, 0, 0),
  })).toThrow(/origin|classification|incomplete/i);
  expect(existsSync(exportPath)).toBe(false);
  expect(listCommunityEvidence(home).map((row) => row.bundleId)).toContain(signed.bundleId);
});

test("failed CLI verification is a state failure and never prints command usage", async () => {
  const home = configDir("ocx-cl10-cli-verify-failure-");
  const signed = bundle(home);
  const tampered = { ...signed, bundleDigest: "0".repeat(64) };
  const path = join(home, "tampered.json");
  writeFileSync(path, JSON.stringify(tampered), { mode: 0o600 });

  const result = await captureCli(["public", "verify", "--file", path], home);
  expect(result.code).toBe(1);
  expect(result.stdout).toMatch(/digest_invalid/i);
  expect(result.stderr).toMatch(/verification failed.*digest_invalid/i);
  expect(result.stderr).not.toMatch(/Usage:/i);
});

test("revocation canonicalization does not depend on localeCompare", () => {
  const home = configDir("ocx-cl10-revocation-order-");
  const first = record("2026-08-12");
  const second = record("2026-08-13");
  const signed = bundle(home, [first, second]);
  const originalLocaleCompare = String.prototype.localeCompare;
  String.prototype.localeCompare = function localeCompareForbidden(): number {
    throw new Error("localeCompare must not participate in signed canonicalization");
  };
  try {
    expect(() => createPublicEvidenceRevocation({
      configDir: home,
      targetBundle: signed,
      issuedDayUtc: "2026-08-14",
      reason: "superseded",
      targets: [
        { kind: "record", id: second.recordId },
        { kind: "record", id: first.recordId },
      ],
    })).not.toThrow();
  } finally {
    String.prototype.localeCompare = originalLocaleCompare;
  }
});
