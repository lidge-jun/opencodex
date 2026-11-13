/** Read-only platform and disconnect guidance for recorded Remote Link Children. */
import { linkKnownHostsPath, linkStorePath } from "../link/paths";
import { requireRemotePlatform, type RemotePlatform } from "../link/remote-platform";
import type { ExplicitRoute } from "../link/explicit-route";
import { createSshRunner, sshRunnerErrorHint, type SshRunner } from "../link/ssh-runner";
import { readLinkStore, type LinkStore } from "../link/store";
import { CliUsageError, printData, rejectArgs, takeJsonFlag, takeOption } from "./runtime-api";

const LINK_ID = /^lnk_[0-9a-f]{16}$/;

export interface LinkCleanupDeps {
  readStore?: () => LinkStore;
  sshRunner?: SshRunner;
  knownHostsFile?: string;
}

export interface LinkCleanupEntry {
  linkId: string;
  alias: string;
  direction: LinkStore["links"][number]["direction"];
  platform: RemotePlatform | "not_checked";
  reason: string | null;
  recovery: string[];
}

export function windowsChildRecovery(linkId: string, alias: string): string[] {
  return [
    // The bound disconnect (#8662) acts only while the machine is connected to this link; an older ocx refuses the flag before it
    // acts on the link, and then the check comes first. The revoke runs as printed: --yes belongs to --force, which skips cleanup.
    `On ${alias}, run 'ocx disconnect --expect-link ${linkId}' and, if it disconnected, 'ocx restart': it disconnects only while the machine is connected to this link. An OpenCodex older than that flag refuses it as a usage error before it acts on the link; then run 'ocx disconnect' and 'ocx restart' only if 'ocx connect status --json' shows this link's id, right after that check. If it shows another link, a hub or another Home, or its state cannot be read, leave it.`,
    `On this Home, run 'ocx link revoke --link-id ${linkId}' to disconnect it through the recorded SSH trust; it disconnects only while the machine is connected to this link.`,
    `Retry Remote Link enrollment after updating Home if the remote shell or old installation cannot run the disconnect command.`,
  ];
}

async function checkPlatform(runner: SshRunner, alias: string, route: ExplicitRoute | null, knownHostsFile: string): Promise<{ platform: RemotePlatform; reason: string | null }> {
  try {
    const platform = await requireRemotePlatform(runner, alias, route, knownHostsFile);
    return { platform, reason: null };
  } catch (error) {
    return { platform: "unknown", reason: sshRunnerErrorHint(error) ?? "ssh could not run" };
  }
}

function humanLines(entries: LinkCleanupEntry[]): string[] {
  if (entries.length === 0) return ["No links are recorded on this Home.", "Nothing was revoked or changed."];
  const lines: string[] = [];
  for (const entry of entries) {
    const label = `${entry.linkId} (${entry.alias})`;
    if (entry.platform === "windows") {
      lines.push(`${label}: Windows Child. Current Home releases support Remote Link over PowerShell; this report changes nothing.`);
      for (const [index, step] of entry.recovery.entries()) lines.push(`  ${index + 1}. ${step}`);
    } else if (entry.platform === "posix") lines.push(`${label}: macOS or Linux Child; nothing to clean up.`);
    else if (entry.platform === "not_checked") lines.push(`${label}: Child-initiated; this Home has no SSH route to check it.`);
    else lines.push(`${label}: platform could not be checked (${entry.reason ?? "unknown"}); retry when it is reachable.`);
  }
  lines.push("Nothing was revoked or changed.");
  return lines;
}

export async function runLinkCleanup(args: string[], deps: LinkCleanupDeps, usage: string): Promise<void> {
  const wantsJson = takeJsonFlag(args);
  const linkId = takeOption(args, "--link-id");
  if (linkId !== undefined && !LINK_ID.test(linkId)) throw new CliUsageError("cleanup --link-id must be a valid link id", usage);
  rejectArgs(args, usage);
  const store = (deps.readStore ?? (() => readLinkStore(linkStorePath())))();
  const records = linkId === undefined ? store.links : store.links.filter(link => link.id === linkId);
  if (linkId !== undefined && records.length === 0) throw new CliUsageError(`No link ${linkId} is recorded on this Home.`, usage);
  const runner = deps.sshRunner ?? createSshRunner();
  const knownHostsFile = deps.knownHostsFile ?? linkKnownHostsPath();
  const entries: LinkCleanupEntry[] = [];
  // One at a time: each check is a bounded SSH command, and order keeps the report stable.
  for (const record of records) {
    const checked = record.direction === "hub-initiated"
      ? await checkPlatform(runner, record.alias, record.explicitRoute ?? null, knownHostsFile)
      : { platform: "not_checked" as const, reason: null };
    entries.push({
      linkId: record.id, alias: record.alias, direction: record.direction, ...checked,
      recovery: checked.platform === "windows" ? windowsChildRecovery(record.id, record.alias) : [],
    });
  }
  printData({ links: entries, changed: false }, wantsJson, humanLines(entries));
}
