import { describe, expect, test } from "bun:test";
import { checkHeadroomStatus, compressWithHeadroom } from "../../src/optimize";
import type { OcxParsedRequest } from "../../src/types/request";

describe("Headroom proxy compression client", () => {
  test("fails open gracefully when Headroom server is unreachable", async () => {
    const status = await checkHeadroomStatus("http://127.0.0.1:54321", 100);
    expect(status.reachable).toBe(false);
    expect(status.url).toBe("http://127.0.0.1:54321");
  });

  test("fails open without modifying parsed request when proxy errors or is disabled", async () => {
    const parsed: OcxParsedRequest = {
      modelId: "gpt-5.5",
      stream: false,
      options: {},
      context: {
        messages: [{ role: "user", content: "Original prompt", timestamp: Date.now() }],
      },
    };

    // Disabled case
    const disabledResult = await compressWithHeadroom(parsed, { enabled: false });
    expect(disabledResult).toBeNull();
    expect(parsed.context.messages[0]!.content).toBe("Original prompt");

    // Unreachable proxy case (fail open)
    const errorResult = await compressWithHeadroom(parsed, {
      enabled: true,
      url: "http://127.0.0.1:54321",
      timeoutMs: 50,
    });
    expect(errorResult).toBeNull();
    expect(parsed.context.messages[0]!.content).toBe("Original prompt");
  });
});
