import { FABRIC_LIMITS, SYNTHETIC_VALUE_PATH } from "./constants";
import { assertSafeRelativePosixPath, writeScratchFileUtf8 } from "./scratch";
import { FabricTaskError, type SyntheticPatchV1 } from "./types";

const ALLOWED_KEYS = new Set(["schemaVersion", "operations"]);
const OP_KEYS = new Set(["op", "path", "contentUtf8"]);

/** Parse and validate a synthetic-patch producer payload. */
export function parseSyntheticPatchV1(raw: unknown): SyntheticPatchV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FabricTaskError("malformed producer outcome: patch must be object", "malformed_producer_outcome", "harness");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new FabricTaskError(`malformed producer outcome: unknown field ${key}`, "malformed_producer_outcome", "harness");
    }
  }
  if (obj.schemaVersion !== 1) {
    throw new FabricTaskError("malformed producer outcome: schemaVersion", "malformed_producer_outcome", "harness");
  }
  if (!Array.isArray(obj.operations)) {
    throw new FabricTaskError("malformed producer outcome: operations", "malformed_producer_outcome", "harness");
  }
  if (obj.operations.length !== 1) {
    throw new FabricTaskError("exactly one patch operation is required", "malformed_producer_outcome", "harness");
  }
  const opRaw = obj.operations[0];
  if (!opRaw || typeof opRaw !== "object" || Array.isArray(opRaw)) {
    throw new FabricTaskError("malformed producer outcome: operation", "malformed_producer_outcome", "harness");
  }
  const op = opRaw as Record<string, unknown>;
  for (const key of Object.keys(op)) {
    if (!OP_KEYS.has(key)) {
      throw new FabricTaskError(`malformed producer outcome: unknown op field ${key}`, "malformed_producer_outcome", "harness");
    }
  }
  if (op.op !== "replace" || typeof op.path !== "string" || typeof op.contentUtf8 !== "string") {
    throw new FabricTaskError("malformed producer outcome: replace shape", "malformed_producer_outcome", "harness");
  }
  try {
    assertSafeRelativePosixPath(op.path);
  } catch (error) {
    if (error instanceof FabricTaskError) throw error;
    throw new FabricTaskError("patch path escapes scratch", "sandbox_violation", "harness");
  }
  if (op.path !== SYNTHETIC_VALUE_PATH) {
    throw new FabricTaskError("patch path must be src/value.txt", "behavioral_failure", "route");
  }
  const contentBytes = Buffer.byteLength(op.contentUtf8, "utf8");
  if (contentBytes > FABRIC_LIMITS.maxAggregateIoBytes) {
    throw new FabricTaskError("patch content exceeds io budget", "budget_exhausted", "environment");
  }
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: op.contentUtf8 }],
  };
}

/** Apply a validated synthetic patch inside the scratch tree under budget limits. */
export function applySyntheticPatch(scratchRoot: string, patch: SyntheticPatchV1): { bytesWritten: number; filesTouched: number; patchOperations: number } {
  if (patch.operations.length > FABRIC_LIMITS.maxPatchOperations) {
    throw new FabricTaskError("too many patch operations", "budget_exhausted", "environment");
  }
  let bytesWritten = 0;
  for (const operation of patch.operations) {
    bytesWritten += writeScratchFileUtf8(
      scratchRoot,
      operation.path,
      operation.contentUtf8,
      FABRIC_LIMITS.maxAggregateIoBytes,
    );
  }
  return {
    bytesWritten,
    filesTouched: patch.operations.length,
    patchOperations: patch.operations.length,
  };
}
