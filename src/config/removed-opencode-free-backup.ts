import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { atomicWriteFileNoFollow } from "./atomic-write";
import { isPassiveRead } from "../lib/passive-read";
import { redactUserPath } from "../lib/redact";
import { sanitizeRemovedOpenCodeFreeForLoad } from "./removed-opencode-free";
import { verifySecretPathAcl, windowsSecretAclApplies } from "../lib/windows-secret-acl";

let warned = false;

/** Inspect occupants without following links or modifying their permissions. */
function holdsOriginal(path: string, original: Uint8Array, retries = 3): boolean {
  let descriptor: number | undefined;
  try {
    const entry = lstatSync(path, { bigint: true });
    if (!entry.isFile() || entry.dev === 0n || entry.ino === 0n) return false;
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) return false;
    const bytes = readFileSync(descriptor);
    if (!bytes.equals(Buffer.from(original))) return false;
    if (opened.nlink > 1n) {
      // Exclusive publication briefly links its private temp to the final name.
      // Recheck briefly to reuse a prompt publisher's copy; a delayed publisher
      // may leave multiple exact, protected copies. Never certify a linked file.
      if (retries === 0) return false;
      closeSync(descriptor);
      descriptor = undefined;
      Bun.sleepSync(10);
      return holdsOriginal(path, original, retries - 1);
    }
    const protectedFile = windowsSecretAclApplies()
      ? verifySecretPathAcl(path)
      : (opened.mode & 0o7777n) === 0o600n && typeof process.getuid === "function" && opened.uid === BigInt(process.getuid());
    if (!protectedFile) return false;
    const final = fstatSync(descriptor, { bigint: true });
    const after = lstatSync(path, { bigint: true });
    return final.nlink === 1n && final.ctimeNs === opened.ctimeNs
      && after.isFile() && after.nlink === 1n && after.dev === opened.dev && after.ino === opened.ino
      && after.ctimeNs === opened.ctimeNs;
  } catch { return false; }
  finally { if (descriptor !== undefined) { try { closeSync(descriptor); } catch { /* optional read only */ } } }
}

/** Keep each distinct disk original without overwriting an unrelated or older copy. */
function backupOriginal(configPath: string, rawBytes: Uint8Array): string | null {
  const stem = `${configPath}.pre-opencode-free-removal`;
  // A prior occupied-name read may already have preserved this exact snapshot.
  try {
    for (const name of readdirSync(dirname(configPath))) {
      if (name.startsWith(`${basename(stem)}.`) && name.endsWith(".bak")) {
        const existing = join(dirname(configPath), name);
        if (holdsOriginal(existing, rawBytes)) return existing;
      }
    }
  } catch { /* publication below reports unreadable/unwritable homes */ }
  const stamp = Date.now();
  for (let n = 0; n < 100; n++) {
    const backup = n === 0 ? `${stem}.bak` : `${stem}.${stamp}${n === 1 ? "" : `-${n}`}.bak`;
    if (holdsOriginal(backup, rawBytes)) return backup;
    let published = false;
    try {
      atomicWriteFileNoFollow(backup, rawBytes, undefined, { afterRename: () => { published = true; } }, { exclusive: true });
      return backup;
    } catch (error) {
      if (published) {
        console.warn("Could not remove an OpenCode Free recovery temporary file.");
        return backup;
      }
      if (holdsOriginal(backup, rawBytes)) return backup;
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
        continue;
      }
      // A directory occupant can report EACCES on Windows instead of EEXIST.
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EACCES" && code !== "EPERM") break;
      try { if (!lstatSync(backup).isDirectory()) break; } catch { break; }
    }
  }
  console.warn("Could not preserve the original config before OpenCode Free removal; no recovery copy was made. Copy config.json now.");
  return null;
}

/** Disk-load boundary only; imported text and passive reads never publish or notify. */
export function preserveRemovedOpenCodeFree(configPath: string, rawBytes: Uint8Array): void {
  if (isPassiveRead()) return;
  const backup = backupOriginal(configPath, rawBytes);
  if (warned) return;
  warned = true;
  const recovery = backup
    ? `the original file was saved to ${redactUserPath(backup)} (restore by copying it back over config.json, for example after downgrading).`
    : "no recovery copy was made; copy config.json now if you need the old entry.";
  console.warn(`opencode-free support was removed because every free model now returns 403 permission_denied under OpenCode's upstream free-tier gate (#7255); the entry and dependent references are disabled. The next configuration save removes them from config.json; ${recovery} Use opencode-go, or another provider such as opencode-zen or openrouter.`);
}

/** One snapshot boundary for the loader, diagnostics and authoritative live-save read. */
export function projectRemovedOpenCodeFreeSnapshot(parsed: unknown, file?: { path: string; bytes: Uint8Array }): void {
  if (sanitizeRemovedOpenCodeFreeForLoad(parsed) && file) preserveRemovedOpenCodeFree(file.path, file.bytes);
}
