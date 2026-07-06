import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { debugDroppedFrame, debugProviderDiagnostic } from "../src/lib/debug";

describe("debug frame logging", () => {
  const previous = process.env.OCX_DEBUG_FRAMES;

  afterEach(() => {
    if (previous === undefined) delete process.env.OCX_DEBUG_FRAMES;
    else process.env.OCX_DEBUG_FRAMES = previous;
  });

  test("debugDroppedFrame redacts payload content", () => {
    process.env.OCX_DEBUG_FRAMES = "1";
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      debugDroppedFrame("openai-chat", "secret frame body bearer-token@example.test");
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("openai-chat");
      expect(line).toContain("payload redacted");
      expect(line).not.toContain("secret frame body");
      expect(line).not.toContain("bearer-token@example.test");
    } finally {
      error.mockRestore();
    }
  });

  test("debugDroppedFrame stays quiet unless explicitly enabled", () => {
    delete process.env.OCX_DEBUG_FRAMES;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      debugDroppedFrame("openai-chat", "secret frame body");
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("debugProviderDiagnostic stays quiet unless explicitly enabled", () => {
    delete process.env.OCX_DEBUG_FRAMES;
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      debugProviderDiagnostic("kiro", "request", { accessToken: "secret-token" });
      expect(error).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });

  test("debugProviderDiagnostic redacts structured secrets", () => {
    process.env.OCX_DEBUG_FRAMES = "1";
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      debugProviderDiagnostic("kiro", "request", {
        region: "us-east-1",
        authorization: "Bearer secret-debug-token",
        profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/demo",
      });
      expect(error).toHaveBeenCalledTimes(1);
      const line = String(error.mock.calls[0]?.[0] ?? "");
      expect(line).toContain("[ocx:kiro:request]");
      expect(line).toContain("us-east-1");
      expect(line).not.toContain("secret-debug-token");
      expect(line).not.toContain("arn:aws:codewhisperer");
      expect(line).toContain("[REDACTED]");
    } finally {
      error.mockRestore();
    }
  });
});
