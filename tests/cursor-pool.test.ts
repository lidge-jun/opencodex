import { describe, expect, test } from "bun:test";
import { CursorCredentialRouter, NoAvailableCursorCredentialError } from "../src/providers/cursor-pool";

describe("CursorCredentialRouter", () => {
  test("weighted round-robin distributes picks proportionally", () => {
    const router = new CursorCredentialRouter([
      { id: "a", weight: 3 },
      { id: "b", weight: 1 },
    ]);
    const picks: Record<string, number> = { a: 0, b: 0 };
    for (let i = 0; i < 40; i++) {
      const cred = router.pick();
      picks[cred.id] = (picks[cred.id] ?? 0) + 1;
    }
    // 3:1 ratio should be roughly 30:10
    expect(picks.a).toBeGreaterThan(picks.b * 2);
  });

  test("disable + cooldown excludes the credential", () => {
    const router = new CursorCredentialRouter([{ id: "a", weight: 1 }]);
    router.disable("a");
    expect(() => router.pick()).toThrow(NoAvailableCursorCredentialError);
  });

  test("failover picks a different credential when one is disabled", () => {
    const router = new CursorCredentialRouter([
      { id: "a", weight: 1 },
      { id: "b", weight: 1 },
    ]);
    router.disable("a");
    const cred = router.pick();
    expect(cred.id).toBe("b");
  });
});
