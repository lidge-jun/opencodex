import { spyOn } from "bun:test";
import { relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import * as acl from "../../src/lib/windows-owner-acl";

const roots = new Set<string>();
const verify = acl.verifyWindowsEntriesAclAsync;
let installed = false;
/** Inject only the ancestry ABOVE an explicitly hardened OS-temp fixture.
 * Native pins and all ACL policies at/below the fixture remain production checks.
 * Never changes the host TEMP/profile ACLs or approves an untrusted fixture leaf.
 */
export function trustWindowsTempFixtureAncestry(root: string): void {
  const path = resolve(root), within = relative(resolve(tmpdir()), path);
  if (!within || within.startsWith("..") || within.includes(":")) throw new Error("fixture_outside_os_temp");
  roots.add(path);
  if (installed) return;
  installed = true;
  spyOn(acl, "verifyWindowsEntriesAclAsync").mockImplementation((entries, timeout) => {
    const anchor = [...roots].find(candidate => entries.some(entry =>
      resolve(entry.path).toLowerCase() === candidate.toLowerCase()
      || resolve(entry.path).toLowerCase().startsWith(candidate.toLowerCase() + sep)));
    return verify(entries.map(entry => anchor && entry.policy === "trusted-ancestry"
      && (anchor + sep).toLowerCase().startsWith((resolve(entry.path) + sep).toLowerCase())
      ? { ...entry, path: anchor } : entry), timeout);
  });
}
