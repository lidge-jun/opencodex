import { chmodSync, lstatSync, mkdirSync } from "node:fs";
import { assertNotRealHomeUnderTest } from "../lib/test-home-guard";
import { hardenSecretDir, hardenSecretPath } from "../lib/windows-secret-acl";

export interface WorkspaceSecretPermissions {
  prepareDirectory(path: string): void;
  hardenFile(path: string): void;
}

/** Only ENOENT means first-run absence; permission failures must not reset identity. */
export function workspaceSecretFileExists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export const workspaceSecretPermissions: WorkspaceSecretPermissions = {
  prepareDirectory(path) {
    assertNotRealHomeUnderTest(path);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("remote workspace secret directory must be a real directory");
    }
    if (process.platform === "win32") hardenSecretDir(path, { required: true });
    else chmodSync(path, 0o700);
  },
  hardenFile(path) {
    assertNotRealHomeUnderTest(path);
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
      throw new Error("remote workspace secret must be a private regular file");
    }
    if (process.platform === "win32") hardenSecretPath(path, { required: true });
    else chmodSync(path, 0o600);
  },
};
