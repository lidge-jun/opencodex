import { closeSync, constants, fstatSync, openSync, readSync, statSync, type BigIntStats } from "node:fs";
import { sameFileIdentity } from "../../lib/file-identity";

const MAX_CODEX_CONFIG_BYTES = 1024 * 1024;

/**
 * Read config.toml the way Codex and the injector resolve it — a symlink's target IS the
 * config — without blocking on a special file or buffering without bound.
 *
 * `null` means only "absent at the initial lookup". A path that vanishes or is swapped
 * underneath the read throws the changed-file error instead, because the observation is
 * then undetermined rather than negative: the caller must not report a config the probe
 * watched disappear as simply not there.
 */
export function readBoundedCodexConfig(path: string): string | null {
  let fd: number | undefined;
  try {
    let namedBefore: BigIntStats;
    try {
      namedBefore = statSync(path, { bigint: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    }
    if (!namedBefore.isFile() || namedBefore.size > BigInt(MAX_CODEX_CONFIG_BYTES)) {
      throw new Error("config.toml is not a bounded regular file");
    }
    // Deliberately no O_NOFOLLOW: Codex and the injector read through a symlinked
    // config.toml, so refusing the link here would disagree with the writes this probe
    // stands in front of. O_NONBLOCK is what keeps a FIFO — linked or direct — from
    // stalling the open; the descriptor checks below still reject anything non-regular.
    const guardedFlags = process.platform === "win32"
      ? 0
      : (constants.O_NONBLOCK ?? 0);
    fd = openSync(path, constants.O_RDONLY | guardedFlags);
    const before = fstatSync(fd, { bigint: true });
    if (!sameFileIdentity(before, namedBefore)) {
      throw new Error("config.toml changed while it was read");
    }
    if (!before.isFile() || before.size > BigInt(MAX_CODEX_CONFIG_BYTES)) {
      throw new Error("config.toml is not a bounded regular file");
    }

    const buffer = Buffer.allocUnsafe(Number(before.size) + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readSync(fd, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const namedAfter = statSync(path, { bigint: true });
    if (BigInt(bytesRead) !== before.size || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
      || !namedAfter.isFile()
      || !sameFileIdentity(namedAfter, before)) {
      throw new Error("config.toml changed while it was read");
    }
    return buffer.toString("utf8", 0, bytesRead);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error("config.toml changed while it was read");
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
