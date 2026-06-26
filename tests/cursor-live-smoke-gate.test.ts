import { describe, expect, test } from "bun:test";
import {
  CURSOR_LIVE_SMOKE_DEFAULT_BASE_URL,
  CURSOR_LIVE_SMOKE_TOKEN_ENV,
  cursorLiveSmokeSkipMessage,
  getCursorLiveSmokeToken,
  readCursorLiveSmokeGate,
} from "../src/adapters/cursor/live-smoke-gate";

const fakeSecret = "secret-cursor-token-123";

describe("Cursor live smoke credential gate", () => {
  test("absent token disables live smoke with a clear skip reason", () => {
    const gate = readCursorLiveSmokeGate({});

    expect(gate).toEqual({
      enabled: false,
      envName: CURSOR_LIVE_SMOKE_TOKEN_ENV,
      baseUrl: CURSOR_LIVE_SMOKE_DEFAULT_BASE_URL,
      skipReason: `${CURSOR_LIVE_SMOKE_TOKEN_ENV} is not set; live Cursor smoke is skipped.`,
    });
    expect(cursorLiveSmokeSkipMessage(gate)).toContain(CURSOR_LIVE_SMOKE_TOKEN_ENV);
  });

  test("present token enables the gate without storing the token in the gate object", () => {
    const gate = readCursorLiveSmokeGate({
      OPENCODEX_CURSOR_TEST_TOKEN: fakeSecret,
      OPENCODEX_CURSOR_TEST_BASE_URL: "https://cursor.example.test",
    });

    expect(gate).toEqual({
      enabled: true,
      envName: CURSOR_LIVE_SMOKE_TOKEN_ENV,
      baseUrl: "https://cursor.example.test",
    });
    expect(JSON.stringify(gate)).not.toContain(fakeSecret);
  });

  test("token accessor is separate from the public gate status", () => {
    expect(getCursorLiveSmokeToken({ OPENCODEX_CURSOR_TEST_TOKEN: ` ${fakeSecret} ` })).toBe(fakeSecret);
    expect(getCursorLiveSmokeToken({ OPENCODEX_CURSOR_TEST_TOKEN: "   " })).toBeUndefined();
  });

  test("skip messages never include token values", () => {
    const gate = readCursorLiveSmokeGate({ OPENCODEX_CURSOR_TEST_TOKEN: fakeSecret });

    expect(cursorLiveSmokeSkipMessage(gate)).not.toContain(fakeSecret);
  });

  test("current process environment has an explicit gate state", () => {
    const gate = readCursorLiveSmokeGate();
    const token = getCursorLiveSmokeToken();

    if (token) {
      expect(gate.enabled).toBe(true);
      expect(JSON.stringify(gate)).not.toContain(token);
    } else {
      expect(gate).toMatchObject({
        enabled: false,
        envName: CURSOR_LIVE_SMOKE_TOKEN_ENV,
      });
      expect(gate.skipReason).toContain(CURSOR_LIVE_SMOKE_TOKEN_ENV);
    }
  });
});
