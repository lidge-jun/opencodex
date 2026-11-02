import { describe, expect, test } from "bun:test";
import { classifySyncResult, classifyVersionProbe, runHomeFanout } from "../../src/cli/sync-fanout";
import type { LinkRecord } from "../../src/link/store";

describe("sync fan-out child evidence", () => {
  test.each([
    ["2.93.0+build.5", null], ["2.92.9+build", "child-ocx-lacks-expect-link"],
    ["2.93.0-preview.1", "child-ocx-lacks-expect-link"], ["garbage", "child-ocx-version-unknown"],
  ])("version %s yields %s", (version, reason) => {
    expect(classifyVersionProbe(version)).toBe(reason);
  });

  test("requires a valid marker and positive child output", () => {
    const run = (code: number, stdout: string, stderr = "ocx-fanout:selected:2.93.0+build.5\n") => classifySyncResult({ code, stdout, stderr });
    expect(run(0, "Remote Link Home catalog synchronized.")).toEqual({ state: "synced", reason: null });
    expect(run(0, "")).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(run(0, "{bad")).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(run(0, "Remote Link Home catalog synchronized.", "")).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(run(1, '{"schema":"ocx.sync.fanout/1","home":{"state":"synced","exit":0},"fanout":{"state":"not-applicable","reason":null},"children":[]}')).toEqual({ state: "failed", reason: "child-sync-failed" });
    expect(run(255, "Remote Link Home catalog synchronized.")).toEqual({ state: "failed", reason: "ssh-failed" });
  });
});

test("bounds concurrent children and isolates a thrown worker", async () => {
  const links: LinkRecord[] = Array.from({ length: 7 }, (_, i) => ({ id: `lnk_${String(i).padStart(16, "0")}`, alias: `host${i}`, direction: "hub-initiated", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 25000 + i, apiKeyId: `key${i}`, createdAt: "2026-01-01T00:00:00Z", remotePlatform: "posix" }));
  let active = 0, peak = 0;
  const result = await runHomeFanout({
    home: { state: "synced", exit: 0 }, catalogCurrent: true,
    readStore: () => ({ version: 1, listenerPort: 27000, links }),
    readLinkStatus: async () => ({ role: "home", listener: { state: "listening", port: 27000 }, child: null, links: links.map(link => ({ ...link, state: "connected", since: link.createdAt, reason: null, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null })) }),
    runChild: async link => { active++; peak = Math.max(active, peak); await Bun.sleep(5); active--; if (link.alias === "host2") throw new Error("private text"); return { state: "synced", reason: null, exit: 0 }; },
  });
  expect(peak).toBe(3);
  expect(result.children).toHaveLength(7);
  expect(result.children[2]).toMatchObject({ state: "failed", reason: "internal-error" });
  expect(result.children.filter(child => child.state === "synced")).toHaveLength(6);
});
