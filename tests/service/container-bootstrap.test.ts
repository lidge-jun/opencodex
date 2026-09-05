import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import { readBoundedToken } from "../../docker/bootstrap-token";
import { repoPath } from "../helpers/repo-root";

function input(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("container token bootstrap", () => {
  test("accepts one trimmed token split across input chunks", async () => {
    await expect(readBoundedToken(input("  compose-", "token\n"))).resolves.toBe("compose-token");
  });

  test("accepts a maximum-size token followed by a shell newline", async () => {
    const token = "x".repeat(4096);
    await expect(readBoundedToken(input(token, "\n"))).resolves.toBe(token);
  });

  test("rejects empty, multiline, and oversized input", async () => {
    await expect(readBoundedToken(input(" \n"))).rejects.toThrow("token input is empty");
    await expect(readBoundedToken(input("first\nsecond\n"))).rejects.toThrow("exactly one line");
    await expect(readBoundedToken(input("first\n\n"))).rejects.toThrow("exactly one line");
    await expect(readBoundedToken(input("\nfirst\n"))).rejects.toThrow("exactly one line");
    await expect(readBoundedToken(input("x".repeat(4097), "\n"))).rejects.toThrow("exceeds 4096 bytes");
  });
});

describe("container deployment contract", () => {
  test("publishes only the data port with loopback and explicit bind overrides", () => {
    const compose = Bun.YAML.parse(readFileSync(repoPath("compose.yaml"), "utf8")) as {
      services: { hub: { ports: string[] } };
    };
    expect(compose.services.hub.ports).toEqual([
      "${OPENCODEX_BIND_ADDRESS:-127.0.0.1}:${OPENCODEX_PORT:-10100}:10100",
    ]);
  });

  test("requires the host-generated manifest in the runtime image", () => {
    const ignored = readFileSync(repoPath(".dockerignore"), "utf8").split(/\r?\n/);
    expect(ignored[0]).toBe("**");
    expect(ignored).toContain("!src/generated/compatibility-version.json");
    expect(ignored).not.toContain("src/generated/compatibility-version.json");
    expect(ignored.some(line => /^!\/?\.git(?:\/|$)/.test(line))).toBe(false);

    const dockerfile = readFileSync(repoPath("Dockerfile"), "utf8");
    const runtime = dockerfile.split(" AS runtime")[1];
    expect(runtime).toContain("COPY --chown=bun:bun src/generated/compatibility-version.json ./src/generated/compatibility-version.json");
    expect(runtime).toContain("readOpenCodexCompatibilityVersion() ?? ''");
    expect(runtime).toContain("throw new Error('Missing or invalid generated compatibility manifest')");
  });
});
