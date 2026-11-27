import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardenSecretDir, hardenSecretPath } from "../../src/lib/windows-secret-acl";
import { resolveTrustedWindowsIcaclsExe } from "../../src/lib/windows-elevation";
import { verifyWindowsPrivateEntries } from "../../src/lib/windows-owner-acl";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { SPAWN_BUDGET_MS } from "../helpers/test-budget";

test.skipIf(process.platform !== "win32")("batched restrictions produce private native file and directory descriptors", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-native-batched-acl-"));
  const previous = process.env.OPENCODEX_ACL_BATCH_RESTRICTIONS;
  try {
    // Keep the parent private before adding a test grant to either empty fixture.
    expect(hardenSecretDir(root, { required: true }).ok).toBe(true);
    expect(verifyWindowsPrivateEntries([{ path: root, directory: true }], 5_000)).toBe(true);
    const folder = join(root, "sample-dir");
    const file = join(root, "sample-file");
    mkdirSync(folder);
    writeFileSync(file, "");
    const entries = [{ path: folder, directory: true }, { path: file, directory: false }];
    process.env.OPENCODEX_ACL_BATCH_RESTRICTIONS = "1";
    for (const entry of entries) {
      const fixture = Bun.spawnSync([resolveTrustedWindowsIcaclsExe(), entry.path, "/grant:r", "*S-1-5-32-545:R"], {
        stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true, timeout: 5_000,
      });
      expect(fixture.success).toBe(true);
    }
    expect(verifyWindowsPrivateEntries(entries, 5_000)).toBe(false);
    for (const entry of entries) {
      const harden = entry.directory ? hardenSecretDir : hardenSecretPath;
      expect(harden(entry.path, { required: true }).ok).toBe(true);
    }
    expect(verifyWindowsPrivateEntries(entries, 5_000)).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.OPENCODEX_ACL_BATCH_RESTRICTIONS;
    else process.env.OPENCODEX_ACL_BATCH_RESTRICTIONS = previous;
    removeTreeWithRetry(root);
  }
}, SPAWN_BUDGET_MS);
