import { createHash } from "node:crypto";
import {
  FABRIC_LIMITS,
  FABRIC_VERIFIER_ID,
  SYNTHETIC_AFTER_UTF8,
  SYNTHETIC_BEFORE_UTF8,
  SYNTHETIC_VALUE_PATH,
} from "./constants";
import { readScratchFileUtf8, walkScratchFiles } from "./scratch";
import { verifierManifestDigest } from "./subject";
import type { ExactTreeDiffResultV1 } from "./types";
import { FabricTaskError } from "./types";

/** SHA-256 hex digest of a UTF-8 string for verifier tree comparisons. */
function sha256Utf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Deterministic exact-tree-diff-v1 verifier. No LLM. Walks only the scratch tree.
 */
export function verifyExactTreeDiffV1(scratchRoot: string): ExactTreeDiffResultV1 {
  const manifestDigest = verifierManifestDigest();
  const files = walkScratchFiles(scratchRoot);
  let aggregate = 0;
  for (const file of files) {
    aggregate += file.byteLength;
    if (aggregate > FABRIC_LIMITS.maxAggregateIoBytes) {
      throw new FabricTaskError("tree exceeds io budget", "budget_exhausted", "environment");
    }
  }
  if (files.length !== 1 || files[0]!.relativePosix !== SYNTHETIC_VALUE_PATH) {
    const unexpected = files
      .filter((row) => row.relativePosix !== SYNTHETIC_VALUE_PATH)
      .map((row) => row.relativePosix);
    return {
      verifierId: FABRIC_VERIFIER_ID,
      manifestDigest,
      passed: false,
      pathSummaries: [
        ...unexpected.map((path) => ({
          path,
          kind: "added" as const,
          reason: "unexpected_file",
        })),
        ...(files.some((row) => row.relativePosix === SYNTHETIC_VALUE_PATH)
          ? []
          : [{ path: SYNTHETIC_VALUE_PATH, kind: "deleted" as const, reason: "missing_required_file" }]),
      ],
      reason: files.length === 0 ? "deleted_required_file" : "unexpected_tree_shape",
    };
  }
  const after = readScratchFileUtf8(scratchRoot, SYNTHETIC_VALUE_PATH, FABRIC_LIMITS.maxAggregateIoBytes);
  const beforeDigest = sha256Utf8(SYNTHETIC_BEFORE_UTF8);
  const afterDigest = sha256Utf8(after);
  const expectedDigest = sha256Utf8(SYNTHETIC_AFTER_UTF8);
  if (after === SYNTHETIC_BEFORE_UTF8) {
    return {
      verifierId: FABRIC_VERIFIER_ID,
      manifestDigest,
      passed: false,
      pathSummaries: [{
        path: SYNTHETIC_VALUE_PATH,
        kind: "unchanged",
        beforeDigest,
        afterDigest,
        reason: "unchanged",
      }],
      reason: "unchanged_file",
    };
  }
  if (after !== SYNTHETIC_AFTER_UTF8) {
    return {
      verifierId: FABRIC_VERIFIER_ID,
      manifestDigest,
      passed: false,
      pathSummaries: [{
        path: SYNTHETIC_VALUE_PATH,
        kind: "modified",
        beforeDigest,
        afterDigest,
        reason: "wrong_final_bytes",
      }],
      reason: `expected_digest_${expectedDigest}`,
    };
  }
  return {
    verifierId: FABRIC_VERIFIER_ID,
    manifestDigest,
    passed: true,
    pathSummaries: [{
      path: SYNTHETIC_VALUE_PATH,
      kind: "modified",
      beforeDigest,
      afterDigest,
    }],
  };
}
