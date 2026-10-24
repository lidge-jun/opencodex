/**
 * `ocx sync --expect-link <linkId>` / `--expect-hub-key <apiKeyId>` (#7694): argument parsing and
 * the refusal report. The check itself runs under the client locks in
 * `src/client/sync-expectation.ts`; this module only turns argv into an expectation and a
 * mismatch into the documented exit code and stderr lines.
 */
import type { ClientSyncExpectation } from "../client/sync-expectation";

/** Exit code of a refused expectation: the machine is not in the state the caller named. */
export const SYNC_EXPECTATION_MISMATCH_EXIT = 5;
export const SYNC_EXPECTATION_USAGE_EXIT = 2;

const LINK_ID = /^lnk_[0-9a-f]{16}$/;
const FLAGS = ["--expect-link", "--expect-hub-key"] as const;

export type ParsedSyncExpectation =
  | { ok: true; expectation?: ClientSyncExpectation }
  | { ok: false; message: string };

/** Reads both flags in `--flag value` or `--flag=value` form; any doubt is a usage error. */
export function parseSyncExpectation(args: readonly string[]): ParsedSyncExpectation {
  const found: { flag: typeof FLAGS[number]; value: string | undefined }[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    for (const flag of FLAGS) {
      if (arg === flag) {
        const next = args[index + 1];
        found.push({ flag, value: next === undefined || next.startsWith("--") ? undefined : next });
        if (next !== undefined && !next.startsWith("--")) index += 1;
      } else if (arg.startsWith(`${flag}=`)) {
        found.push({ flag, value: arg.slice(flag.length + 1) });
      }
    }
  }
  if (found.length === 0) return { ok: true };
  if (found.length > 1) {
    return { ok: false, message: "ocx sync accepts one --expect-link or --expect-hub-key, given once." };
  }
  const [{ flag, value }] = found as [typeof found[number]];
  if (flag === "--expect-link") {
    if (value === undefined || !LINK_ID.test(value)) {
      return { ok: false, message: "--expect-link needs a link id of the form lnk_ followed by 16 hex digits (see ocx connect status --json)." };
    }
    return { ok: true, expectation: { kind: "link", linkId: value } };
  }
  if (value === undefined || value.trim() === "" || value.trim() !== value || value.length > 256) {
    return { ok: false, message: "--expect-hub-key needs the connected API key id (see ocx connect status --json)." };
  }
  return { ok: true, expectation: { kind: "hub", apiKeyId: value } };
}

/** A refusal prints one human line, then one JSON line a caller can parse as the last stderr line. */
export function reportSyncExpectationMismatch(
  error: { phase: string; reason: string },
  log: Pick<Console, "error">,
): number {
  log.error(`Sync refused (${error.phase}: ${error.reason}); nothing was changed and local providers were not synced.`);
  log.error(JSON.stringify({ phase: error.phase, reason: error.reason }));
  return SYNC_EXPECTATION_MISMATCH_EXIT;
}
