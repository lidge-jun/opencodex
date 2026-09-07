import {
  closeSync, fchmodSync, fstatSync, linkSync, lstatSync,
  openSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { forgetEphemeralSecretPath, hardenSecretPath } from "../lib/windows-secret-acl";
import { isMissingPathError, nextAtomicTempSequence } from "./atomic-write";

type PublicationState = "not-published" | "published" | "uncertain";

/** Messages contain no candidate bytes or raw filesystem error text. */
export class InitialConfigPublicationError extends Error {
  constructor(
    readonly publication: PublicationState,
    readonly residualTemp: boolean,
    readonly hardLinkUnavailable: boolean,
    options?: ErrorOptions & { hardeningFailed?: boolean },
  ) {
    super(options?.hardeningFailed
      ? "Initial config permissions could not be secured. Choose an OPENCODEX_HOME location that supports private file permissions (NTFS ACLs on Windows), then rerun `ocx init`."
      : hardLinkUnavailable
      ? "Initial config requires hard-link publication; the filesystem or its permissions denied it. Inspect the config directory before retrying. Choose an OPENCODEX_HOME location that supports hard links and private file permissions, then rerun `ocx init`."
      : "Initial config publication did not finish.", options);
    this.name = "InitialConfigPublicationError";
  }
}

/** Narrow fault boundary; publication must be a single link operation. */
export interface InitialConfigPublicationIO {
  harden(fd: number, temp: string, target: string): void;
  write(fd: number, bytes: string): void;
  link(temp: string, target: string): void;
  unlink(temp: string): void;
  close(fd: number): void;
}

function hardenInitialConfig(fd: number, temp: string, target: string): void {
  if (process.platform === "win32") {
    hardenSecretPath(temp, { required: true, timeoutMemoKey: target });
  } else {
    fchmodSync(fd, 0o600);
  }
}

function identifiesDescriptor(fd: number, path: string): boolean {
  const opened = fstatSync(fd);
  const entry = lstatSync(path);
  return opened.isFile() && entry.isFile()
    && opened.dev === entry.dev && opened.ino === entry.ino;
}

function verifyPrivateTemp(fd: number, temp: string): void {
  if (!identifiesDescriptor(fd, temp)
    || (process.platform !== "win32" && (fstatSync(fd).mode & 0o777) !== 0o600)) {
    throw new Error("Initial config temporary file identity or permissions changed.");
  }
}

function removeOwnedTemp(fd: number, temp: string, unlink: (path: string) => void): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (!identifiesDescriptor(fd, temp)) return false;
      unlink(temp);
      forgetEphemeralSecretPath(temp);
      return true;
    } catch (error) {
      if (isMissingPathError(error)) {
        forgetEphemeralSecretPath(temp);
        return true;
      }
    }
  }
  return false;
}

/**
 * Publish complete bytes without replacing any entry at target. Never truncate:
 * even an error from link can mean a remote filesystem already published the inode.
 * Cleanup removes only our temporary name, never the target or another inode.
 */
export function publishInitialConfigNoReplace(
  target: string,
  bytes: string,
  io: Partial<InitialConfigPublicationIO> = {},
): boolean {
  assertNotRealHomeUnderTest(dirname(target));
  const temp = `${target}.ocx.${process.pid}.${nextAtomicTempSequence()}.tmp`;
  let fd: number | undefined;
  let publication: PublicationState = "not-published";
  let collided = false;
  let failure: unknown;
  let failed = false;
  let hardLinkUnavailable = false;
  let hardeningFailed = false;
  let residualTemp = false;
  try {
    fd = openSync(temp, "wx", 0o600);
    hardeningFailed = true;
    (io.harden ?? hardenInitialConfig)(fd, temp, target);
    hardeningFailed = false;
    verifyPrivateTemp(fd, temp);
    (io.write ?? ((descriptor: number, value: string) => writeFileSync(descriptor, value, { encoding: "utf8" })))(fd, bytes);
    verifyPrivateTemp(fd, temp);
    try {
      publication = "uncertain";
      (io.link ?? linkSync)(temp, target);
      publication = "published";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      // EEXIST normally means a competitor won. A shared target means our
      // publication may nevertheless have happened (e.g. a remote FS retry).
      if (code === "EEXIST" && !identifiesDescriptor(fd, target)) collided = true;
      else {
        hardLinkUnavailable = ["EOPNOTSUPP", "ENOTSUP", "ENOSYS", "EXDEV", "EPERM"].includes(code ?? "");
        throw error;
      }
    }
    if (!collided && !identifiesDescriptor(fd, target)) {
      throw new Error("Initial config published target identity changed.");
    }
  } catch (error) {
    failed = true;
    failure = error;
  } finally {
    if (fd !== undefined) {
      // Unlink-only cleanup preserves all bytes if another name shares this inode.
      residualTemp = !removeOwnedTemp(fd, temp, io.unlink ?? unlinkSync);
      try { (io.close ?? closeSync)(fd); }
      catch (error) { if (!failed) failure = error; failed = true; }
    }
  }
  if (failed || residualTemp) {
    throw new InitialConfigPublicationError(publication, residualTemp, hardLinkUnavailable, { cause: failure, hardeningFailed });
  }
  return !collided;
}
