import { describe, expect, test } from "bun:test";
import { classifySyncResult, classifyVersionProbe, fanoutExitCode, renderFanoutHuman, renderFanoutJson, runHomeFanout } from "../../src/cli/sync-fanout";
import { LinkStatusError } from "../../src/cli/sync-link-status";
import type { LinkRecord } from "../../src/link/store";

describe("sync fan-out child evidence", () => {
  test("accepts startup output only outside exactly one set of framing markers", () => {
    const marker = "ocx-fanout:selected:2.93.0+build.5";
    const delimiter = "ocx-fanout:stdout-begin";
    const doc = JSON.stringify({ schema: "ocx.sync.fanout/1", home: { state: "synced", exit: 0 }, fanout: { state: "not-applicable", reason: null }, children: [] });
    const run = (stdout: string, stderr: string) => classifySyncResult({ code: 0, stdout, stderr });
    for (const payload of [doc, "Remote Link Home catalog synchronized."]) {
      expect(run(`shell startup warning\n${delimiter}\n${payload}\n`, `shell stderr warning\n${marker}\n`)).toEqual({ state: "synced", reason: null });
      expect(run(`${delimiter}\n${payload}`, `${marker}\n${marker}\n`)).toEqual({ state: "failed", reason: "child-output-invalid" });
      expect(run(payload, `${marker}\n`)).toEqual({ state: "failed", reason: "child-output-invalid" });
      expect(run(`${delimiter}\n${delimiter}\n${payload}`, `${marker}\n`)).toEqual({ state: "failed", reason: "child-output-invalid" });
    }
    expect(run(`Home unavailable; retained and applied the last-known-good remote catalog (stale).\n${delimiter}\n${doc}`, `${marker}\n`)).toEqual({ state: "synced", reason: null });
    expect(run(`Remote Link Home catalog synchronized.\n${delimiter}\nno evidence`, `${marker}\n`)).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(run(`${delimiter}\n${doc}`, "startup\nocx-fanout:selected:2.93.0-01\n")).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(run(`${delimiter}\n${doc}`, "ocx-fanout:selected:2.93.0 \n")).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(classifySyncResult({ code: 5, stdout: `startup\n${delimiter}\n`, stderr: `warning\n${marker}\n{"phase":"child_link_mismatch","reason":"other_link"}\n` })).toEqual({ state: "skipped", reason: "child-link-mismatch:other_link" });
    expect(classifySyncResult({ code: 5, stdout: "startup\n", stderr: `${marker}\n` })).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(classifySyncResult({ code: 121, stdout: "startup\n", stderr: "warning\nocx-fanout:child-ocx-version-unknown\n" })).toEqual({ state: "skipped", reason: "child-ocx-version-unknown" });
  });
  test.each([
    ["2.93.0+build.5", null], ["2.92.9+build", "child-ocx-lacks-expect-link"],
    ["2.93.0-preview.1", "child-ocx-lacks-expect-link"], ["garbage", "child-ocx-version-unknown"],
  ])("version %s yields %s", (version, reason) => {
    expect(classifyVersionProbe(version)).toBe(reason);
  });

  test("requires a valid marker and positive child output", () => {
    const run = (code: number, stdout: string, stderr = "ocx-fanout:selected:2.93.0+build.5\n") => classifySyncResult({ code, stdout: `ocx-fanout:stdout-begin\n${stdout}`, stderr });
    expect(run(0, "Remote Link Home catalog synchronized.")).toEqual({ state: "synced", reason: null });
    expect(run(0, "")).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(run(0, "{bad")).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(run(0, "Remote Link Home catalog synchronized.", "")).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(run(1, '{"schema":"ocx.sync.fanout/1","home":{"state":"synced","exit":0},"fanout":{"state":"not-applicable","reason":null},"children":[]}')).toEqual({ state: "failed", reason: "child-sync-failed" });
    expect(run(255, "Remote Link Home catalog synchronized.")).toEqual({ state: "failed", reason: "ssh-failed" });
    const doc = (state: string) => JSON.stringify({ schema: "ocx.sync.fanout/1", home: { state, exit: 0 }, fanout: { state: "not-applicable", reason: null }, children: [] });
    expect(run(0, doc("synced"))).toEqual({ state: "synced", reason: null });
    expect(run(0, doc("stale"))).toEqual({ state: "failed", reason: "child-catalog-stale" });
    expect(run(0, doc("synced") + doc("synced"))).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(run(0, doc("synced").replace("ocx.sync.fanout/1", "future"))).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(run(0, doc("synced").replace('"exit":0', '"exit":0,"extra":true'))).toEqual({ state: "failed", reason: "child-output-invalid" });
    expect(run(0, "Remote Link Home catalog synchronized. Home unavailable; retained and applied the last-known-good remote catalog (stale).")) .toEqual({ state: "failed", reason: "child-catalog-stale" });
    expect(run(5, "", 'ocx-fanout:selected:2.93.0\n{"phase":"child_link_mismatch","reason":"other_link"}\n')).toEqual({ state: "skipped", reason: "child-link-mismatch:other_link" });
    expect(run(5, "", 'ocx-fanout:selected:2.93.0\n{"phase":"child_link_mismatch","reason":"surprise"}\n')).toEqual({ state: "skipped", reason: "child-link-mismatch" });
    expect(run(7, "")).toEqual({ state: "skipped", reason: "child-updating" });
    expect(run(127, "", "")).toEqual({ state: "failed", reason: "child-ocx-not-found" });
    expect(run(126, "", "")).toEqual({ state: "failed", reason: "child-ocx-not-contained" });
    expect(run(125, "", "")).toEqual({ state: "skipped", reason: "child-platform-unsupported" });
    expect(run(121, "", "ocx-fanout:child-ocx-version-unknown\n")).toEqual({ state: "skipped", reason: "child-ocx-version-unknown" });
    expect(run(121, "", "unexpected\n")).toEqual({ state: "failed", reason: "child-sync-failed" });
    expect(run(0, doc("synced"), "ocx-fanout:selected:2.93.0-01\n")).toEqual({ state: "failed", reason: "child-output-invalid" });
  });
});

