import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicEvidenceId } from "../src/lab/public/ids";
import { isPrivateFileStageName, setPrivateFileCommitFaultForTests } from "../src/lab/public/private-file";
import { getOrCreatePublicPublisher, signPublicEvidenceBundle } from "../src/lab/public/signature";
import { storePublicEvidenceBundle } from "../src/lab/public/storage";
import type { PublicEvidenceRecordV1 } from "../src/lab/public/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

const roots: string[] = [];
afterEach(() => {
  setPrivateFileCommitFaultForTests(null);
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "ocx-cl10-recovery-"));
  roots.push(value);
  return value;
}

function record(): PublicEvidenceRecordV1 {
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
    observedDayUtc: "2026-08-12",
    subject,
    assertions: [
      { id: "method", required: true, passed: true },
      { id: "message", required: true, passed: true },
      { id: "temperature", required: true, passed: true },
    ],
  };
  return { recordId: publicEvidenceId("record", body), ...body };
}

test("publisher key recovers after a same-process parent-directory sync failure", () => {
  if (process.platform === "win32") return;
  const configDir = root();
  setPrivateFileCommitFaultForTests("parent_directory_sync");
  expect(() => getOrCreatePublicPublisher(configDir)).toThrow(/directory.*sync|durab/i);
  setPrivateFileCommitFaultForTests(null);
  expect(getOrCreatePublicPublisher(configDir).publisher.algorithm).toBe("ed25519");
  expect(readdirSync(join(configDir, "lab")).filter(isPrivateFileStageName)).toEqual([]);
});

test("public bundle storage recovers after a same-process parent-directory sync failure", () => {
  if (process.platform === "win32") return;
  const configDir = root();
  const bundle = signPublicEvidenceBundle({ records: [record()], artifacts: [], createdDayUtc: "2026-08-12", configDir });
  setPrivateFileCommitFaultForTests("parent_directory_sync");
  expect(() => storePublicEvidenceBundle(bundle, configDir)).toThrow(/directory.*sync|durab/i);
  setPrivateFileCommitFaultForTests(null);
  expect(storePublicEvidenceBundle(bundle, configDir).created).toBe(false);
});
