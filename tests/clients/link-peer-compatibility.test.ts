/**
 * OCX-8: a Home reports each Child's version and a compatibility verdict from what the link
 * already carries. A Child from 2.91.0 sends its version and features on the relay challenge; an
 * older Child shows only the relay-auth version its challenge names.
 */
import { describe, expect, test } from "bun:test";
import { relayLinkDataRequest, HOME_INITIATED_LINK_TUNNEL } from "../../src/client/link-relay";
import { runLinkCommand } from "../../src/cli/link";
import {
  compareReleases, LINK_PEER_REPORT_FEATURE, LINK_PROTOCOL_RELEASES, linkPeerStatus, localLinkPeer, type LinkLocalPeer,
} from "../../src/link/compatibility";
import {
  createLinkPeerObservations, LINK_PEER_FEATURES_HEADER, LINK_PEER_VERSION_HEADER, linkPeerReportHeaders, parseLinkPeerReport,
  type LinkPeerEntry,
} from "../../src/link/peer-report";
import { LINK_RELAY_AUTH_PATH, LINK_RELAY_AUTH_VERSION, linkRelayChallenge } from "../../src/link/relay-auth";
import { attachLinkPeers, projectLinkStatus } from "../../src/link/status-projection";
import type { LinkStore } from "../../src/link/store";
import { packageVersion } from "../../src/lib/package-version";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { buildPeerFeatures } from "../../src/remote/features";
import { createLinkListenerLifecycle } from "../../src/server/index/link-listener";

const key = `ocx_data_${"a".repeat(40)}`;
const keyId = "test-link-key", linkId = "lnk_0123456789abcdef";
const fp = serviceApiTokenFingerprint(key);
const at = (second: number) => new Date(Date.UTC(2026, 9, 22, 0, 0, second));
const home: LinkLocalPeer = { version: "2.91.0", relayAuth: "2", features: ["link-management-relay", "relay-auth/2", LINK_PEER_REPORT_FEATURE] };
const empty: LinkPeerEntry = { observed: null, refused: null };

function store(): LinkStore {
  return { version: 1, listenerPort: null, links: [{ id: linkId, alias: "child", direction: "client-initiated",
    hostKeyFingerprint: null, tunnelPort: 22222, apiKeyId: keyId, createdAt: "2026-10-22T00:00:00.000Z" }] };
}

function entry(record: (peers: ReturnType<typeof createLinkPeerObservations>) => void): LinkPeerEntry {
  let second = 0;
  const peers = createLinkPeerObservations(() => at(++second));
  record(peers);
  return peers.get(linkId);
}

/** A Home lifecycle on a real socket; run gets its port and the observation it holds. */
async function withHome(run: (port: number, observed: (id?: string) => LinkPeerEntry) => Promise<void>): Promise<void> {
  let current = store();
  const lifecycle = createLinkListenerLifecycle({ readStore: () => current, writeStore: (_path, next) => { current = next; } });
  lifecycle.start({ maxRequestBodySize: 1024, keyFingerprints: id => id === keyId ? [fp] : [], dispatch: async () => Response.json({ ok: true }) });
  try { await run(lifecycle.status().port!, (id = linkId) => lifecycle.peerObservation(id)); } finally { await lifecycle.stop(); }
}

/** The challenge a Child older than 2.91.0 sends: the relay-auth query and no report headers. */
async function legacyChallenge(port: number, version = LINK_RELAY_AUTH_VERSION, link = linkId): Promise<number> {
  const proof = linkRelayChallenge(fp, keyId, link);
  const url = new URL(LINK_RELAY_AUTH_PATH, "http://127.0.0.1:" + port);
  url.search = new URLSearchParams({ version, key: keyId, link, nonce: proof.nonce, proof: proof.caller }).toString();
  const response = await fetch(url);
  await response.arrayBuffer();
  return response.status;
}

async function cliStatus(body: unknown, lines: string[]): Promise<number> {
  const log = console.log, error = console.error;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.error = () => {};
  try {
    return await runLinkCommand(["status", "--json"], { baseUrl: "http://127.0.0.1:19101", readAdminToken: () => "ocx_admin_test",
      fetchImpl: (async () => Response.json(body)) as unknown as typeof fetch });
  } finally { console.log = log; console.error = error; }
}

