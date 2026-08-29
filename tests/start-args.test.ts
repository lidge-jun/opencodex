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

  test("--socks5-off clears a saved SOCKS5 proxy", () => {
    expect(parseStartOptions(["--socks5-off"])).toEqual({ socks5Off: true });
  });

  test("rejects conflicting SOCKS5 flags in either order", () => {
    expect(() => parseStartOptions(["--socks5", "--socks5-off"])).toThrow("cannot be used together");
    expect(() => parseStartOptions(["--socks5-off", "--socks5"])).toThrow("cannot be used together");
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

  test("rejects SOCKS4 URLs", () => {
    expect(() => normalizeSocks5("socks4://127.0.0.1:1080")).toThrow("Only SOCKS5");
    expect(() => normalizeSocks5("socks4a://127.0.0.1:1080")).toThrow("Only SOCKS5");
  });

  test("rejects SOCKS5 URLs without a valid host and port", () => {
    expect(() => normalizeSocks5("socks5://")).toThrow("Invalid SOCKS5 address");
    expect(() => normalizeSocks5("socks5://127.0.0.1:0")).toThrow("Invalid SOCKS5 address");
  });
});
