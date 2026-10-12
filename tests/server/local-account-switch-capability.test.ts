import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  accountSwitchBodyDigest, createLocalAccountSwitchCapability, verifyLocalAccountSwitchCapability,
  LOCAL_ACCOUNT_SWITCH_BODY_HEADER, LOCAL_ACCOUNT_SWITCH_PATHS,
} from "../../src/lib/local-account-switch-capability";
import {
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER as expiryHeader,
  LOCAL_MANAGEMENT_CAPABILITY_HEADER as proofHeader,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER as pidHeader,
  LOCAL_MANAGEMENT_NONCE_HEADER as nonceHeader,
  createLocalManagementReadCapability,
} from "../../src/lib/local-management-capability";
import { createLocalDesktopSnapshotCapability, desktopSnapshotBodyDigest } from "../../src/lib/local-desktop-snapshot-capability";
import { hasLocalAccountSwitchCapability } from "../../src/server/local-account-switch-auth";
import { handleManagementAPI } from "../../src/server/management-api";
import { managementPrincipal, requireManagementAuth, type ManagementAuthState } from "../../src/server/management-auth";
import type { OcxConfig } from "../../src/types";

const secret = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc";
const nonce = "A".repeat(43);
const pid = 4242;
const port = 10100;
const expiresAt = 1_700_000_010_000;
const now = 1_700_000_000_000;
const local = { attestationSecret: secret, pid, port };
const config = { port, defaultProvider: "openai", providers: {} } as OcxConfig;
const state: ManagementAuthState = { available: true, token: "switch-test-admin", source: "environment", sessions: new Map(), pairingGrants: new Map() };
const vectors = [
  [LOCAL_ACCOUNT_SWITCH_PATHS[0], '{"accountId":"acct-1"}', "TAvg-9rOZVklyLUY6FQ1afEc-hJ80OLD8qSKdKSrjh4", "oaJMrRckk98viNXA3nUO6y7nHDkehgcPIGjbEhgDX4M"],
  [LOCAL_ACCOUNT_SWITCH_PATHS[1], '{"provider":"anthropic","accountId":"acct-1"}', "AkfVPiY6XR2cClHqqApykOKZcdiTqwpkeVuBQDg3u5A", "5_u4nzIUGl32US-V7eftK1r4iV90gS4WSdtEgimYtFQ"],
  [LOCAL_ACCOUNT_SWITCH_PATHS[2], '{"name":"xai","id":"key-1"}', "TwpvGp8TFleVkY5xRWSl_UMujQUbQMsk-P2oFvMvjjg", "kdKDBHHEYD9E56oKxS2NHSU5DIuhdLEHv5XLDh9KM9Q"],
] as const;

function signed(path: string, body: string, options: { sent?: string; expiry?: number; requestNonce?: string } = {}): Request {
  const requestNonce = options.requestNonce ?? randomBytes(32).toString("base64url");
  const expiry = options.expiry ?? Date.now() + 10_000;
  const digest = accountSwitchBodyDigest(new TextEncoder().encode(body));
  return new Request(`http://127.0.0.1:${port}${path}`, {
    method: "PUT", body: options.sent ?? body,
    headers: {
      host: `127.0.0.1:${port}`, "content-type": "application/json", [pidHeader]: String(pid), [nonceHeader]: requestNonce,
      [expiryHeader]: String(expiry), [LOCAL_ACCOUNT_SWITCH_BODY_HEADER]: digest,
      [proofHeader]: createLocalAccountSwitchCapability(secret, requestNonce, "PUT", path, pid, port, expiry, digest)!,
    },
  });
}

async function dispatch(req: Request): Promise<Response> {
  const denied = requireManagementAuth(req, state, config, local);
  if (denied) return denied;
  return (await handleManagementAPI(req, new URL(req.url), config, {}, managementPrincipal(req, state, config, local)!))!;
}

