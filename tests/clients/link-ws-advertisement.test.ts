import { afterEach, describe, expect, test } from "bun:test";
import {
  applyLinkWebsocketAnswer, forgetLinkWebsocketAdvertisementsForTests, linkWebsocketAdvertised, linkWebsocketAnswer, nextLinkPreflightSequence,
} from "../../src/client/link-ws-advertisement";
import { fetchBoundLinkRelay, probeLinkRelayPreflight } from "../../src/client/link-relay-transport";
import { serviceApiTokenFingerprint } from "../../src/lib/service-secrets";
import { LINK_RELAY_WS_STATE_HEADER, LINK_RELAY_WS_STATE_PROOF_HEADER, linkWebsocketStateProof } from "../../src/link/relay-auth";
import { startStandinHome, standinIdentity, type StandinHome, type StandinState } from "../fixtures/link-ws-standin-home";

// Lane T6, design T4 3.2 and 11.2 item 1: the Child learns whether its Home advertises the link
// WebSocket from ordinary relay traffic, and orders answers by when it sent each preflight.

const homes: StandinHome[] = [];
afterEach(async () => {
  forgetLinkWebsocketAdvertisementsForTests();
  for (const home of homes.splice(0)) await home.stop();
});

const LINK = "lnk_0123456789abcdef";
const NONCE = "a".repeat(64);
const SECRET = "advert-secret-0123456789";
const identity = { fingerprint: serviceApiTokenFingerprint(SECRET), keyId: "advert-key", linkId: LINK, nonce: NONCE };

function headersFor(value: "on" | "off", proofValue: "on" | "off" = value, nonce = NONCE) {
  return { [LINK_RELAY_WS_STATE_HEADER]: value, [LINK_RELAY_WS_STATE_PROOF_HEADER]: linkWebsocketStateProof(identity.fingerprint, identity.keyId, LINK, nonce, proofValue)! };
}

describe("the state one verified answer names", () => {
  test("on only with a proof bound to this nonce, key and link; anything else is off", () => {
    expect(linkWebsocketAnswer(headersFor("on"), identity)).toBe("on");
    expect(linkWebsocketAnswer(headersFor("off"), identity)).toBe("off");
    expect(linkWebsocketAnswer({}, identity)).toBe("off");
    expect(linkWebsocketAnswer({ [LINK_RELAY_WS_STATE_HEADER]: "on" }, identity)).toBe("off");
    expect(linkWebsocketAnswer(headersFor("on", "off"), identity)).toBe("off");
    expect(linkWebsocketAnswer(headersFor("on", "on", "b".repeat(64)), identity)).toBe("off");
    expect(linkWebsocketAnswer(headersFor("on"), { ...identity, keyId: "other-key" })).toBe("off");
  });
});

