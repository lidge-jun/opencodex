import { spyOn } from "bun:test";
import { dirname, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import * as acl from "../../src/lib/windows-owner-acl";

const roots = new Map<string, string>();
const verify = acl.verifyWindowsEntriesAclAsync;
// Update-store ACL tools accept extended DOS names; fixture matching stays on
// canonical DOS ancestry. This does not resolve a junction or an 8.3 alias.
const fixturePath = (path: string) => resolve(path.startsWith("\\\\?\\") ? path.slice(4) : path);
let installed = false;
/** Inject only the ancestry ABOVE an explicitly hardened OS-temp fixture.
 * Native pins and all ACL policies at/below the fixture remain production checks.
 * Never changes the host TEMP/profile ACLs or approves an untrusted fixture leaf.
 */
export function trustWindowsTempFixtureAncestry(root: string, temporaryRoot = tmpdir()): void {
  const path = realpathSync.native(root), within = relative(realpathSync.native(temporaryRoot), path);
  if (!within || within.startsWith("..") || within.includes(":")) throw new Error("fixture_outside_os_temp");
  roots.set(path.toLowerCase(), path);
  if (installed) return;
  installed = true;
  const mapped = (entries: readonly acl.WindowsAclEntry[]) => {
    // Find by bounded ancestry, rather than rescanning every old fixture against
    // an entire npm tree on every ACL batch in a long multi-file test process.
    let anchor: string | undefined;
    for (const entry of entries) {
      let current = fixturePath(entry.path);
      for (;;) {
        anchor = roots.get(current.toLowerCase()); if (anchor) break;
        const parent = dirname(current); if (parent === current) break; current = parent;
      }
      if (anchor) break;
    }
    return entries.map(entry => anchor && entry.policy === "trusted-ancestry"
      && (anchor + sep).toLowerCase().startsWith((fixturePath(entry.path) + sep).toLowerCase())
      ? { ...entry, path: anchor } : entry);
  };
  spyOn(acl, "verifyWindowsEntriesAclAsync").mockImplementation((entries, timeout) => verify(mapped(entries), timeout));
}
