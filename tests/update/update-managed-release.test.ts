import { expect, test } from "bun:test";
import { checkForUpdate, managedReleaseDirectory } from "../../src/update/job";

test("a managed release directory shows the npm latest, no git-pull hint and no manual update", () => {
  const result = checkForUpdate("latest", {
    currentVersion: () => "2.95.0",
    detectInstall: () => "source",
    latestVersion: () => "2.96.0",
    managedReleaseDirectory: () => true,
  });
  expect(result.latestVersion).toBe("2.96.0");
  expect(result.updateAvailable).toBe(true);
  expect(result.canUpdate).toBe(false);
  expect(result.reason).toBe("managed_release");
  expect(result.command).toBe("");
});

test("a plain source checkout keeps the git pull hint", () => {
  const result = checkForUpdate("latest", {
    currentVersion: () => "2.95.0",
    detectInstall: () => "source",
    latestVersion: () => "2.96.0",
    managedReleaseDirectory: () => false,
  });
  expect(result.reason).toBe("source_checkout");
  expect(result.latestVersion).toBeNull();
});

test("release directory names are recognised on POSIX and Windows paths", () => {
  expect(managedReleaseDirectory("/opt/opencodex/releases/v2.96.0-7ff37c1129bc")).toBe(true);
  expect(managedReleaseDirectory("C:\\x\\releases\\v2.96.0-7ff37c1129bc")).toBe(true);
  expect(managedReleaseDirectory("/home/user/src/opencodex")).toBe(false);
});
