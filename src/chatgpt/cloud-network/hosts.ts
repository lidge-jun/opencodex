import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, fchmodSync, fchownSync } from "node:fs";
import { dirname } from "node:path";
import { CLOUD_HOST, CloudNetworkError } from "./contract";

const TAG = "# OpenCodex cloud network";
export const SYSTEM_CLOUD_MAPPING = `\n${TAG} BEGIN\n127.0.0.1 ${CLOUD_HOST}\n::1 ${CLOUD_HOST}\n${TAG} END\n`;

function containsCloudHost(text: string): boolean {
  return text.split(/\r?\n/).some(line => line.split("#", 1)[0]!.trim().split(/\s+/)
    .slice(1).some(host => host.toLowerCase() === CLOUD_HOST));
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** The privileged caller supplies fixed system paths; tests supply only temporary fixtures. */
export class CloudHostsMapping {
  constructor(private readonly paths: { hosts: string; journal: string }, private readonly flush: () => void) {}

  private readHosts(): string {
    const stat = lstatSync(this.paths.hosts);
    if (!stat.isFile() || stat.nlink !== 1) throw new CloudNetworkError("hosts_not_regular");
    return readFileSync(this.paths.hosts, "utf8");
  }

  private replace(text: string): void {
    const stat = lstatSync(this.paths.hosts);
    const next = `${this.paths.hosts}.opencodex-cloud-next`;
    // Only reached with our durable journal present. A killed rename leaves this owned staging file.
    if (existsSync(next)) {
      const staged = lstatSync(next);
      if (!staged.isFile() || staged.nlink !== 1 || staged.uid !== stat.uid) throw new CloudNetworkError("hosts_staging_conflict");
      unlinkSync(next);
    }
    const fd = openSync(next, "wx", stat.mode & 0o777);
    try {
      fchmodSync(fd, stat.mode & 0o777);
      if (process.getuid?.() === 0) fchownSync(fd, stat.uid, stat.gid);
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(next, this.paths.hosts);
    syncDirectory(dirname(this.paths.hosts));
  }

  recover(): void {
    if (!existsSync(this.paths.journal)) {
      if (this.readHosts().includes(TAG)) throw new CloudNetworkError("mapping_journal_missing");
      return;
    }
    const journal = lstatSync(this.paths.journal);
    if (!journal.isFile() || journal.nlink !== 1 || readFileSync(this.paths.journal, "utf8") !== SYSTEM_CLOUD_MAPPING) {
      throw new CloudNetworkError("mapping_journal_invalid");
    }
    const text = this.readHosts();
    const restored = text.replace(SYSTEM_CLOUD_MAPPING, "");
    if (restored.includes(TAG) || (restored === text && containsCloudHost(text))) throw new CloudNetworkError("mapping_edited");
    if (restored !== text) this.replace(restored);
    // Keep the journal until resolver invalidation succeeds, including after a restart.
    this.flush();
    unlinkSync(this.paths.journal);
    syncDirectory(dirname(this.paths.journal));
  }

  apply(): void {
    this.recover();
    const text = this.readHosts();
    if (containsCloudHost(text)) throw new CloudNetworkError("hostname_already_mapped");
    const fd = openSync(this.paths.journal, "wx", 0o600);
    try { writeFileSync(fd, SYSTEM_CLOUD_MAPPING); fsyncSync(fd); } finally { closeSync(fd); }
    syncDirectory(dirname(this.paths.journal));
    this.replace(text + SYSTEM_CLOUD_MAPPING);
    this.flush();
  }
}
