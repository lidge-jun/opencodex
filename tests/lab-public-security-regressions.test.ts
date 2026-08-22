import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jcsStringify } from "../src/lab/conformance/jcs";
import type { ObservationEvent } from "../src/lab/events/types";
import { labPublicPublisherKeyPath } from "../src/lab/paths";
import { publishPrivateFileExclusive } from "../src/lab/public/private-file";
import { validatePublicEvidencePrivacy } from "../src/lab/public/privacy";
import { projectPublicEvidenceRecord } from "../src/lab/public/project";
import { getOrCreatePublicPublisher } from "../src/lab/public/signature";
import type { PublicEvidenceBundleUnsignedV1 } from "../src/lab/public/types";
import {
  resetHardenedStateForTests,
  setIcaclsRunnerForTests,
  setPlatformForTests,
} from "../src/lib/windows-secret-acl";
import { setWindowsPrincipalRunnerForTests } from "../src/lib/windows-user-principal";

const roots: string[] = [];

afterEach(() => {
  setIcaclsRunnerForTests(null);
  setWindowsPrincipalRunnerForTests(null);
  setPlatformForTests(null);
  resetHardenedStateForTests();
  for (const root of roots.splice(0)) {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  }
});

function configDir(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

test("JCS rejects sparse JavaScript arrays instead of collapsing holes", () => {
  const sparse = new Array<unknown>(1);
  expect(() => jcsStringify(sparse)).toThrow(/sparse|array hole/i);
});

test("JCS rejects non-plain objects instead of collapsing canonical identity", () => {
  const values: unknown[] = [
    new Date(0),
    new Map([["a", 1]]),
    new Set([1]),
    new Uint8Array([1, 2, 3]),
  ];
  for (const value of values) {
    expect(() => jcsStringify(value)).toThrow(/plain JSON object/i);
  }
});

test("public projection maps JCS-invalid public fields to not_exportable", () => {
  const observation = {
    evidenceLayer: "protocol_conformance",
    subject: {
      subjectKind: "protocol",
      effectiveAdapter: "openai-chat",
      opencodexCompatibilityVersion: "2.13.0",
      inboundProtocol: "openai-responses",
      upstreamProtocol: "openai-chat",
      surface: "responses-\uD800",
    },
  } as unknown as ObservationEvent;

  expect(projectPublicEvidenceRecord({ observation, verdict: "VERIFIED" })).toEqual({
    status: "not_exportable",
    reason: "unsafe_public_field",
  });
});

test("public projection drops invalid completion timestamps with a diagnostic code", () => {
  const observation = {
    evidenceLayer: "protocol_conformance",
    suiteId: "responses-core",
    suiteVersion: "1.0.0",
    scenarioId: "responses-core.protocol.request-shape",
    scenarioVersion: "1.0.0",
    completedAt: Date.UTC(10_000, 0, 1),
    assertions: [],
    subject: {
      subjectKind: "protocol",
      effectiveAdapter: "openai-chat",
      opencodexCompatibilityVersion: "2.13.0",
      inboundProtocol: "openai-responses",
      upstreamProtocol: "openai-chat",
      surface: "responses-http",
    },
  } as unknown as ObservationEvent;

  expect(projectPublicEvidenceRecord({ observation, verdict: "VERIFIED" })).toEqual({
    status: "not_exportable",
    reason: "unsafe_public_field",
    detailCode: "public_selection_time",
  });
});

test("public privacy rejects embedded POSIX absolute paths across common runtime roots", () => {
  const localPaths = [
    "/var/folders/9k/opencodex/output.json",
    "/dev/shm/opencodex.sock",
    "/run/user/1000/opencodex/token",
    "/Library/Application Support/opencodex/config.json",
  ];

  for (const localPath of localPaths) {
    const bytes = Buffer.from(`diagnostic path=${localPath}`, "utf8");
    const bundle = {
      createdDayUtc: "2026-08-14",
      records: [],
      artifacts: [{
        artifactId: "0".repeat(64),
        artifactClass: "verifier_summary",
        mediaType: "text/plain",
        byteCount: bytes.byteLength,
        contentBase64: bytes.toString("base64"),
      }],
    } as unknown as PublicEvidenceBundleUnsignedV1;

    expect(() => validatePublicEvidencePrivacy(bundle)).toThrow(/local path|privacy/i);
  }
});

test("private publication prepares an empty stage before writing secret bytes", () => {
  const root = configDir("ocx-cl10-private-stage-prepare-");
  const finalPath = join(root, "secret.bin");
  const observedSizes: number[] = [];

  expect(publishPrivateFileExclusive(finalPath, Buffer.from("secret", "utf8"), {
    prepareStage: stagePath => observedSizes.push(statSync(stagePath).size),
  })).toEqual({ created: true });
  expect(observedSizes).toEqual([0]);
});

test("publisher key creation applies required Windows secret ACL hardening to the final key path", () => {
  const home = configDir("ocx-cl10-windows-publisher-acl-");
  const keyPath = labPublicPublisherKeyPath(home);
  const calls: string[][] = [];

  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setIcaclsRunnerForTests((args) => {
    calls.push(args);
    return { success: true, exitCode: 0, timedOut: false, stdout: "" };
  });

  expect(getOrCreatePublicPublisher(home).publisher.algorithm).toBe("ed25519");
  expect(existsSync(keyPath)).toBe(true);
  expect(calls.some((args) => args[0] === keyPath && args.includes("/grant:r"))).toBe(true);
  expect(calls.some((args) => args[0] === keyPath && args.includes("/inheritance:r"))).toBe(true);
});

test("publisher key creation never publishes the final path when required Windows ACL hardening fails", () => {
  const home = configDir("ocx-cl10-windows-publisher-acl-fail-");
  const keyPath = labPublicPublisherKeyPath(home);

  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setIcaclsRunnerForTests(() => ({
    success: false,
    exitCode: 5,
    timedOut: false,
    stdout: "",
  }));

  expect(() => getOrCreatePublicPublisher(home)).toThrow(/ACL hardening/i);
  expect(existsSync(keyPath)).toBe(false);
});

test("publisher key ACL failures preserve their underlying cause", () => {
  const home = configDir("ocx-cl10-windows-publisher-acl-cause-");

  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setIcaclsRunnerForTests(() => {
    throw new Error("synthetic icacls runner failure");
  });

  let caught: unknown;
  try {
    getOrCreatePublicPublisher(home);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error & { cause?: unknown }).cause).toBeInstanceOf(Error);
});

