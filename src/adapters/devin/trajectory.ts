import { devinCacheIdentity } from "./cloud-direct/chat";

const TRAJECTORY_MAX = 256;
const trajectories = new Map<string, { id: string; active: boolean }>();

export interface DevinTrajectoryClaim {
  trajectoryId?: string;
  release(): void;
}

/** One process-local trajectory per named conversation, never shared by live turns. */
export function claimDevinTrajectory(
  apiKey: string,
  host: string,
  conversation: string | null | undefined,
): DevinTrajectoryClaim {
  if (!conversation) return { release() {} };
  // Structured framing separates host and conversation even if either contains a delimiter.
  // Only the fixed digest and UUID enter the retained map, never the token or conversation.
  const key = new Bun.CryptoHasher("sha256")
    .update(JSON.stringify([devinCacheIdentity(apiKey, host), conversation])).digest("hex");
  let entry = trajectories.get(key);
  if (entry?.active) return { trajectoryId: crypto.randomUUID(), release() {} };
  if (!entry) {
    if (trajectories.size >= TRAJECTORY_MAX) {
      const inactive = [...trajectories].find(([, candidate]) => !candidate.active);
      if (!inactive) return { trajectoryId: crypto.randomUUID(), release() {} };
      trajectories.delete(inactive[0]);
    }
    entry = { id: crypto.randomUUID(), active: true };
  }
  entry.active = true;
  trajectories.delete(key);
  trajectories.set(key, entry);
  const claimed = entry;
  let released = false;
  return {
    trajectoryId: claimed.id,
    release() {
      if (released) return;
      released = true;
      claimed.active = false;
    },
  };
}
