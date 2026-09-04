import { describe, expect, test } from "bun:test";

import { readBoundedToken } from "../docker/bootstrap-token";

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
