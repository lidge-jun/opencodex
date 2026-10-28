import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_NAMESPACE_MARKER = ".ocx-fixture-namespace-owner";

// Call only for a fresh fixture root owned by the caller, never a user directory.
export function createFixtureNamespaceOwner(root: string) {
  const nonce = randomUUID();
  writeFileSync(join(root, FIXTURE_NAMESPACE_MARKER), nonce, { flag: "wx", mode: 0o600 });
  return { OCX_FIXTURE_NAMESPACE_ROOT: root, OCX_FIXTURE_NAMESPACE_NONCE: nonce };
}
