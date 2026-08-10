import { createHash } from "node:crypto";
import { jcsStringify } from "./jcs";

function domainHash(domain: string, payload: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(new TextEncoder().encode(`${domain}\0`));
  if (typeof payload === "string") hash.update(new TextEncoder().encode(payload));
  else hash.update(payload);
  return hash.digest("hex");
}

export function fixtureDigest(bytes: Uint8Array): string {
  return domainHash("ocx-lab:fixture:v1", bytes);
}

export function scenarioManifestDigest(expandedScenario: Record<string, unknown>): string {
  return domainHash("ocx-lab:scenario-manifest:v1", jcsStringify(expandedScenario));
}

export function suiteManifestDigest(expandedSuite: Record<string, unknown>): string {
  return domainHash("ocx-lab:suite-manifest:v1", jcsStringify(expandedSuite));
}
