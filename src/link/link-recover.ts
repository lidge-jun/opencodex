import { readFileSync } from "node:fs";
import type { LinkRecoveryTarget } from "./operation-recovery-slot";
import { requireRemotePlatform } from "./remote-platform";
import { PURGE_KEPT_IN_USE_MARKER, remoteManagedPurgeDisconnectArgv, remoteRecoverReceiptArgv } from "./remote-plant";
import { MANAGED_PURGE_CHILD_MISSING_MARKER } from "./remote-windows";
import { checkRouteTrust } from "./route-trust";
import { buildExecArgv } from "./ssh-argv";
import type { SshRunner } from "./ssh-runner";

/**
 * ocx link recover's remote step (lane O5): run the managed planted ocx-child's
 * "disconnect --purge --json --expect-link <id>" over the target's alias, with the link known_hosts
 * pinned to the recorded host key. Only the alias is used, never a sibling route, so the command
 * reaches the machine whose key the link confirmed. Cleanup is proven only by the Child's exit 0
 * report that names this link with restored: true and says the planted binary was removed, or was
 * kept with the in-use marker because another home's relay runs from it (the link's own state is
 * clean either way), or, when that report was lost after the purge, by the durable receipt the Child wrote for this link
 * ($OPENCODEX_HOME/link-receipts/<id>.json). Absence of files alone proves nothing. Hints are fixed
 * words: the machine's own text never reaches the caller.
 */
export type LinkRecoverOutcome =
  /** purged false: the Child restored its state for the link but kept the shared planted binary for another home's relay. */
  | { readonly ok: true; readonly purged: boolean }
  | { readonly ok: false; readonly status: number; readonly code: string; readonly message: string; readonly hint?: string };

/** Child exit codes of detach --expect-link (native/ocx-child/src/cli.rs). */
const EXIT_USAGE = 2;
const EXIT_CONFLICT = 5;
const EXIT_RESIDUAL = 6;
const SSH_TRANSPORT_FAILURE = 255;
/** Record names the Child reports; anything else is not echoed. */
const RECORDS = new Set(["codex-home-owner", "child-state", "attach-rollback", "codex-journal", "link-key", "catalog-backup"]);

interface ExpectLinkReport {
  restored?: unknown;
  outcome?: unknown;
  linkId?: unknown;
  purged?: unknown;
  record?: unknown;
}

/** The last JSON object line of the Child's stdout, or null. */
export function parseExpectLinkReport(stdout: string): ExpectLinkReport | null {
  for (const raw of stdout.split(/\r?\n/).reverse()) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as ExpectLinkReport;
    } catch { /* not the report line */ }
  }
  return null;
}

function recordHint(report: ExpectLinkReport | null): string | undefined {
  return typeof report?.record === "string" && RECORDS.has(report.record) ? report.record : undefined;
}