test("Home gate and status failures skip or fail the correct Children", async () => {
  const link: LinkRecord = { id: "lnk_0000000000000001", alias: "host", direction: "hub-initiated", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 25000, apiKeyId: "key", createdAt: "2026-01-01T00:00:00Z" };
  const readStore = () => ({ version: 1 as const, listenerPort: 27000, links: [link, { ...link, id: "lnk_0000000000000002", direction: "client-initiated" as const, hostKeyFingerprint: null }] });
  const runChild = async () => { throw new Error("unexpected child"); };
  for (const [home, catalogCurrent, reason] of [
    [{ state: "failed", exit: 1 }, false, "home-sync-failed"],
    [{ state: "skipped", exit: 0 }, false, "home-sync-skipped"],
    [{ state: "synced", exit: 0 }, false, "home-catalog-not-current"],
  ] as const) {
    const result = await runHomeFanout({ home, catalogCurrent, readStore, readLinkStatus: async () => { throw new Error("unexpected status"); }, runChild });
    expect(result.children.map(child => child.reason)).toEqual([reason, "client-initiated-link"]);
    expect(fanoutExitCode(result)).toBe(home.exit);
  }
  for (const reason of ["home-runtime-not-running", "home-link-status-unauthorized", "home-link-status-timeout", "home-link-status-unavailable", "home-link-status-invalid"] as const) {
    const result = await runHomeFanout({ home: { state: "synced", exit: 0 }, catalogCurrent: true, readStore, readLinkStatus: async () => { throw new LinkStatusError(reason); }, runChild });
    expect(result.children[0]).toMatchObject({ state: reason === "home-runtime-not-running" ? "skipped" : "failed", reason });
    expect(fanoutExitCode(result)).toBe(reason === "home-runtime-not-running" ? 0 : 6);
  }
  const result = await runHomeFanout({ home: { state: "synced", exit: 0 }, catalogCurrent: true, readStore: () => { throw new Error("bad store"); }, readLinkStatus: async () => { throw new Error("unexpected status"); }, runChild });
  expect(result.fanout).toEqual({ state: "failed", reason: "link-store-unreadable" });
  expect(fanoutExitCode(result)).toBe(6);
});