describe("published link protocol releases", () => {
  test("every id is a feature this build advertises, released no later than this build", () => {
    const ids = LINK_PROTOCOL_RELEASES.map(release => release.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const release of LINK_PROTOCOL_RELEASES) {
      expect(buildPeerFeatures()).toContain(release.id);
      expect(compareReleases(release.since, packageVersion())).toBeLessThanOrEqual(0);
    }
    expect(ids).toContain("relay-auth/" + LINK_RELAY_AUTH_VERSION);
  });

  test("releases compare numerically", () => {
    expect(compareReleases("2.9.0", "2.10.0")).toBe(-1);
    expect(compareReleases("2.91.0-preview.1", "2.91.0")).toBe(0);
    expect(compareReleases("3.0.0", "2.99.9")).toBe(1);
  });
});

describe("compatibility verdicts", () => {
  test("a Child the Home has not heard from is unknown", () => {
    expect(linkPeerStatus(home, empty)).toMatchObject({ compatibility: "unknown", version: null, observedAt: null });
  });

  test("a Child that predates the report is placed in a release range by its relay-auth", () => {
    const status = linkPeerStatus(home, entry(peers => peers.observe(linkId, "2", { reported: false, version: null, features: null })));
    expect(status).toMatchObject({ compatibility: "compatible", version: null, relayAuth: "2",
      versionRange: { min: "2.69.0", below: "2.91.0" }, observedAt: at(1).toISOString() });
  });

  test("a reporting Child is compatible while the Home serves every feature it uses", () => {
    const older = linkPeerStatus(home, entry(peers => peers.observe(linkId, "2", { reported: true, version: "2.91.0", features: ["relay-auth/2", LINK_PEER_REPORT_FEATURE] })));
    expect(older).toMatchObject({ compatibility: "compatible", version: "2.91.0", versionRange: null });
    const newer = linkPeerStatus(home, entry(peers => peers.observe(linkId, "2", { reported: true, version: "2.95.0", features: ["relay-auth/2", "quota-pool/1"] })));
    expect(newer.compatibility).toBe("degraded");
    expect(newer.reasons[0]).toContain("quota-pool/1");
    expect(newer.reasons[0]).toContain("Upgrade the Home");
  });

  test("a partial report is unknown: a valid version with a rejected feature list proves nothing about features", () => {
    const noFeatures = linkPeerStatus(home, entry(peers => peers.observe(linkId, "2", { reported: true, version: "2.95.0", features: null })));
    expect(noFeatures).toMatchObject({ compatibility: "unknown", version: "2.95.0", versionRange: null });
    expect(noFeatures.reasons[0]).toContain("feature list");
    const noVersion = linkPeerStatus(home, entry(peers => peers.observe(linkId, "2", { reported: true, version: null, features: ["relay-auth/2"] })));
    expect(noVersion).toMatchObject({ compatibility: "unknown", versionRange: null });
    // Both headers sent and both rejected is a reporting Child, never a pre-report one.
    const rejected = parseLinkPeerReport(new Headers({ [LINK_PEER_VERSION_HEADER]: "garbage", [LINK_PEER_FEATURES_HEADER]: "a,a" }));
    expect(rejected).toEqual({ reported: true, version: null, features: null });
    const bothRejected = linkPeerStatus(home, entry(peers => peers.observe(linkId, "2", rejected)));
    expect(bothRejected).toMatchObject({ compatibility: "unknown", versionRange: null });
    expect(parseLinkPeerReport(new Headers()).reported).toBe(false);
  });

  test("a refused relay-auth version is incompatible until a verified challenge follows", () => {
    const newer = linkPeerStatus(home, entry(peers => peers.refuse(linkId, "3")));
    expect(newer).toMatchObject({ compatibility: "incompatible", relayAuth: "3" });
    expect(newer.reasons[0]).toContain("Upgrade the Home");
    expect(linkPeerStatus(home, entry(peers => peers.refuse(linkId, "1"))).reasons[0]).toContain("Upgrade the Child");
    const recovered = entry(peers => { peers.refuse(linkId, "3"); peers.observe(linkId, "2", { reported: true, version: "2.91.0", features: ["relay-auth/2"] }); });
    expect(linkPeerStatus(home, recovered).compatibility).toBe("compatible");
    const regressed = entry(peers => { peers.observe(linkId, "2", { reported: false, version: null, features: null }); peers.refuse(linkId, "3"); });
    expect(linkPeerStatus(home, regressed).compatibility).toBe("incompatible");
  });
});

