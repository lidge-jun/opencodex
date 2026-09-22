/** Registry source-metadata consistency, not cryptographic provenance verification. */
export function assertResumeSourceMetadata(raw: string, expectedSha: string): void {
  if (!/^[a-f0-9]{40}$/.test(expectedSha)) throw new Error("Invalid audited release SHA");
  if (raw.length > 1024) throw new Error("Registry gitHead response exceeds the scalar bound");
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("Registry gitHead is not valid JSON"); }
  if (typeof value !== "string" || !/^[a-fA-F0-9]{40}$/.test(value) || value !== expectedSha) {
    throw new Error("Registry gitHead does not match the audited release SHA");
  }
}

if (import.meta.main) {
  try {
    assertResumeSourceMetadata(process.argv[3] ?? "", process.argv[2] ?? "");
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release resume identity could not be verified");
    process.exitCode = 1;
  }
}