test("bounds concurrent children and isolates a thrown worker", async () => {
  const links: LinkRecord[] = Array.from({ length: 7 }, (_, i) => ({ id: `lnk_${String(i).padStart(16, "0")}`, alias: `host${i}`, direction: "hub-initiated", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 25000 + i, apiKeyId: `key${i}`, createdAt: "2026-01-01T00:00:00Z", remotePlatform: "posix" }));
  let active = 0, peak = 0;
  const result = await runHomeFanout({
    home: { state: "synced", exit: 0 }, catalogCurrent: true, concurrency: 9,
    readStore: () => ({ version: 1, listenerPort: 27000, links }),
    readLinkStatus: async () => ({ role: "home", listener: { state: "listening", port: 27000 }, child: null, links: links.map(link => ({ ...link, state: "connected", since: link.createdAt, reason: null, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null })) }),
    runChild: async link => { active++; peak = Math.max(active, peak); await Bun.sleep(5); active--; if (link.alias === "host2") throw new Error("private text"); return { state: "synced", reason: null, exit: 0 }; },
  });
  expect(peak).toBe(3);
  expect(result.children).toHaveLength(7);
  expect(result.children[2]).toMatchObject({ state: "failed", reason: "internal-error" });
  expect(result.children.filter(child => child.state === "synced")).toHaveLength(6);
});

test("three stalled workers release a fourth after one deadline wave", async () => {
  const links: LinkRecord[] = Array.from({ length: 4 }, (_, i) => ({ id: `lnk_${String(i).padStart(16, "0")}`, alias: `host${i}`, direction: "hub-initiated", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 25000 + i, apiKeyId: `key${i}`, createdAt: "2026-01-01T00:00:00Z" }));
  const starts: number[] = [];
  const start = Date.now();
  const result = await runHomeFanout({
    home: { state: "synced", exit: 0 }, catalogCurrent: true, deadlineMs: 30, terminationGraceMs: 5,
    readStore: () => ({ version: 1, listenerPort: 27000, links }),
    readLinkStatus: async () => ({ role: "home", listener: { state: "listening", port: 27000 }, child: null, links: links.map(link => ({ ...link, state: "connected", since: link.createdAt, reason: null, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null })) }),
    runChild: async link => { starts.push(Date.now() - start); return link.alias === "host3" ? { state: "synced", reason: null, exit: 0 } : await new Promise<never>(() => {}); },
  });
  expect(starts).toHaveLength(4);
  expect(starts[3]).toBeLessThan(300);
  expect(result.children.map(child => child.state)).toEqual(["timed-out", "timed-out", "timed-out", "synced"]);
});

test("connected skipped Children make fan-out partial with actionable hints", async () => {
  const reasons = ["child-ocx-lacks-expect-link", "child-link-mismatch:disconnected", "child-link-mismatch:other_link", "child-updating"];
  const links: LinkRecord[] = reasons.map((_, i) => ({ id: `lnk_${String(i).padStart(16, "0")}`, alias: `host${i}`, direction: "hub-initiated", hostKeyFingerprint: "SHA256:AAAAAAAAAAAAAAAA", tunnelPort: 25000 + i, apiKeyId: `key${i}`, createdAt: "2026-01-01T00:00:00Z" }));
  const result = await runHomeFanout({
    home: { state: "synced", exit: 0 }, catalogCurrent: true,
    readStore: () => ({ version: 1, listenerPort: 27000, links }),
    readLinkStatus: async () => ({ role: "home", listener: { state: "listening", port: 27000 }, child: null, links: links.map(link => ({ ...link, state: "connected", since: link.createdAt, reason: null, lastApplyAt: null, runtimeStartedAt: null, appliedCodexSettingsDigest: null })) }),
    runChild: async link => ({ state: "skipped", reason: reasons[links.indexOf(link)]!, exit: 5 }),
  });
  expect(fanoutExitCode(result)).toBe(6);
  const json = JSON.parse(renderFanoutJson(result));
  expect(json.schema).toBe("ocx.sync.fanout/1");
  expect(json.children.map((child: { reason: string }) => child.reason)).toEqual(reasons);
  expect(json.children[0].hint).toContain("2.93.0");
  expect(json.children[0].hint).toContain("host0");
  expect(json.children[0].hint).toContain("installer that owns");
  expect(json.children[0].hint).not.toContain("Update OpenCodex Desktop");
  expect(json.children[0].hint).toContain("Check for Updates");
  expect(json.children[1].hint).toContain("re-link");
  expect(json.children[2].hint).toContain("re-link");
  expect(json.children[3].hint).toContain("Wait");
  const lines = renderFanoutHuman(result);
  for (let i = 0; i < links.length; i++) {
    expect(lines[i]).toContain(links[i]!.alias);
    expect(lines[i]).toContain(json.children[i].hint);
  }
  expect(fanoutExitCode({ ...result, children: [result.children[0]!, { ...result.children[1]!, state: "synced", reason: null }] })).toBe(6);
});
