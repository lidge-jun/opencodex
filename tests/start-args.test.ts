import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SOCKS5_PROXY,
  START_USAGE,
  normalizeSocks5,
  parseStartOptions,
  StartArgsError,
} from "../src/cli/start-args";

describe("parseStartOptions", () => {
  test("accepts an empty start argv", () => {
    expect(parseStartOptions([])).toEqual({});
  });

  test("parses --port", () => {
    expect(parseStartOptions(["--port", "8080"])).toEqual({ port: 8080 });
  });

  test("defaults --socks5 to 127.0.0.1:10808", () => {
    expect(parseStartOptions(["--socks5"])).toEqual({ socks5: DEFAULT_SOCKS5_PROXY });
  });

  test("accepts host:port and port-only SOCKS5 values", () => {
    expect(parseStartOptions(["--socks5", "10.0.0.2:1080"])).toEqual({
      socks5: "socks5://10.0.0.2:1080",
    });
    expect(parseStartOptions(["--socks5", "1080"])).toEqual({
      socks5: "socks5://127.0.0.1:1080",
    });
    expect(parseStartOptions(["--socks5", "socks5://example.test:9050"])).toEqual({
      socks5: "socks5://example.test:9050",
    });
  });

  test("parses --port and --socks5 together", () => {
    expect(parseStartOptions(["--port", "10100", "--socks5"])).toEqual({
      port: 10100,
      socks5: DEFAULT_SOCKS5_PROXY,
    });
  });

  test("--socks5-off clears a saved outbound proxy", () => {
    expect(parseStartOptions(["--socks5-off"])).toEqual({ socks5: null });
  });

  test("rejects unknown flags with the start usage line", () => {
    expect(() => parseStartOptions(["--bad"])).toThrow(StartArgsError);
    try {
      parseStartOptions(["--bad"]);
    } catch (error) {
      expect(error).toBeInstanceOf(StartArgsError);
      expect((error as StartArgsError).message).toBe(START_USAGE);
    }
  });
});

describe("normalizeSocks5", () => {
  test("rejects HTTP URLs", () => {
    expect(() => normalizeSocks5("http://127.0.0.1:10808")).toThrow("not an HTTP URL");
  });
});
