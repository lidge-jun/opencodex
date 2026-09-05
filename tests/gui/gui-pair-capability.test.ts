import { describe, expect, test } from "bun:test";
import {
  GUI_PAIR_CAPABILITY_TTL_MS,
  GUI_PAIR_METHOD,
  GUI_PAIR_PATH,
  createGuiPairCapability,
  verifyGuiPairCapability,
} from "../../src/lib/gui-pair-capability";

const SECRET = "A".repeat(43);
const NONCE = "B".repeat(43);
const ORIGIN = "https://dashboard.example.test";
const PID = 4242;
const PORT = 10100;
const NOW = 1_800_000_000_000;
const EXPIRES_AT = NOW + GUI_PAIR_CAPABILITY_TTL_MS;

function capability(): string {
  const value = createGuiPairCapability(
    SECRET,
    NONCE,
    GUI_PAIR_METHOD,
    GUI_PAIR_PATH,
    ORIGIN,
    PID,
    PORT,
    EXPIRES_AT,
  );
  if (!value) throw new Error("test GUI pair capability could not be created");
  return value;
}

describe("GUI pairing operation capability", () => {
  test("authenticates the exact method path browser origin process and listener", () => {
    expect(verifyGuiPairCapability(
      SECRET, NONCE, GUI_PAIR_METHOD, GUI_PAIR_PATH, ORIGIN, PID, PORT, EXPIRES_AT, capability(), NOW,
    )).toBe(true);
    for (const changed of [
      ["DELETE", GUI_PAIR_PATH, ORIGIN, PID, PORT],
      [GUI_PAIR_METHOD, "/api/config", ORIGIN, PID, PORT],
      [GUI_PAIR_METHOD, GUI_PAIR_PATH, "https://evil.example.test", PID, PORT],
      [GUI_PAIR_METHOD, GUI_PAIR_PATH, ORIGIN, PID + 1, PORT],
      [GUI_PAIR_METHOD, GUI_PAIR_PATH, ORIGIN, PID, PORT + 1],
    ] as const) {
      expect(verifyGuiPairCapability(
        SECRET, NONCE, changed[0], changed[1], changed[2], changed[3], changed[4], EXPIRES_AT, capability(), NOW,
      )).toBe(false);
    }
  });

  test("rejects malformed nonce expiry origin and same-length signature mismatches", () => {
    const mismatched = `${capability().slice(0, -1)}${capability().endsWith("C") ? "D" : "C"}`;
    expect(verifyGuiPairCapability(
      SECRET, "short", GUI_PAIR_METHOD, GUI_PAIR_PATH, ORIGIN, PID, PORT, EXPIRES_AT, capability(), NOW,
    )).toBe(false);
    expect(verifyGuiPairCapability(
      SECRET, NONCE, GUI_PAIR_METHOD, GUI_PAIR_PATH, "https://dashboard.example.test/path", PID, PORT, EXPIRES_AT, capability(), NOW,
    )).toBe(false);
    expect(verifyGuiPairCapability(
      SECRET, NONCE, GUI_PAIR_METHOD, GUI_PAIR_PATH, ORIGIN, PID, PORT, NOW, capability(), NOW,
    )).toBe(false);
    expect(verifyGuiPairCapability(
      SECRET, NONCE, GUI_PAIR_METHOD, GUI_PAIR_PATH, ORIGIN, PID, PORT, EXPIRES_AT, mismatched, NOW,
    )).toBe(false);
  });
});
