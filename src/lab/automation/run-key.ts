import { createHash } from "node:crypto";
import { jcsStringify } from "../digest";
import type { LabAutomationLayer } from "./types";

export interface RunKeyInput {
  evidenceLayer: LabAutomationLayer;
  subjectId: string;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  scenarioId: string;
  scenarioVersion: string;
  scenarioManifestDigest: string;
  executionContractDigest: string;
}

/** Deterministic deduplication key for orchestration runs. */
export function buildLabAutomationRunKey(input: RunKeyInput): string {
  const payload = {
    evidenceLayer: input.evidenceLayer,
    subjectId: input.subjectId,
    suiteId: input.suiteId,
    suiteVersion: input.suiteVersion,
    suiteManifestDigest: input.suiteManifestDigest,
    scenarioId: input.scenarioId,
    scenarioVersion: input.scenarioVersion,
    scenarioManifestDigest: input.scenarioManifestDigest,
    executionContractDigest: input.executionContractDigest,
  };
  return createHash("sha256").update(jcsStringify(payload)).digest("hex");
}

/** Contract identity digest for protocol/live/fabric execution boundaries. */
export function protocolExecutionContractDigest(): string {
  return createHash("sha256").update(jcsStringify({ contract: "cl-01-protocol-harness-v1" })).digest("hex");
}

export function liveExecutionContractDigest(): string {
  return createHash("sha256").update(jcsStringify({ contract: "cl-03-live-trusted-route-v1" })).digest("hex");
}

export function fabricExecutionContractDigest(): string {
  return createHash("sha256").update(jcsStringify({ contract: "cl-07-fabric-trusted-route-v1" })).digest("hex");
}
