import { expect, test } from "bun:test";
import { darwinOwnershipModel, type DarwinWalk, type DarwinFault } from "../helpers/codex-launch-darwin-model";

for (const walk of ["home", "alias", "namespace"] as DarwinWalk[]) {
  for (const fault of ["vanished", "inode", "wide-inode", "device", "type", "stat", "close"] as DarwinFault[]) {
    test(`Darwin ${walk}: ${fault} entry refuses and closes every opened descriptor`, () => {
      const result = darwinOwnershipModel(walk, fault);
      expect(result.reached).toBe(true);
      expect(result.admitted).toBe(false);
      expect(result.closed.sort()).toEqual(result.opened.sort());
    });
  }
  test(`Darwin ${walk}: ${walk === "alias" ? "protected symlink alias" : "the same existing object"} without an ACL admits`, () => {
    const result = darwinOwnershipModel(walk, "none");
    expect(result.reached).toBe(true);
    expect(result.admitted).toBe(true);
    expect(result.aclReads).toBeGreaterThan(0);
    expect(result.forcedReads).toBe(2);
    expect(result.closed.sort()).toEqual(result.opened.sort());
    // XNU rejects final symlinks with O_NOFOLLOW even alongside O_SYMLINK.
    expect(result.flags[0]! & 0x200100).toBe(walk === "alias" ? 0x200000 : 0x100);
    expect(result.flags[0]! & 0x1000004).toBe(0x1000004); // NONBLOCK | CLOEXEC
    if (walk === "namespace") expect(result.flags[0]! & 0x100000).toBe(0x100000);
  });
  for (const errno of [0, 5, 12, 13, 22, 45]) test(`Darwin ${walk}: NULL ACL errno ${errno} refuses`, () => {
    const result = darwinOwnershipModel(walk, "errno", errno);
    expect(result.admitted).toBe(false);
    expect(result.aclReads).toBe(1);
    expect(result.closed.sort()).toEqual(result.opened.sort());
  });
  test(`Darwin ${walk}: absent ACL does not bypass forced preferences`, () => {
    const result = darwinOwnershipModel(walk, "none", 2, true);
    expect(result.admitted).toBe(false);
    expect(result.forcedReads).toBe(1);
  });
}

for (const fault of ["link-file", "link-directory"] as const) {
  test(`Darwin alias: ${fault} replacement between lstat and open refuses before ACL read`, () => {
    const result = darwinOwnershipModel("alias", fault);
    expect(result.reached).toBe(true);
    expect(result.flags[0]! & 0x200100).toBe(0x200000);
    expect(result.admitted).toBe(false);
    expect(result.aclReads).toBe(0);
    expect(result.opened).toHaveLength(1);
    expect(result.closed).toEqual(result.opened);
  });
}
