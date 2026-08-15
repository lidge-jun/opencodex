export type PublicEvidencePurgeFaultForTests =
  | "before_export_delete"
  | "export_directory_sync"
  | null;

let purgeFaultForTests: PublicEvidencePurgeFaultForTests = null;

/** Arms the internal deterministic fault seam and returns a scoped restore handle. */
export function setPublicEvidencePurgeFaultForTests(
  fault: PublicEvidencePurgeFaultForTests,
): () => void {
  const previous = purgeFaultForTests;
  purgeFaultForTests = fault;
  return () => {
    purgeFaultForTests = previous;
  };
}

export function publicEvidencePurgeFaultForTests(): PublicEvidencePurgeFaultForTests {
  return purgeFaultForTests;
}