export async function recoverRemoteChild(
  runner: Pick<SshRunner, "run">,
  target: LinkRecoveryTarget,
  knownHostsFile: string,
): Promise<LinkRecoverOutcome> {
  const failed = (message: string, hint: string): LinkRecoverOutcome => ({ ok: false, status: 502, code: "remote_recover_failed", message, hint });
  // With an explicit route (O6) its ProxyCommand, user and port go on the command line; otherwise
  // the alias alone, with the pinned host key either way.
  const route = target.explicitRoute ?? null;
  const exec = (argv: string[]) => runner.run(buildExecArgv({ alias: target.alias, argv, knownHostsFile, route }), { timeoutMs: 30_000 });
  let trusted: string;
  try { trusted = readFileSync(knownHostsFile, "utf8"); } catch { trusted = ""; }
  const trust = checkRouteTrust(trusted, target.alias, target.hostKeyFingerprint);
  if (!trust.ok) {
    return trust.code === "trust_file_unexpected"
      ? { ok: false, status: 409, code: "trust_file_unexpected", message: "The link known_hosts file has a pattern, host-list, marker or malformed line; remove that line, then try again." }
      : { ok: false, status: 409, code: "host_key_changed", message: "The link known_hosts file no longer trusts the host key this link recorded for its alias, so the machine was not contacted." };
  }
  let platform = target.remotePlatform;
  if (!platform) {
    try { platform = await requireRemotePlatform(runner, target.alias, route, knownHostsFile); } catch { return failed("The Child's platform could not be determined, so recovery was not attempted.", "platform_unknown"); }
  }
  let result;
  try { result = await exec(remoteManagedPurgeDisconnectArgv(platform, target.linkId)); } catch { return failed("The Child could not be reached.", "ssh_failed"); }
  const report = parseExpectLinkReport(result.stdout);
  if (result.code === EXIT_RESIDUAL && report?.outcome === "residual") {
    return { ok: false, status: 409, code: "child_residual", message: "The Child keeps state this command does not restore (an ownership record without a link id, state missing beside its record, or an interrupted attach of another link), and nothing was changed. Do not run a plain ocx-child detach on that machine: it would also restore and remove a link an interrupted attach left. When the machine is gone or its cleanup cannot be proven, a person on this Home can run ocx link recover --forget --link-id <id> --yes.", ...(recordHint(report) ? { hint: recordHint(report) } : {}) };
  }
  if (result.code === EXIT_CONFLICT && report?.outcome === "conflict") {
    return { ok: false, status: 409, code: "child_conflict", message: "The Child belongs to another link or OpenCodex home, or its records cannot be read; nothing was changed.", ...(recordHint(report) ? { hint: recordHint(report) } : {}) };
  }
  if (result.code === EXIT_USAGE) {
    return { ok: false, status: 409, code: "child_recover_unsupported", message: "The planted ocx-child predates detach --expect-link, so it cannot check which link it belongs to, and nothing was changed. Do not run its plain detach on that machine: its status cannot show an interrupted attach of another link, which a plain detach would restore and then remove. Leave the machine: recover cannot confirm its cleanup with this build. Once the machine is gone, or a person on that machine has checked and cleaned its ocx-child records by hand, a person on this Home can run ocx link recover --forget --link-id " + target.linkId + " --yes." };
  }
  if (result.code !== 0) {
    if (result.stderr.includes(MANAGED_PURGE_CHILD_MISSING_MARKER)) {
      // A purge whose answer was lost already removed the binary: settle only on the durable receipt
      // of the restore, written before that purge. The missing binary is the purge's own evidence.
      let stored;
      try { stored = await exec(remoteRecoverReceiptArgv(platform, target.linkId)); } catch { return failed("The Child could not be reached.", "ssh_failed"); }
      const receipt = stored.code === 0 ? parseExpectLinkReport(stored.stdout) as (ExpectLinkReport & { schema?: unknown }) | null : null;
      if (!receipt || receipt.schema !== "ocx.child.detach-receipt/1" || receipt.linkId !== target.linkId || receipt.restored !== true) {
        return failed("No planted ocx-child was found in the managed directory and no cleanup receipt for this link exists, so cleanup could not be proven.", "managed_child_missing");
      }
      return { ok: true, purged: true };
    }
    return failed(result.code === SSH_TRANSPORT_FAILURE ? "The Child could not be reached." : "The Child could not be recovered.", result.code === SSH_TRANSPORT_FAILURE ? "ssh_failed" : "child_failed");
  }
  if (report?.restored !== true || report.linkId !== target.linkId) return failed("The Child did not report a cleanup bound to this link.", "receipt_unbound");
  // The link's own state is clean; the binary stays only because another home's relay runs from it,
  // which no repeat would change. That settles the tombstone.
  if (report.purged !== true && result.stderr.includes(PURGE_KEPT_IN_USE_MARKER)) return { ok: true, purged: false };
  if (report.purged !== true) return failed("The Child was cleaned but did not report removing the planted ocx-child binary.", "purge_incomplete");
  return { ok: true, purged: true };
}
