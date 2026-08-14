export type PublicEvidencePurgeFaultForTests =
  | "before_export_delete"
  | "export_directory_sync"
  | null;

let purgeFaultForTests: PublicEvidencePurgeFaultForTests = null;

/** Internal deterministic fault seam. This module is intentionally not barrel-exported. */
export function setPublicEvidencePurgeFaultForTests(
  fault: PublicEvidencePurgeFaultForTests,
): void {
  purgeFaultForTests = fault;
}

export function publicEvidencePurgeFaultForTests(): PublicEvidencePurgeFaultForTests {
  return purgeFaultForTests;
}
