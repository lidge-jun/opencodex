/**
 * The non-mutating Grok inspector (WP2, devlog 260803_integrations_toggle_all/012).
 *
 * Exists because GET /api/native-integrations must not write, and the only code
 * that could answer "would a disable be refused?" used to be `stripGrokConfig`,
 * which writes. This reads, never writes, and shares `findManagedRegion` with
 * the writer so the two can never disagree about where our block starts and
 * stops — two parsers for one fence is how a strip eventually removes the
 * wrong bytes.
 *
 * It deliberately does NOT parse the block's contents (that is `status.ts`,
 * for the dashboard's model list). This answers exactly one question: what
 * state is the fence in?
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findManagedRegion, isDirectory, resolveGrokHome } from "./inject";

export type GrokInspection =
  /** No fence, or no config file. */
  | { kind: "absent" }
  /** A well-formed fence we own. */
  | { kind: "present" }
  /** No GROK_HOME at all. */
  | { kind: "not_installed" }
  /** Begin marker without an end marker — a disable would refuse. */
  | { kind: "orphaned_marker" };

export function inspectGrokConfig(opts: { grokHome?: string } = {}): GrokInspection {
  const grokHome = resolveGrokHome(opts.grokHome);
  if (!isDirectory(grokHome)) return { kind: "not_installed" };
  const configPath = join(grokHome, "config.toml");
  if (!existsSync(configPath)) return { kind: "absent" };
  let content: string;
  try {
    content = readFileSync(configPath, "utf8");
  } catch {
    // Unreadable is indistinguishable from absent for a READ-ONLY answer; the
    // writer's own error path reports a genuine IO failure when it matters.
    return { kind: "absent" };
  }
  const region = findManagedRegion(content);
  if (!region) return { kind: "absent" };
  return region.orphaned ? { kind: "orphaned_marker" } : { kind: "present" };
}
