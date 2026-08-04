import { afterEach, describe, expect, test } from "bun:test";
import { captureClaudeInbound, claudeInboundDebugMetrics, clearClaudeInboundDebug, evictOldestClaudeInboundForBudget, getClaudeInboundDebugEntries } from "../src/claude/inbound-debug";
import { resetDebugSettingsForTests, setDebugSettings } from "../src/lib/debug-settings";

afterEach(() => {
  resetDebugSettingsForTests();
  clearClaudeInboundDebug();
});

const body = {
  model: "claude-opus-4-8-ncb",
  stream: true,
  max_tokens: 4096,
  system: "You are Claude.",
  thinking: { type: "adaptive" },
  output_config: { effort: "max" },
  metadata: { user_id: "session-uuid-1" },
  messages: [{ role: "user", content: "top secret prompt text" }],
};

describe("claude inbound debug capture (devlog 130 B1)", () => {
  test("Claude inbound metadata key 65 and aggregate row overflow are visibly capped and wp5 hooks account exact bytes", () => {
    setDebugSettings({ claude: true });
    const metadata = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`${index}-${"한".repeat(3000)}`, true]));
    captureClaudeInbound("messages", { ...body, metadata }, "x".repeat(20_000), "y".repeat(20_000));
    const [entry] = getClaudeInboundDebugEntries();
    expect(entry?.rowTruncated).toBe(true);
    expect(entry?.metadataKeysDropped).toBeGreaterThanOrEqual(1);
    expect(Buffer.byteLength(JSON.stringify(entry))).toBeLessThanOrEqual(32 * 1024);
    const before = claudeInboundDebugMetrics();
    expect(before.bytes).toBe(Buffer.byteLength(JSON.stringify(entry)));
    expect(evictOldestClaudeInboundForBudget()).toBe(before.bytes);
    expect(claudeInboundDebugMetrics()).toMatchObject({ entries: 0, bytes: 0 });
  });
  test("OFF (default): captures nothing", () => {
    captureClaudeInbound("messages", body);
    expect(getClaudeInboundDebugEntries()).toHaveLength(0);
  });

  test("ON: records allowlist scalars for messages and count_tokens, never prompt text", () => {
    setDebugSettings({ claude: true });
    captureClaudeInbound("messages", body, "cursor/gpt-5.6-luna");
    captureClaudeInbound("count_tokens", body);
    const entries = getClaudeInboundDebugEntries();
    expect(entries).toHaveLength(2);
    const messagesEntry = entries.find(e => e.endpoint === "messages")!;
    expect(messagesEntry.model).toBe("claude-opus-4-8-ncb");
    expect(messagesEntry.resolvedModel).toBe("cursor/gpt-5.6-luna");
    expect(messagesEntry.thinkingType).toBe("adaptive");
    expect(messagesEntry.outputConfigEffort).toBe("max");
    expect(messagesEntry.hasMetadataUserId).toBe(true);
    expect(messagesEntry.hasSystem).toBe(true);
    expect(messagesEntry.metadataKeys).toEqual(["user_id"]);
    // Privacy: raw values never stored — only 8-char ephemeral tags.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("top secret");
    expect(serialized).not.toContain("You are Claude.");
    expect(serialized).not.toContain("session-uuid-1");
    expect(messagesEntry.userIdTag).toMatch(/^[0-9a-f]{8}$/);
    expect(messagesEntry.systemTag).toMatch(/^[0-9a-f]{8}$/);
  });

  test("equality tags: same input → same tag, different input → different tag", () => {
    setDebugSettings({ claude: true });
    captureClaudeInbound("messages", body);
    captureClaudeInbound("messages", body);
    captureClaudeInbound("messages", { ...body, metadata: { user_id: "session-uuid-2" } });
    const [c, b2, a] = getClaudeInboundDebugEntries(); // newest first
    expect(a!.userIdTag).toBe(b2!.userIdTag as string);
    expect(c!.userIdTag).not.toBe(a!.userIdTag as string);
  });

  test("turning the flag off flushes the ring on the next capture attempt", () => {
    setDebugSettings({ claude: true });
    captureClaudeInbound("messages", body);
    expect(getClaudeInboundDebugEntries()).toHaveLength(1);
    setDebugSettings({ claude: false });
    captureClaudeInbound("messages", body);
    expect(getClaudeInboundDebugEntries()).toHaveLength(0);
  });

  test("budget_tokens wire is captured when present", () => {
    setDebugSettings({ claude: true });
    captureClaudeInbound("messages", { ...body, thinking: { type: "enabled", budget_tokens: 10000 }, output_config: undefined });
    const [entry] = getClaudeInboundDebugEntries();
    expect(entry!.thinkingType).toBe("enabled");
    expect(entry!.thinkingBudgetTokens).toBe(10000);
    expect(entry!.outputConfigEffort).toBeUndefined();
  });

  test("anthropic-beta header is captured verbatim (context-1m / effort betas)", () => {
    setDebugSettings({ claude: true });
    captureClaudeInbound("messages", body, undefined, "context-1m-2025-08-07,effort-2025-11-24");
    const [entry] = getClaudeInboundDebugEntries();
    expect(entry!.anthropicBeta).toBe("context-1m-2025-08-07,effort-2025-11-24");
  });

  test("same-millisecond captures get unique monotonic ids", () => {
    setDebugSettings({ claude: true });
    const now = Date.now();
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      captureClaudeInbound("messages", body);
      captureClaudeInbound("messages", body);
      captureClaudeInbound("messages", body);
    } finally {
      Date.now = originalNow;
    }
    const entries = getClaudeInboundDebugEntries();
    expect(entries).toHaveLength(3);
    expect(entries.every(e => e.at === now)).toBe(true);
    const ids = entries.map(e => e.id);
    expect(new Set(ids).size).toBe(3);
    // Newest-first snapshot; ids remain monotonic in capture order.
    expect(ids[0]!).toBeGreaterThan(ids[1]!);
    expect(ids[1]!).toBeGreaterThan(ids[2]!);
  });

  test("ids stay unique and ordered after the ring buffer wraps", () => {
    setDebugSettings({ claude: true });
    const now = Date.now();
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      // RING_LIMIT is 20; overflow it so eviction is exercised rather than simple appends.
      for (let i = 0; i < 25; i++) captureClaudeInbound("messages", body);
    } finally {
      Date.now = originalNow;
    }

    const entries = getClaudeInboundDebugEntries();
    expect(entries).toHaveLength(20);

    const ids = entries.map(e => e.id);
    // Eviction must not recycle ids: a counter reset would resurrect a discarded id and
    // reintroduce the duplicate-key collision this field exists to prevent.
    expect(new Set(ids).size).toBe(20);
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i - 1]!).toBeGreaterThan(ids[i]!);
    }
  });
});
