import { mkdirSync, readdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A short, fail-fast bakery reservation around lock-file acquisition/takeover.
 * Each participant owns a unique filename; dead reservations are removed by
 * that name, never by renaming a reusable path that a successor might own.
 * Register choosing before reading ticket numbers, then publish and inspect
 * peers again. A later participant sees our ticket and cannot enter ahead of
 * it. A peer still choosing makes this attempt back off rather than wait.
 */
export function withLockClaim<T>(
  path: string,
  token: string,
  isAlive: (pid: number) => boolean,
  run: () => T,
): { ok: true; value: T } | { ok: false } {
  const directory = `${path}.claims`;
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const ownName = `${process.pid}-${token}.claim`;
  const ownPath = join(directory, ownName);
  const peers = (): Array<{ name: string; ticket: number }> => {
    const result: Array<{ name: string; ticket: number }> = [];
    for (const name of readdirSync(directory)) {
      if (name === ownName) continue;
      const match = /^([1-9][0-9]*)-[0-9a-f]{16}\.claim$/.exec(name);
      if (!match) throw new Error("unrecognized lock reservation");
      const peerPath = join(directory, name);
      if (!isAlive(Number(match[1]))) {
        try { unlinkSync(peerPath); } catch { /* Already released; unique path. */ }
        continue;
      }
      let ticket = 0;
      try {
        const parsed: unknown = JSON.parse(readFileSync(peerPath, "utf8"));
        if (typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 0) ticket = parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        // A live process may have created/truncated its reservation but not
        // finished the write. It is choosing; never delete its reservation.
      }
      result.push({ name, ticket });
    }
    return result;
  };
  try {
    writeFileSync(ownPath, "0", { mode: 0o600, flag: "wx" });
    let ticket = 1;
    for (const peer of peers()) ticket = Math.max(ticket, peer.ticket + 1);
    if (!Number.isSafeInteger(ticket)) return { ok: false };
    writeFileSync(ownPath, String(ticket));
    for (const peer of peers()) {
      if (peer.ticket === 0 || peer.ticket < ticket || (peer.ticket === ticket && peer.name < ownName)) {
        return { ok: false };
      }
    }
    return { ok: true, value: run() };
  } catch (error) {
    // A missing/replaced reservation directory or corrupt live reservation
    // cannot establish mutual exclusion. Preserve the lock and refuse.
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as Error).message === "unrecognized lock reservation") {
      return { ok: false };
    }
    throw error;
  } finally {
    try { unlinkSync(ownPath); } catch { /* Only our unique reservation. */ }
    // rmdir is atomic and succeeds only when empty: a registered participant
    // always has its file present, so its namespace cannot be removed. A peer
    // between mkdir and registration gets ENOENT and safely retries instead.
    try { rmdirSync(directory); } catch { /* Still reserved by a peer. */ }
  }
}