describe("local account switch capability", () => {
  test("matches all three fixed Rust vectors", () => {
    for (const [path, body, digest, mac] of vectors) {
      expect(accountSwitchBodyDigest(new TextEncoder().encode(body))).toBe(digest);
      expect(createLocalAccountSwitchCapability(secret, nonce, "PUT", path, pid, port, expiresAt, digest)).toBe(mac);
      expect(verifyLocalAccountSwitchCapability(secret, nonce, "PUT", path, pid, port, expiresAt, digest, mac, now)).toBe(true);
    }
  });

  test("admits each exact route and reaches its ordinary handler", async () => {
    for (const [path, body] of vectors) {
      const req = signed(path, body);
      expect(requireManagementAuth(req, state, config, local)).toBeNull();
      expect(managementPrincipal(req, state, config, local)).toBe("local-account-switch-capability");
      const response = await dispatch(req);
      expect([401, 403, 503]).not.toContain(response.status);
    }
  });

  test("rejects method, path, query, origin, PID, expiry and replay", async () => {
    const [path, body] = vectors[0];
    const proof = signed(path, body);
    const replay = proof.clone();
    expect(hasLocalAccountSwitchCapability(proof, local)).toBe(true);
    expect(hasLocalAccountSwitchCapability(replay, local)).toBe(false);
    for (const target of [`${path}?x=1`, `${path}/`, "/api/codex-auth/accounts/alias", "/api/update/desktop-snapshot"]) {
      const req = new Request(`http://127.0.0.1:${port}${target}`, { method: "PUT", headers: signed(path, body).headers, body });
      expect(hasLocalAccountSwitchCapability(req, local)).toBe(false);
    }
    const get = new Request(`http://127.0.0.1:${port}${path}`, { headers: signed(path, body).headers });
    expect(hasLocalAccountSwitchCapability(get, local)).toBe(false);
    const origin = signed(path, body); origin.headers.set("origin", "http://127.0.0.1:10100");
    expect(hasLocalAccountSwitchCapability(origin, local)).toBe(false);
    const wrongPid = signed(path, body); wrongPid.headers.set(pidHeader, "4243");
    expect(hasLocalAccountSwitchCapability(wrongPid, local)).toBe(false);
    // One pinned clock for minting and checking, so the ten-second boundary cannot drift.
    const clock = Date.now();
    const expired = signed(path, body, { expiry: clock - 1 });
    expect(hasLocalAccountSwitchCapability(expired, local, clock)).toBe(false);
    const future = signed(path, body, { expiry: clock + 10_001 });
    expect(hasLocalAccountSwitchCapability(future, local, clock)).toBe(false);
    const edge = signed(path, body, { expiry: clock + 10_000 });
    expect(hasLocalAccountSwitchCapability(edge, local, clock)).toBe(true);
    expect(createLocalAccountSwitchCapability(secret, nonce, "GET", path, pid, port, expiresAt, vectors[0][2])).toBeNull();
  });

  test("verifies original bytes and the cached digest, and rejects encoding", async () => {
    const [path, body] = vectors[0];
    expect((await dispatch(signed(path, body, { sent: ` ${body}` }))).status).toBe(403);
    const changed = signed(path, body, { sent: "{}" });
    expect(requireManagementAuth(changed, state, config, local)).toBeNull();
    changed.headers.set(LOCAL_ACCOUNT_SWITCH_BODY_HEADER, accountSwitchBodyDigest(new TextEncoder().encode("{}")));
    expect((await dispatch(changed)).status).toBe(403);
    const encoded = signed(path, body); encoded.headers.set("content-encoding", "gzip");
    expect((await dispatch(encoded)).status).toBe(415);
    expect((await dispatch(signed(path, "x".repeat(1025)))).status).toBe(413);
    expect((await dispatch(signed(path, "x".repeat(1024)))).status).toBe(400);
  });

  test("does not treat other capability families as switch authority", () => {
    const [path, body] = vectors[0];
    const readExpiry = Date.now() + 10_000;
    const read = signed(path, body);
    read.headers.set(nonceHeader, nonce);
    read.headers.set(expiryHeader, String(readExpiry));
    read.headers.set(proofHeader, createLocalManagementReadCapability(secret, nonce, "GET", path, pid, port, readExpiry)!);
    expect(requireManagementAuth(read, state, config, local)?.status).toBe(401);

    const snapshotExpiry = Date.now() + 10_000;
    const snapshot = signed(path, body);
    const snapshotDigest = desktopSnapshotBodyDigest(new TextEncoder().encode(body));
    snapshot.headers.set(nonceHeader, nonce);
    snapshot.headers.set(expiryHeader, String(snapshotExpiry));
    snapshot.headers.set(proofHeader, createLocalDesktopSnapshotCapability(secret, nonce, "POST", "/api/update/desktop-snapshot", pid, port, snapshotExpiry, snapshotDigest)!);
    expect(requireManagementAuth(snapshot, state, config, local)?.status).toBe(401);

    const switchProof = signed(path, body);
    for (const [method, target] of [
      ["GET", path], ["POST", "/api/update/desktop-snapshot"],
      ["PUT", "/api/codex-auth/accounts/alias"],
    ] as const) {
      const captured = new Request(`http://127.0.0.1:${port}${target}`, {
        method, headers: switchProof.headers, ...((method === "GET") ? {} : { body }),
      });
      expect(requireManagementAuth(captured, state, config, local)?.status).toBe(401);
    }
  });
});
