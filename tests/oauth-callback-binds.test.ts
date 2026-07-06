import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loopbackBindHostnames } from "../src/oauth/callback-server";

describe("loopbackBindHostnames", () => {
  test("localhost redirect over IPv4 bind also binds ::1 (Windows resolves localhost to ::1 first)", () => {
    expect(loopbackBindHostnames("localhost", "127.0.0.1")).toEqual(["127.0.0.1", "::1"]);
    expect(loopbackBindHostnames("LOCALHOST", "127.0.0.1")).toEqual(["127.0.0.1", "::1"]);
  });

  test("explicit IPv4 redirect hosts keep a single IPv4 listener", () => {
    expect(loopbackBindHostnames("127.0.0.1", "127.0.0.1")).toEqual(["127.0.0.1"]);
  });

  test("non-default binds are never widened", () => {
    expect(loopbackBindHostnames("localhost", "::1")).toEqual(["::1"]);
    expect(loopbackBindHostnames("example.test", "0.0.0.0")).toEqual(["0.0.0.0"]);
  });

  test("an occupied IPv6 loopback abandons the whole port instead of leaving ::1 to a foreign listener", () => {
    // localhost may resolve to ::1 first — silently serving IPv4-only while another
    // process holds ::1:<port> would hand the OAuth callback (auth code) to that process.
    const source = readFileSync(join(import.meta.dir, "..", "src", "oauth", "callback-server.ts"), "utf8");
    expect(source).toContain('import { isAddrInUse } from "../server/ports";');
    const createServers = source.slice(source.indexOf("#createServers(port: number"), source.indexOf("#handleCallback(req: Request"));
    expect(createServers).toContain("if (isAddrInUse(err))");
    expect(createServers).toContain("server.stop(true)");
    expect(createServers).toContain("throw err");
  });
});
