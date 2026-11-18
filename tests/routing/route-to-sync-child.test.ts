import { describe, expect, test } from "bun:test";
import { syncRouteToChild } from "../../src/routing/route-to-sync-child";
import { remotePinnedSyncArgv } from "../../src/link/ssh-argv";
import { parseSyncFanoutFlags } from "../../src/cli/sync-flags";
import type { LinkRecord } from "../../src/link/store";
import type { ManagementContext } from "../../src/server/management/context";

const link: LinkRecord = { id: "lnk_0123456789abcdef", alias: "test-device", direction: "hub-initiated",
  hostKeyFingerprint: "SHA256:abcdefghijklmnop", tunnelPort: 41000, apiKeyId: "test-key", createdAt: new Date().toISOString(), remotePlatform: "posix" };
describe("Route-to immediate sync", () => {
  test("the explicit overwrite flag is per request and retains pinned link identity on both platforms", () => {
    const normal = remotePinnedSyncArgv(link.id);
    const forced = remotePinnedSyncArgv(link.id, "posix", true);
    expect(normal.slice(3)).toEqual(["ocx", "sync", "--expect-link", link.id, "--json"]);
    expect(forced.slice(3)).toEqual(["ocx", "sync", "--expect-link", link.id, "--json", "--overwrite-conflict"]);
    expect(remotePinnedSyncArgv(link.id, "posix", true, "aside").slice(3)).toEqual(["ocx", "sync", "--expect-link", link.id, "--json", "--overwrite-conflict", "--overwrite-client", "aside"]);
    const windows = remotePinnedSyncArgv(link.id, "windows", true);
    expect(windows).not.toEqual(remotePinnedSyncArgv(link.id, "windows"));
    expect(parseSyncFanoutFlags(["--overwrite-conflict", "--overwrite-conflict"]).ok).toBe(false);
    expect(parseSyncFanoutFlags(["--overwrite-client", "aside"]).ok).toBe(false);
    expect(parseSyncFanoutFlags(["--overwrite-conflict", "--overwrite-client", "aside"])).toMatchObject({ ok: true, overwriteClient: "aside" });
  });
  test("failed or invalid remote output is a failed apply, never success by exit code alone", async () => {
    const calls: readonly string[][] = [];
    const ctx = { deps: { sshRunner: { run: async (argv: string[]) => {
      (calls as string[][]).push(argv); return { code: 0, stdout: "unverified", stderr: "" };
    } }, linkKnownHostsPath: () => "/test/known_hosts" } } as unknown as ManagementContext;
    expect(await syncRouteToChild(link, ctx)).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.join(" ")).toContain(link.id);
  });
  test("Child-initiated links disclose pending and perform no Home SSH", async () => {
    const ctx = { deps: { sshRunner: { run: () => { throw new Error("must not run"); } } } } as unknown as ManagementContext;
    expect(await syncRouteToChild({ ...link, direction: "client-initiated" }, ctx)).toMatchObject({ state: "pending" });
  });
});
