import { describe, expect, test } from "bun:test";
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
});