function publisherKeyAclFailureMessage(prefix: string): string {
  const home = configDir(prefix);
  try {
    getOrCreatePublicPublisher(home);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected required publisher key ACL hardening to fail");
}

// #2152: on the Windows CI leg every publisher-key harden failure arrived as one
// fixed string. The three causes that occur there need different fixes -- the
// budget, the effective-SID lookup, or icacls itself -- and the code lived only on
// `cause`, which the reporter does not print. Diagnosing it needed a Windows box.
test("a required publisher key ACL timeout names ETIMEDOUT in its message", () => {
  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setIcaclsRunnerForTests(() => ({ success: false, exitCode: null, timedOut: true, stdout: "" }));

  expect(publisherKeyAclFailureMessage("ocx-cl10-acl-code-timeout-")).toContain("ETIMEDOUT");
});

test("a required publisher key icacls refusal names EICACLS in its message", () => {
  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setIcaclsRunnerForTests(() => ({ success: false, exitCode: 5, timedOut: false, stdout: "" }));

  expect(publisherKeyAclFailureMessage("ocx-cl10-acl-code-icacls-")).toContain("EICACLS");
});

// The identity code is raised by windows-user-principal, one module further out
// than the icacls runner, so this also pins that it survives the hand-off.
test("a required publisher key SID lookup failure names EACLIDENTITY in its message", () => {
  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setIcaclsRunnerForTests(() => ({ success: true, exitCode: 0, timedOut: false, stdout: "" }));
  setWindowsPrincipalRunnerForTests(() => ({
    success: false,
    exitCode: null,
    timedOut: true,
    stdout: "",
  }));

  expect(publisherKeyAclFailureMessage("ocx-cl10-acl-code-identity-")).toContain("EACLIDENTITY");
});

// A cause with no errno-shaped code must leave the message alone rather than
// print an empty parenthetical, and nothing but the bounded code may be appended.
test("a publisher key ACL failure without a bounded code keeps the plain message", () => {
  resetHardenedStateForTests();
  setPlatformForTests("win32");
  setIcaclsRunnerForTests(() => {
    throw new Error("synthetic icacls runner failure");
  });

  const message = publisherKeyAclFailureMessage("ocx-cl10-acl-code-plain-");
  expect(message).toBe("public publisher key ACL hardening did not complete");
});
