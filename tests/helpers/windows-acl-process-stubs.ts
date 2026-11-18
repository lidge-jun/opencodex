/**
 * Child-process prelude for route-intent scenarios, whose subject is client materialization, not NTFS ACLs.
 *
 * On Windows every client lifecycle lock acquisition re-verifies the lock directory with a PowerShell
 * ACL read and re-hardens the lock file with icacls: the directory proof deliberately carries no memo,
 * and the file memo is keyed on ctime, which every write in that directory moves. A route-intent apply
 * takes that lock once per integration client, so a connect, two syncs and a disconnect come to a few
 * hundred acquisitions and several hundred real processes. On the hosted Windows runner that put one
 * scenario at 25-40s against its 40s spawn budget, with no difference in outcome.
 *
 * Import it FIRST in the --eval source (import './tests/helpers/windows-acl-process-stubs';), before any
 * module that may consult the principal or harden a path while loading. The OS then reports the private
 * ACL a completed harden leaves, for a synthetic principal, and no ACL process is launched. ACL policy
 * has its own coverage in tests/windows/. On POSIX every seam below is inert.
 */
import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import {
  setWindowsOwnerAclAsyncRunnerForTests,
  setWindowsOwnerAclRunnerForTests,
  type WindowsPrivateEntry,
} from "../../src/lib/windows-owner-acl";
import { setSyntheticWindowsPrincipalForTests } from "../../src/lib/windows-user-principal";

const PRINCIPAL_SID = "S-1-5-21-1-2-3-1001";
const ICACLS_OK = { success: true, exitCode: 0, timedOut: false, stdout: "" };

/** A protected DACL owned by the principal and granting it Full Control: what a completed harden leaves. */
function privateAcl(entries: readonly WindowsPrivateEntry[]) {
  const stdout = [
    `U|${PRINCIPAL_SID}|${PRINCIPAL_SID}|False`,
    ...entries.flatMap((entry, index) => [
      `E|${index}|${PRINCIPAL_SID}|4100|1`,
      `A|${index}|0|${entry.directory ? 3 : 0}|2032127|${PRINCIPAL_SID}|False`,
    ]),
    "END", "",
  ].join("\n");
  return { success: true, timedOut: false, stdout };
}

setSyntheticWindowsPrincipalForTests(`*${PRINCIPAL_SID}`);
setIcaclsRunnerForTests(() => ICACLS_OK);
setAsyncIcaclsRunnerForTests(async () => ICACLS_OK);
setWindowsOwnerAclRunnerForTests(privateAcl);
setWindowsOwnerAclAsyncRunnerForTests(async entries => privateAcl(entries));
