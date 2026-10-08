import { describe, expect, test } from "bun:test";
import { createPrivateKey } from "node:crypto";
import {
  canonicalMirasimSignaturePayload,
  sealMirasimRelayMetadata,
  signMirasimRequest,
} from "../../src/adapters/mirasim/crypto";

const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function ed25519PemFromSeed(seed: Uint8Array): string {
  const key = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, Buffer.from(seed)]),
    type: "pkcs8",
    format: "der",
  });
  return key.export({ type: "pkcs8", format: "pem" }).toString();
}

describe("Mirasim protocol crypto", () => {
  test("mrs-sig-v2 matches the Mirasim crypto-core golden vector", () => {
    const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
    const metadata = {
      "x-mirasim-session": "mirasim_00000000-0000-4000-8000-000000000000",
      "x-mirasim-agent": "claude",
      "x-mirasim-call": "11111111-2222-4333-8444-555555555555",
    };
    const body = Buffer.from('{"model":"claude-sonnet-5","messages":[]}', "utf8");
    const base = {
      method: "POST",
      path: "/v1/messages",
      timestamp: "1788200000123",
      nonce: "AAECAwQFBgcICQoL",
      deviceId: "device-fixed",
      clientVersion: "0.0.260",
      credential: "ticket-fixed",
      metadata,
      body,
    };

    const expectedCanonical = [
      "mrs-sig-v2",
      "POST",
      "/v1/messages",
      "1788200000123",
      "AAECAwQFBgcICQoL",
      "device-fixed",
      "0.0.260",
      "66ee005427e4f3b74ce4830f104c989613f0968f97036191a6fbaea245040170",
      "91bcb885e5b045a9f55f270bb0c6d633930407b6cca792839034702ed233be6b",
      "9df27ddbfc24ebaafa990cd41a7744f56c875d0dadf69e4941edc7e728aea6bd",
    ].join("\n");

    expect(canonicalMirasimSignaturePayload(base)).toBe(expectedCanonical);

    const signed = signMirasimRequest({
      ...base,
      privateKeyPem: ed25519PemFromSeed(seed),
    });
    expect(signed.canonicalPayload).toBe(expectedCanonical);
    expect(signed.signature).toBe(
      "zUYTEKW17Gzn7TEdEzWZ2aEOpO4oW9YFFpdsyzJaUyS4A_byq3DUNYzNOL96D24MExQ0mVbot75TkvkJw3vVAQ",
    );
  });

  test("empty metadata contributes a blank canonical line", () => {
    const payload = canonicalMirasimSignaturePayload({
      method: "GET",
      path: "/v1/models",
      timestamp: "1",
      nonce: "nonce",
      deviceId: "device",
      clientVersion: "0.0.260",
      credential: "ticket",
      body: new Uint8Array(),
    });
    const lines = payload.split("\n");
    expect(lines).toHaveLength(10);
    expect(lines[8]).toBe("");
  });

  test("mrs-seal-v1 matches the Mirasim crypto-core golden vector", () => {
    const plaintext = {
      "x-mirasim-agent": "claude",
      "x-mirasim-call": "11111111-2222-4333-8444-555555555555",
      "x-mirasim-device": "device-fixed",
      "x-mirasim-nonce": "AAECAwQFBgcICQoL",
      "x-mirasim-session": "mirasim_00000000-0000-4000-8000-000000000000",
      "x-mirasim-sig": "zUYTEKW17Gzn7TEdEzWZ2aEOpO4oW9YFFpdsyzJaUyS4A_byq3DUNYzNOL96D24MExQ0mVbot75TkvkJw3vVAQ",
      "x-mirasim-ts": "1788200000123",
    };
    const sealed = sealMirasimRelayMetadata(plaintext, "POST", "/v1/messages", {
      recipientPublicKeyBase64: "NYBy1jZYgNGu6jKa35EhODhR7SGijjt16WXQ0s0WYlQ=",
      ephemeralSecret: Buffer.from(
        "404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f",
        "hex",
      ),
      nonce: Buffer.from("a0a1a2a3a4a5a6a7a8a9aaab", "hex"),
    });

    expect(sealed).toBe(
      "eaYx7t4b-cmPEgMs3q3Q56B5OY_HhriMyEbsia-FpRqgoaKjpKWmp6ipqqtWlxgybxeoS1fVDaS5_1az3V-kX_XGGNPghY8g8q81tF8LkfDoIwY8W2FWXoe5_27zjH9q2jM05ZuvNfmdYnjW0x616SP-p3g96-PvzI8GDuAbPgt9-0sIkQHeCCZ35opOpopxt_tdTp55bPp8CmjCpb1OR0aWs_5UezjAlVNibbN4979hGY_BcQ7z07Bkt92DCgJiP9aP8pLSXM1gcFHvnDDAiAqfqqA1cWx2f3EIHn585U-tdtQsRZ5BJ7wJ4sZgMswGl5CxDgSFJ-MhnsQsyj6zAR_MVujCO4jUkLVsRtI38N6sN-T79EWL4w4N1ksEfzIUJDtYDNfbr83XkXpl3sB6DvYIrrrPi5Gq96WSWldJf5Pgz0IdJq_O36wS2dNYVqQmsOU-nwgigBh0NrD94K23PthUn8qbkULkp7PgyPGDXN-4MkvdjN8LVN-oEP1oaP5FMVbiH6b_7K_9NaXvJCELj59p2P_fCnJ2ULHCpwyfDGOKjg",
    );
  });
});
