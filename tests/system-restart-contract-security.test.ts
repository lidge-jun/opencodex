import { describe, expect, test } from "bun:test";
import {
  SYSTEM_RESTART_METHOD,
  SYSTEM_RESTART_PATH,
  createSystemRestartCapability,
  verifySystemRestartCapability,
} from "../src/lib/system-restart-contract";

const SECRET = "A".repeat(43);
const NONCE = "B".repeat(43);
const PID = 4242;
const PORT = 10100;

function capability(): string {
  const value = createSystemRestartCapability(
    SECRET,
    NONCE,
    SYSTEM_RESTART_METHOD,
    SYSTEM_RESTART_PATH,
    PID,
    PORT,
  );
  if (!value) throw new Error("test capability could not be created");
  return value;
}

describe("system restart capability security boundary", () => {
  test("rejects a capability when the expected runtime pid is stale", () => {
    expect(verifySystemRestartCapability(
      SECRET,
      NONCE,
      SYSTEM_RESTART_METHOD,
      SYSTEM_RESTART_PATH,
      PID + 1,
      PORT,
      capability(),
    )).toBe(false);
  });

  test("rejects a capability when the nonce is mutated", () => {
    const mutatedNonce = `${NONCE.slice(0, -1)}C`;
    expect(verifySystemRestartCapability(
      SECRET,
      mutatedNonce,
      SYSTEM_RESTART_METHOD,
      SYSTEM_RESTART_PATH,
      PID,
      PORT,
      capability(),
    )).toBe(false);
  });

  test("rejects cross-operation and cross-listener reuse", () => {
    const signed = capability();
    expect(verifySystemRestartCapability(
      SECRET,
      NONCE,
      "DELETE",
      SYSTEM_RESTART_PATH,
      PID,
      PORT,
      signed,
    )).toBe(false);
    expect(verifySystemRestartCapability(
      SECRET,
      NONCE,
      SYSTEM_RESTART_METHOD,
      "/api/config",
      PID,
      PORT,
      signed,
    )).toBe(false);
    expect(verifySystemRestartCapability(
      SECRET,
      NONCE,
      SYSTEM_RESTART_METHOD,
      SYSTEM_RESTART_PATH,
      PID,
      PORT + 1,
      signed,
    )).toBe(false);
  });
});
