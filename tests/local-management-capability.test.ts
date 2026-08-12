import { describe, expect, test } from "bun:test";
import {
  LOCAL_MANAGEMENT_CAPABILITY_TTL_MS,
  LOCAL_MANAGEMENT_READ_PATHS,
  createLocalManagementReadCapability,
  verifyLocalManagementReadCapability,
} from "../src/lib/local-management-capability";
import {
  SYSTEM_RESTART_METHOD,
  SYSTEM_RESTART_PATH,
  createSystemRestartCapability,
  verifySystemRestartCapability,
} from "../src/lib/system-restart-contract";

describe("local management read capability", () => {
  const secret = "A".repeat(43);
  const nonce = "B".repeat(43);
  const pid = 4242;
  const port = 10100;
  const now = 1_800_000_000_000;
  const expiresAt = now + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS;

  test("binds one allowlisted GET to its nonce, path, PID, and port", () => {
    const capability = createLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      expiresAt,
    );
    expect(capability).toHaveLength(43);
    expect(verifyLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      expiresAt,
      capability,
      now,
    )).toBe(true);

    const invalid: Array<[string, string, number, number, string | null]> = [
      ["POST", LOCAL_MANAGEMENT_READ_PATHS.systemMemory, pid, port, capability],
      ["GET", LOCAL_MANAGEMENT_READ_PATHS.codexAccounts, pid, port, capability],
      ["GET", LOCAL_MANAGEMENT_READ_PATHS.systemMemory, pid + 1, port, capability],
      ["GET", LOCAL_MANAGEMENT_READ_PATHS.systemMemory, pid, port + 1, capability],
      ["GET", LOCAL_MANAGEMENT_READ_PATHS.systemMemory, pid, port, "C".repeat(43)],
    ];
    for (const [method, path, candidatePid, candidatePort, candidate] of invalid) {
      expect(verifyLocalManagementReadCapability(
        secret,
        nonce,
        method,
        path,
        candidatePid,
        candidatePort,
        expiresAt,
        candidate,
        now,
      )).toBe(false);
    }
    expect(verifyLocalManagementReadCapability(
      secret,
      "D".repeat(43),
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      expiresAt,
      capability,
      now,
    )).toBe(false);
    const expiredCapability = createLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      now,
    );
    expect(verifyLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      now,
      expiredCapability,
      now,
    )).toBe(false);
    const farFutureExpiry = now + LOCAL_MANAGEMENT_CAPABILITY_TTL_MS + 1;
    const farFutureCapability = createLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      farFutureExpiry,
    );
    expect(verifyLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      farFutureExpiry,
      farFutureCapability,
      now,
    )).toBe(false);
  });

  test("cannot cross the restart or other local-read capability domains", () => {
    const memoryCapability = createLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      expiresAt,
    );
    const restartCapability = createSystemRestartCapability(
      secret,
      nonce,
      SYSTEM_RESTART_METHOD,
      SYSTEM_RESTART_PATH,
      pid,
      port,
    );
    expect(verifySystemRestartCapability(
      secret,
      nonce,
      SYSTEM_RESTART_METHOD,
      SYSTEM_RESTART_PATH,
      pid,
      port,
      memoryCapability,
    )).toBe(false);
    expect(verifyLocalManagementReadCapability(
      secret,
      nonce,
      "GET",
      LOCAL_MANAGEMENT_READ_PATHS.systemMemory,
      pid,
      port,
      expiresAt,
      restartCapability,
      now,
    )).toBe(false);
  });
});