describe("ordering by preflight start", () => {
  test("an answer to an earlier preflight that arrives late is never applied", () => {
    const a = nextLinkPreflightSequence(); // Home A's preflight starts first ...
    const b = nextLinkPreflightSequence(); // ... Home B's second.
    expect(applyLinkWebsocketAnswer(LINK, b, "off")).toBe(true);
    expect(applyLinkWebsocketAnswer(LINK, a, "on")).toBe(false);
    expect(linkWebsocketAdvertised(LINK)).toBe(false);
  });

  test("more than four successive toggles end on the last one sent", () => {
    const answers = ["on", "off", "on", "off", "on", "off", "on"] as const;
    const numbers = answers.map(() => nextLinkPreflightSequence());
    // Delivered in a scrambled order: only increasing numbers apply.
    for (const index of [1, 0, 3, 2, 6, 5, 4]) applyLinkWebsocketAnswer(LINK, numbers[index]!, answers[index]!);
    expect(linkWebsocketAdvertised(LINK)).toBe(true);
  });

  test("a relink is a new link id with its own state; a restart starts from off", () => {
    applyLinkWebsocketAnswer(LINK, nextLinkPreflightSequence(), "on");
    expect(linkWebsocketAdvertised("lnk_fedcba9876543210")).toBe(false);
    expect(linkWebsocketAdvertised(LINK)).toBe(true);
    forgetLinkWebsocketAdvertisementsForTests();
    expect(linkWebsocketAdvertised(LINK)).toBe(false);
    expect(linkWebsocketAdvertised(undefined)).toBe(false);
  });

  test("without Child traffic a Home's toggle is not seen: nothing converges on its own", () => {
    applyLinkWebsocketAnswer(LINK, nextLinkPreflightSequence(), "on");
    // The Home switched off; no preflight ran since.
    expect(linkWebsocketAdvertised(LINK)).toBe(true);
  });

  test("a link evicted by 256 others keeps its ordering: an answer still in flight cannot land as the newest", () => {
    const stale = nextLinkPreflightSequence(); // an "on" preflight for LINK still on its way
    applyLinkWebsocketAnswer(LINK, nextLinkPreflightSequence(), "off");
    for (let i = 0; i < 256; i += 1) applyLinkWebsocketAnswer("lnk_" + i.toString(16).padStart(16, "0"), nextLinkPreflightSequence(), "on");
    expect(applyLinkWebsocketAnswer(LINK, stale, "on")).toBe(false);
    expect(linkWebsocketAdvertised(LINK)).toBe(false);
    // A preflight started after the eviction applies as usual.
    expect(applyLinkWebsocketAnswer(LINK, nextLinkPreflightSequence(), "on")).toBe(true);
    expect(linkWebsocketAdvertised(LINK)).toBe(true);
  });

  test("other links' traffic and evictions never discard an answer for a link they did not evict", () => {
    const first = nextLinkPreflightSequence(); // LINK's first preflight, answered after everyone else's
    for (let i = 0; i < 600; i += 1) applyLinkWebsocketAnswer("lnk_" + i.toString(16).padStart(16, "0"), nextLinkPreflightSequence(), "off");
    expect(applyLinkWebsocketAnswer(LINK, first, "on")).toBe(true);
    expect(linkWebsocketAdvertised(LINK)).toBe(true);
  });
});

describe("learned from real relay preflights", () => {
  async function home(state: () => StandinState, extra: Partial<Parameters<typeof startStandinHome>[0]> = {}) {
    const id = standinIdentity();
    const started = await startStandinHome({ identity: id, state, ...extra });
    homes.push(started);
    return { home: started, target: { tunnelPort: started.port, admissionKey: id.secret, linkId: id.linkId, apiKeyId: id.keyId } };
  }

  test("the readiness probe and a data request both apply the answer; a 204 without the pair applies as off", async () => {
    let state: StandinState = "on";
    const { target } = await home(() => state);
    expect(await probeLinkRelayPreflight(target)).toBe("ok");
    expect(linkWebsocketAdvertised(target.linkId)).toBe(true);
    state = "none";
    const response = await fetchBoundLinkRelay(target, "http://127.0.0.1:" + target.tunnelPort + "/v1/catalog", { method: "GET" });
    await response.arrayBuffer();
    expect(linkWebsocketAdvertised(target.linkId)).toBe(false);
    state = "bad-proof";
    expect(await probeLinkRelayPreflight(target)).toBe("ok");
    expect(linkWebsocketAdvertised(target.linkId)).toBe(false);
  });

  test("a data request the Home answers 404 (an older Home without the parity route) still teaches the state", async () => {
    const { target } = await home(() => "on");
    const response = await fetchBoundLinkRelay(target, "http://127.0.0.1:" + target.tunnelPort + "/api/link/child-parity", { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
    await response.arrayBuffer();
    expect(linkWebsocketAdvertised(target.linkId)).toBe(true);
  });

  test("Home A's answer, delayed past Home B's, is ignored", async () => {
    let releaseA!: () => void;
    const heldA = new Promise<void>(resolve => { releaseA = resolve; });
    let seenA!: () => void;
    const arrivedA = new Promise<void>(resolve => { seenA = resolve; });
    // The first connection plays Home A (on, answered last); every later one Home B (off).
    const { target } = await home(request => (request.connection === 1 ? "on" : "off"), {
      holdChallenge: request => { if (request.connection !== 1) return undefined; seenA(); return heldA; },
    });
    const first = probeLinkRelayPreflight(target);
    await arrivedA;
    expect(await probeLinkRelayPreflight(target)).toBe("ok");
    expect(linkWebsocketAdvertised(target.linkId)).toBe(false);
    releaseA();
    expect(await first).toBe("ok");
    expect(linkWebsocketAdvertised(target.linkId)).toBe(false);
  });
});
