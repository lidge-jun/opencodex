import { afterEach, beforeEach, expect, test } from "bun:test";
import { startServer } from "../../src/server";
import {
  LOCAL_ATTESTATION_PROOF_HEADER,
  verifyLocalAttestationProof,
} from "../../src/lib/local-management-attestation";
import {
  LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_HEADER,
  LOCAL_MANAGEMENT_CAPABILITY_TTL_MS,
  LOCAL_MANAGEMENT_EXPECTED_PID_HEADER,
  LOCAL_MANAGEMENT_NONCE_HEADER,
  LOCAL_MANAGEMENT_READ_PATHS,
  createLocalManagementReadCapability,
} from "../../src/lib/local-management-capability";
import { createTempHome, type TempHome } from "../helpers/temp-home";

/**
 * A local read capability authenticates the request to the server. The answer is only worth
 * trusting (for example as `ocx status`'s startup verdict, #5977) when it carries the server's
 * attestation over the same single-use nonce.
 */
let home: TempHome;
beforeEach(() => { home = createTempHome("ocx-local-read-proof-"); });
afterEach(() => { home.remove(); });

test("a local-read response carries the server's proof over the request nonce", async () => {
  const secret = "A".repeat(43);
  const nonce = "B".repeat(43);
  const server = startServer(0, {
    localAttestationSecret: secret,
    managementAuthState: { available: false, reason: "injected unavailable state" },
  });
  try {
    const path = LOCAL_MANAGEMENT_READ_PATHS.systemMemory;
    const expiresAt = Date.now() + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS;
    const response = await fetch(new URL(path, server.url), { headers: {
      [LOCAL_MANAGEMENT_EXPECTED_PID_HEADER]: String(process.pid),
      [LOCAL_MANAGEMENT_NONCE_HEADER]: nonce,
      [LOCAL_MANAGEMENT_CAPABILITY_EXPIRES_AT_HEADER]: String(expiresAt),
      [LOCAL_MANAGEMENT_CAPABILITY_HEADER]: createLocalManagementReadCapability(
        secret, nonce, "GET", path, process.pid, server.port!, expiresAt,
      )!,
    } });
    expect(response.status).toBe(200);
    const proof = response.headers.get(LOCAL_ATTESTATION_PROOF_HEADER);
    expect(verifyLocalAttestationProof(secret, nonce, process.pid, server.port!, proof)).toBe(true);
    expect(verifyLocalAttestationProof(secret, "C".repeat(43), process.pid, server.port!, proof)).toBe(false);
    await response.text();

    // Without the capability there is no read, so nothing is signed.
    const refused = await fetch(new URL(path, server.url));
    expect(refused.headers.get(LOCAL_ATTESTATION_PROOF_HEADER)).toBeNull();
    await refused.text();
  } finally {
    await server.stop(true);
  }
});
