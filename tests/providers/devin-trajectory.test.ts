import { describe, expect, test } from "bun:test";
import { claimDevinTrajectory } from "../../src/adapters/devin/trajectory";

describe("bounded Devin trajectory claims", () => {
  const host = "https://server.codeium.com";
  const namespace = () => crypto.randomUUID();

  test("unnamed claims leave allocation to the wire", () => {
    for (const name of [undefined, null, ""]) {
      const claim = claimDevinTrajectory("fixture", host, name);
      expect(claim.trajectoryId).toBeUndefined();
      claim.release();
      claim.release();
    }
  });

  test("credential, host and conversation each separate sequential claims", () => {
    const name = namespace();
    const ids = [["a", host, name], ["b", host, name], ["a", "https://server.eu.windsurf.com", name], ["a", host, name + "-other"]]
      .map(([key, destination, conversation]) => {
        const claim = claimDevinTrajectory(key!, destination!, conversation);
        claim.release();
        return claim.trajectoryId;
      });
    expect(new Set(ids).size).toBe(4);
    const repeat = claimDevinTrajectory("a", host, name);
    expect(repeat.trajectoryId).toBe(ids[0]);
    repeat.release();
  });

  test("structured framing prevents host/conversation delimiter collisions", () => {
    const name = namespace();
    const a = claimDevinTrajectory("fixture", host + "\x1f" + name, "suffix");
    a.release();
    const b = claimDevinTrajectory("fixture", host, name + "\x1fsuffix");
    try { expect(b.trajectoryId).not.toBe(a.trajectoryId); } finally { b.release(); }
  });

  test("three overlapping claims are distinct and cannot release the retained owner", () => {
    const name = namespace();
    const owner = claimDevinTrajectory("fixture", host, name);
    const second = claimDevinTrajectory("fixture", host, name);
    const third = claimDevinTrajectory("fixture", host, name);
    try {
      expect(new Set([owner.trajectoryId, second.trajectoryId, third.trajectoryId]).size).toBe(3);
      second.release();
      third.release();
      const fourth = claimDevinTrajectory("fixture", host, name);
      expect(fourth.trajectoryId).not.toBe(owner.trajectoryId);
      fourth.release();
    } finally { owner.release(); second.release(); third.release(); }
    const later = claimDevinTrajectory("fixture", host, name);
    try { expect(later.trajectoryId).toBe(owner.trajectoryId); } finally { later.release(); }
  });

  test("an old release cannot deactivate a reacquired entry", () => {
    const name = namespace();
    const first = claimDevinTrajectory("fixture", host, name);
    first.release();
    const next = claimDevinTrajectory("fixture", host, name);
    try {
      first.release();
      const overlap = claimDevinTrajectory("fixture", host, name);
      expect(overlap.trajectoryId).not.toBe(next.trajectoryId);
      overlap.release();
    } finally { next.release(); }
  });

  test("256 inactive entries evict the oldest while reacquisition refreshes recency", () => {
    const prefix = namespace();
    const ids = Array.from({ length: 256 }, (_, i) => {
      const claim = claimDevinTrajectory("fixture", host, `${prefix}-${i}`);
      claim.release();
      return claim.trajectoryId;
    });
    const refreshed = claimDevinTrajectory("fixture", host, `${prefix}-0`);
    expect(refreshed.trajectoryId).toBe(ids[0]);
    refreshed.release();
    const inserted = claimDevinTrajectory("fixture", host, `${prefix}-256`);
    inserted.release();
    const retained = claimDevinTrajectory("fixture", host, `${prefix}-0`);
    expect(retained.trajectoryId).toBe(ids[0]);
    retained.release();
    const evicted = claimDevinTrajectory("fixture", host, `${prefix}-1`);
    expect(evicted.trajectoryId).not.toBe(ids[1]);
    evicted.release();
  });

  test("inactive churn never evicts an active record", () => {
    const prefix = namespace();
    const owner = claimDevinTrajectory("fixture", host, prefix);
    try {
      for (let i = 0; i < 300; i++) claimDevinTrajectory("fixture", host, `${prefix}-${i}`).release();
      const overlap = claimDevinTrajectory("fixture", host, prefix);
      expect(overlap.trajectoryId).not.toBe(owner.trajectoryId);
      overlap.release();
    } finally { owner.release(); }
    const later = claimDevinTrajectory("fixture", host, prefix);
    expect(later.trajectoryId).toBe(owner.trajectoryId);
    later.release();
  });

  test("256 active entries protect capacity and overflow is fresh and unretained", () => {
    const prefix = namespace();
    const owners = Array.from({ length: 256 }, (_, i) => claimDevinTrajectory("fixture", host, `${prefix}-${i}`));
    try {
      expect(new Set(owners.map(claim => claim.trajectoryId)).size).toBe(256);
      const overflow = claimDevinTrajectory("fixture", host, `${prefix}-overflow`);
      overflow.release();
      const repeat = claimDevinTrajectory("fixture", host, `${prefix}-overflow`);
      expect(repeat.trajectoryId).not.toBe(overflow.trajectoryId);
      repeat.release();
      owners[0]!.release();
      const original = claimDevinTrajectory("fixture", host, `${prefix}-0`);
      expect(original.trajectoryId).toBe(owners[0]!.trajectoryId);
      original.release();
      const inserted = claimDevinTrajectory("fixture", host, `${prefix}-overflow`);
      expect(inserted.trajectoryId).not.toBe(repeat.trajectoryId);
      inserted.release();
      const insertedAgain = claimDevinTrajectory("fixture", host, `${prefix}-overflow`);
      expect(insertedAgain.trajectoryId).toBe(inserted.trajectoryId);
      insertedAgain.release();
      // Every remaining owner survived overflow; no active entry was displaced.
      owners.slice(1).forEach((owner, i) => {
        owner.release();
        const later = claimDevinTrajectory("fixture", host, `${prefix}-${i + 1}`);
        expect(later.trajectoryId).toBe(owner.trajectoryId);
        later.release();
      });
    } finally { owners.forEach(claim => claim.release()); }
  });
});
