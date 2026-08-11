import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createLabDestination } from "../../src/lab";
import { runFabricSyntheticPatchTaskForRoute } from "../../src/lab/fabric/executor";
import type { FabricTaskRunResult } from "../../src/lab/fabric/types";
import { createHostIssuedFabricPatchExecutor } from "../../src/lib/fabric-task-host";
import type { LabBehaviorValues, LabRouteContext } from "../../src/lab/live/types";
import type { TrustedFabricPatchExecutor } from "../../src/lab/fabric/types";
import { correctSyntheticPatch } from "../../src/lab/fabric/executor";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURE_DIR = join(REPO_ROOT, "tests", "fixtures", "fabric-executors");

function repoImport(subpath: string): string {
  return join(REPO_ROOT, subpath).replace(/\\/g, "/");
}

export function fabricBehavior(adapter: string, upstreamProtocol: string): LabBehaviorValues {
  return {
    "wire.adapter": { source: "lab_forced", value: adapter },
    "wire.upstreamProtocol": { source: "lab_forced", value: upstreamProtocol },
    "auth.mode": { source: "provider_config", value: "api_key" },
    "auth.transport": { source: "provider_config", value: "authorization_bearer" },
    "mcp.nativeLocalExec": { source: "lab_forced", value: false },
    "runtime.bunVersion": { source: "lab_forced", value: Bun.version },
    "runtime.platform": { source: "lab_forced", value: process.platform },
    "runtime.arch": { source: "lab_forced", value: process.arch },
    "runtime.streamMode": { source: "lab_forced", value: "auto" },
    "runtime.fastMode": { source: "lab_forced", value: false },
    "runtime.effortCap": { source: "lab_forced", value: null },
    "headers.nonCredentialBehaviorDigest": { source: "provider_config", value: "0".repeat(64) },
  };
}

export function fabricMockRoute(overrides: Partial<LabRouteContext> = {}): LabRouteContext {
  const base = {
    providerId: "provider-a",
    providerInstanceKey: "fixture-provider-instance",
    clientModelId: "model-a",
    upstreamModelId: "model-a",
    effectiveAdapter: "openai-responses",
    inboundProtocol: "openai-responses",
    upstreamProtocol: "openai-responses",
    surface: "responses-http",
    baseUrl: "https://api.example.com/v1",
    opencodexCompatibilityVersion: "a".repeat(64),
    labRunApproval: true,
    allowPrivateNetwork: false,
    requiredClaims: [],
    availableHarnessFeatures: ["fabric-scratch-v1"],
  };
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    behaviorValues: overrides.behaviorValues ?? fabricBehavior(merged.effectiveAdapter, merged.upstreamProtocol),
  };
}

export function fabricCorrectPatchExecutor(): TrustedFabricPatchExecutor {
  const modulePath = join(FIXTURE_DIR, "correct-patch.ts");
  return createHostIssuedFabricPatchExecutor(modulePath, async () => correctSyntheticPatch());
}

export function fabricRouteBoundPatchExecutor(home: string, expectedProviderId: string): TrustedFabricPatchExecutor {
  const dir = join(home, "fabric-executors");
  mkdirSync(dir, { recursive: true });
  const modulePath = join(dir, `route-bound-${expectedProviderId}.ts`);
  writeFileSync(modulePath, `
import type { FabricPatchExecutorInput, SyntheticPatchV1 } from "${repoImport("src/lab/fabric/types")}";
import { SYNTHETIC_AFTER_UTF8, SYNTHETIC_VALUE_PATH } from "${repoImport("src/lab/fabric/constants")}";

const expectedProviderId = "${expectedProviderId}";

export async function execute(input: FabricPatchExecutorInput): Promise<SyntheticPatchV1> {
  if (input.routeSubject.providerId !== expectedProviderId) {
    throw new Error("route subject mismatch");
  }
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 }],
  };
}
`);
  return createHostIssuedFabricPatchExecutor(modulePath, async (input) => {
    if (input.routeSubject.providerId !== expectedProviderId) {
      throw new Error("route subject mismatch");
    }
    return correctSyntheticPatch();
  });
}

export function fabricWrongPatchExecutor(home: string): TrustedFabricPatchExecutor {
  const dir = join(home, "fabric-executors");
  mkdirSync(dir, { recursive: true });
  const modulePath = join(dir, "wrong-patch.ts");
  writeFileSync(modulePath, `
import type { FabricPatchExecutorInput, SyntheticPatchV1 } from "${repoImport("src/lab/fabric/types")}";
import { SYNTHETIC_VALUE_PATH } from "${repoImport("src/lab/fabric/constants")}";

export async function execute(_input: FabricPatchExecutorInput): Promise<SyntheticPatchV1> {
  return { schemaVersion: 1, operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: "wrong\\n" }] };
}
`);
  return createHostIssuedFabricPatchExecutor(modulePath, async () => ({
    schemaVersion: 1,
    operations: [{ op: "replace", path: "src/value.txt", contentUtf8: "wrong\n" }],
  }));
}

export function fabricOversizedPatchExecutor(home: string, huge: string): TrustedFabricPatchExecutor {
  const dir = join(home, "fabric-executors");
  mkdirSync(dir, { recursive: true });
  const modulePath = join(dir, "oversized-patch.ts");
  writeFileSync(modulePath, `import type { FabricPatchExecutorInput, SyntheticPatchV1 } from "${repoImport("src/lab/fabric/types")}";
import { SYNTHETIC_VALUE_PATH } from "${repoImport("src/lab/fabric/constants")}";
const huge = ${JSON.stringify(huge)};
export async function execute(_input: FabricPatchExecutorInput): Promise<SyntheticPatchV1> {
  return { schemaVersion: 1, operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: huge }] };
}`);
  return createHostIssuedFabricPatchExecutor(modulePath, async () => ({
    schemaVersion: 1,
    operations: [{ op: "replace", path: "src/value.txt", contentUtf8: huge }],
  }));
}

export async function runTrustedFabricTask(
  home: string,
  overrides: Partial<LabRouteContext> = {},
  now?: () => number,
): Promise<FabricTaskRunResult> {
  const destination = await createLabDestination({
    baseUrl: overrides.baseUrl ?? "https://api.example.com/v1",
    labRunApproval: true,
    resolve: async () => [{ address: "93.184.216.34", family: 4 }],
    configDir: home,
  });
  return runFabricSyntheticPatchTaskForRoute({
    routeContext: fabricMockRoute(overrides),
    destination,
    patchExecutor: fabricCorrectPatchExecutor(),
    configDir: home,
    now,
  });
}
