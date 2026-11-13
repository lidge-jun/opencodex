import { setAsyncIcaclsRunnerForTests, setIcaclsRunnerForTests } from "../../src/lib/windows-secret-acl";
import { setAsyncWindowsPrincipalRunnerForTests, setWindowsPrincipalRunnerForTests } from "../../src/lib/windows-user-principal";

/** Route-intent fixtures test client state, not the Windows ACL subprocesses. */
export function installRouteIntentAclFixture(): void {
  const ok = { success: true, exitCode: 0, timedOut: false, stdout: "" };
  setIcaclsRunnerForTests(() => ok);
  setAsyncIcaclsRunnerForTests(async () => ok);
  const identity = { ...ok, stdout: "S-1-5-21-1-2-3-1001\nfixture\\account" };
  setWindowsPrincipalRunnerForTests(() => identity);
  setAsyncWindowsPrincipalRunnerForTests(async () => identity);
}