describe("the report on the wire", () => {
  test("header values round-trip and invalid fields are dropped one by one", () => {
    const headers = new Headers(linkPeerReportHeaders("2.91.0", ["relay-auth/2", "link-management-relay"]));
    expect(parseLinkPeerReport(headers)).toEqual({ reported: true, version: "2.91.0", features: ["relay-auth/2", "link-management-relay"] });
    expect(linkPeerReportHeaders("not a version", ["bad id"])).toEqual({});
    const mixed = new Headers({ [LINK_PEER_VERSION_HEADER]: "2.91.0-x y", [LINK_PEER_FEATURES_HEADER]: "a,a" });
    expect(parseLinkPeerReport(mixed)).toEqual({ reported: true, version: null, features: null });
    const many = Array.from({ length: 65 }, (_, i) => "f" + i).join(",");
    expect(parseLinkPeerReport(new Headers({ [LINK_PEER_VERSION_HEADER]: "2.91.0", [LINK_PEER_FEATURES_HEADER]: many })))
      .toEqual({ reported: true, version: "2.91.0", features: null });
  });

  test("a relayed request records this build's version and features on the Home", async () => {
    await withHome(async (port, observed) => {
      expect(observed()).toEqual(empty);
      const response = await relayLinkDataRequest(new Request("http://127.0.0.1/v1/models"),
        { tunnelPort: port, admissionKey: key, apiKeyId: keyId, linkId }, { tunnel: HOME_INITIATED_LINK_TUNNEL });
      expect(response.status).toBe(200);
      await response.arrayBuffer();
      expect(observed().observed).toMatchObject({ relayAuth: LINK_RELAY_AUTH_VERSION, version: packageVersion(), features: buildPeerFeatures() });
      const local = localLinkPeer(packageVersion(), buildPeerFeatures());
      expect(linkPeerStatus(local, observed())).toMatchObject({ compatibility: "compatible", version: packageVersion() });
    });
  });

  test("an older Child's challenge records relay-auth only; a mismatch is recorded only for a known link", async () => {
    await withHome(async (port, observed) => {
      expect(await legacyChallenge(port)).toBe(204);
      expect(observed().observed).toMatchObject({ relayAuth: "2", reported: false, version: null, features: null });
      const unknownLink = "lnk_fedcba9876543210";
      expect(await legacyChallenge(port, "3", unknownLink)).toBe(404);
      expect(observed(unknownLink)).toEqual(empty);
      expect(observed().refused).toBeNull();
      expect(await legacyChallenge(port, "3")).toBe(404);
      expect(observed().refused).toMatchObject({ relayAuth: "3" });
    });
  });
});

describe("ocx link status --json", () => {
  test("a Home lists each Child's peer status and its own identity, and the CLI validates both", async () => {
    const dto = attachLinkPeers(projectLinkStatus(store(), [], { state: "listening", port: 19100 }, { runtimeRole: "hub" }, { version: 1, entries: {} }),
      home, () => entry(peers => peers.observe(linkId, "2", { reported: false, version: null, features: null })));
    expect(dto.local).toEqual(home);
    expect(dto.links[0]!.peer).toMatchObject({ compatibility: "compatible", versionRange: { min: "2.69.0", below: "2.91.0" } });
    const lines: string[] = [];
    expect(await cliStatus(dto, lines)).toBe(0);
    expect(JSON.parse(lines[0]!)).toEqual(JSON.parse(JSON.stringify(dto)));
    const malformed = { ...dto, links: [{ ...dto.links[0]!, peer: { ...dto.links[0]!.peer!, compatibility: "fine" } }] };
    expect(await cliStatus(malformed, [])).not.toBe(0);
    const { local: _local, ...older } = dto;
    expect(await cliStatus({ ...older, links: dto.links.map(({ peer: _peer, ...link }) => link) }, [])).toBe(0);
  });

  test("a Child reports its own identity and no peer verdicts", () => {
    const dto = attachLinkPeers(projectLinkStatus(store(), [], { state: "off", port: null }, { runtimeRole: "client" }, { version: 1, entries: {} }),
      home, () => { throw new Error("a Child has no peers"); });
    expect(dto.role).toBe("child");
    expect(dto.local).toEqual(home);
    expect(dto.links.every(link => link.peer === undefined)).toBe(true);
  });
});
