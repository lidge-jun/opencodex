import { createCodexCliTestRoot } from "./codex-cli-fixture-root";

/** Recovery publication uses the updater's canonical mutation-path contract. */
export function createCodexCliRecoveryTestHome(): string {
  // macOS TMPDIR commonly begins with /var, an alias of /private/var.
  return createCodexCliTestRoot("ocx-recovery-home-");
}
