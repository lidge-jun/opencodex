import type { FabricPatchExecutorInput, SyntheticPatchV1 } from "../../../src/lab/fabric/types";
import { SYNTHETIC_AFTER_UTF8, SYNTHETIC_VALUE_PATH } from "../../../src/lab/fabric/constants";

export async function execute(_input: FabricPatchExecutorInput): Promise<SyntheticPatchV1> {
  return {
    schemaVersion: 1,
    operations: [{ op: "replace", path: SYNTHETIC_VALUE_PATH, contentUtf8: SYNTHETIC_AFTER_UTF8 }],
  };
}
